const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const config = require('../config/config');
const storeConnectionService = require('../services/storeConnection.service');
const quoteBridge = require('../integrations/bridge/quoteBridge.service');
const orderBridge = require('../integrations/bridge/orderBridge.service');
const paymentBridge = require('../integrations/bridge/paymentBridge.service');
const { getAdapter } = require('../integrations/ecommerce');
const { getStripe } = require('../integrations/bridge/stripeClient');
const logger = require('../config/logger');

// Test-mode stores are simulated end to end through the marketplace API only.
const assertLiveConnection = (conn) => {
  if (conn && conn.livemode === false) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Test-mode stores can only be used with the /v1/marketplace API');
  }
};

const resolveConnection = async (platform, req) => {
  const connectionId =
    req.params.connectionId ||
    req.headers['x-cloudship-connection-id'] ||
    req.query.connectionId;
  if (connectionId) {
    const conn = await storeConnectionService.findById(connectionId);
    if (!conn || conn.platform !== platform || conn.status !== 'active') {
      throw new ApiError(httpStatus.NOT_FOUND, 'Store connection not found');
    }
    return conn;
  }

  if (platform === 'lovable') {
    const key = req.headers['x-cloudship-key'] || req.headers['x-api-key'];
    const conn = await storeConnectionService.findByPublicApiKey(key);
    if (!conn) throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid API key');
    return conn;
  }

  const shopDomain =
    req.headers['x-shopify-shop-domain'] ||
    req.headers['x-wc-webhook-source'] ||
    req.query.shop;
  if (shopDomain) {
    const conn = await storeConnectionService.findActiveByPlatformAndUrl(platform, shopDomain);
    if (conn) return conn;
  }

  throw new ApiError(
    httpStatus.BAD_REQUEST,
    'Pass connectionId in path/query or X-CloudShip-Connection-Id header'
  );
};

/**
 * Wix sends webhooks as a signed JWT (text/plain) with 3 levels of JSON nesting:
 * Level 1: JWT base64 decode → { data: "JSON string", iat, exp }
 * Level 2: parse → { data: "JSON string again" }
 * Level 3: parse → { id, slug, createdEvent: { entity: { ...order... } } }
 */
const decodeWixJwt = (rawBody) => {
  try {
    const token = typeof rawBody === 'string' ? rawBody.trim() : rawBody.toString('utf8').trim();
    if (!token.startsWith('eyJ')) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;

    // Level 1: decode JWT payload
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const level1 = JSON.parse(payloadJson);

    // Level 2: parse outer data string
    if (!level1.data) return null;
    const level2 = typeof level1.data === 'string' ? JSON.parse(level1.data) : level1.data;

    // Level 3: parse inner data string (this is the actual event object)
    const level3Raw = level2.data || level2;
    const level3 = typeof level3Raw === 'string' ? JSON.parse(level3Raw) : level3Raw;

    // Extract order entity from createdEvent
    const entity = level3.createdEvent && level3.createdEvent.entity;
    if (entity) {
      return { order: entity, eventType: level3.slug || 'created', rawData: level3 };
    }
    return level3;
  } catch (e) {
    return null;
  }
};

const handleOrderWebhook = (platform) =>
  catchAsync(async (req, res) => {
    const conn = await resolveConnection(platform, req);
    assertLiveConnection(conn);
    const source =
      req.headers['x-wc-webhook-source'] ||
      (platform === 'shopify' ? req.headers['x-shopify-shop-domain'] : null);
    if (source && !conn.storeUrl) {
      conn.storeUrl = String(source).replace(/\/$/, '');
      await conn.save();
    }
    const adapter = getAdapter(platform);
    adapter.verifyWebhook(conn, req);

    // Wix sends JWT text/plain body — decode it first
    let body = req.body;
    if (platform === 'wix') {
      const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : null);
      const decoded = rawBody ? decodeWixJwt(rawBody) : null;
      if (decoded) body = decoded;
    }

    // Ignore non-create topics softly
    const topic = String(
      req.headers['x-wc-webhook-topic'] ||
        req.headers['x-shopify-topic'] ||
        body.scope ||
        body.eventType ||
        body.event ||
        (body.rawData && body.rawData.slug) ||
        'order.created'
    ).toLowerCase();
    if (topic.includes('delete') || topic.includes('cancelled') || topic.includes('canceled')) {
      return res.status(httpStatus.OK).send({ ignored: true, reason: topic });
    }

    const normalized = await adapter.normalizeOrder(body, conn);
    if (!normalized || !normalized.externalOrderId) {
      return res.status(httpStatus.OK).send({ ok: true, message: 'CloudShip webhook listener active' });
    }
    let result;
    try {
      result = await orderBridge.ingestNormalizedOrder({
        storeConnection: conn,
        normalized,
        quoteId: body.quoteId || req.query.quoteId,
        partner: body.partner,
        service: body.service,
      });
    } catch (err) {
      logger.error(`Shop order ingest failed (${platform}): ${err.message}`);
      throw new ApiError(httpStatus.BAD_REQUEST, err.message || 'Could not save the shop order in CloudShip');
    }
    return res.status(result.duplicate ? httpStatus.OK : httpStatus.CREATED).send({
      duplicate: result.duplicate,
      bookingId: result.booking.id || result.booking._id,
      bookingCode: result.booking.code,
      payment: result.payment,
      paymentStatus: result.booking.paymentStatus,
    });
  });

const handleRates = (platform) =>
  catchAsync(async (req, res) => {
    const conn = await resolveConnection(platform, req);
    assertLiveConnection(conn);
    const adapter = getAdapter(platform);
    adapter.verifyWebhook(conn, req);

    const parsed = adapter.parseRateRequest(req.body, conn);
    if (!parsed.dropoff) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'destination address required for rates');
    }
    const quote = await quoteBridge.createMarketplaceQuote({
      pickup: parsed.pickup,
      dropoff: parsed.dropoff,
      weightKg: parsed.weightKg,
      currency: parsed.currency || (conn.settings && conn.settings.currency) || 'ZAR',
      mode: (conn.settings && conn.settings.defaultMode) || 'Road',
      storeConnection: conn,
      storeConnectionId: conn.id || conn._id,
      companyId: conn.company,
    });

    if (platform === 'shopify' && typeof adapter.formatShopifyRates === 'function') {
      return res.send(adapter.formatShopifyRates(quote));
    }
    if (platform === 'wix' && typeof adapter.formatWixRates === 'function') {
      return res.send(adapter.formatWixRates(quote));
    }
    if (platform === 'bigcommerce' && typeof adapter.formatBigCommerceRates === 'function') {
      return res.send(adapter.formatBigCommerceRates(quote));
    }
    return res.send(quote);
  });

const stripeWebhook = catchAsync(async (req, res) => {
  const secret = config.ecommerce.stripeWebhookSecret;
  if (!secret || !config.ecommerce.stripeSecretKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Stripe webhook is not configured');
  }
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, signature, secret);
  } catch (err) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid Stripe signature: ${err.message}`);
  }
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const booking = await paymentBridge.confirmPaymentAndBook(intent.id);
    await orderBridge.afterSuccessfulBook(booking);
  }
  res.send({ received: true });
});

module.exports = {
  wooOrder: handleOrderWebhook('woocommerce'),
  wooRates: handleRates('woocommerce'),
  shopifyOrder: handleOrderWebhook('shopify'),
  shopifyRates: handleRates('shopify'),
  wixOrder: handleOrderWebhook('wix'),
  wixRates: handleRates('wix'),
  lovableOrder: handleOrderWebhook('lovable'),
  lovableRates: handleRates('lovable'),
  bigcommerceOrder: handleOrderWebhook('bigcommerce'),
  bigcommerceRates: handleRates('bigcommerce'),
  stripeWebhook,
};
