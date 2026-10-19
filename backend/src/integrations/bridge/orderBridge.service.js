const crypto = require('crypto');
const httpStatus = require('http-status');
const { Booking, IntegrationEvent } = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const quoteBridge = require('./quoteBridge.service');
const paymentBridge = require('./paymentBridge.service');
const { getAdapter } = require('../ecommerce');
const { extractShopTotals } = require('../ecommerce/normalize');
const { generateTrackingToken } = require('../../utils/trackingToken');
const { displayShipmentStatus, displayShipmentLabel, progressTimeline } = require('../utils/shipmentProgress');

const TIMELINE_TEMPLATE = [
  { stage: 'booked', label: 'Booked' },
  { stage: 'warehouse', label: 'Warehouse' },
  { stage: 'in_transit', label: 'In Transit' },
  { stage: 'out_for_delivery', label: 'Out for Delivery' },
  { stage: 'delivered', label: 'Delivered' },
];

const generateBookingCode = async () => {
  for (let i = 0; i < 8; i += 1) {
    const code = `BKG-MKT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const exists = await Booking.exists({ code, livemode: { $in: [true, false] } });
    if (!exists) return code;
  }
  return `BKG-MKT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};

/**
 * Idempotent event claim. Returns { event, isDuplicate }.
 */
const claimEvent = async ({ platform, eventType, externalEventId, storeConnectionId, payload }) => {
  try {
    const event = await IntegrationEvent.create({
      platform,
      eventType,
      externalEventId: String(externalEventId),
      storeConnection: storeConnectionId || null,
      status: 'processing',
      attempts: 1,
      payload: payload || {},
    });
    return { event, isDuplicate: false };
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await IntegrationEvent.findOne({ platform, externalEventId: String(externalEventId) });
      return { event: existing, isDuplicate: true };
    }
    throw err;
  }
};

/**
 * Create marketplace booking from a normalized order + optional quoteId.
 * Does NOT book courier until payment is confirmed.
 *
 * @param {Object} params
 * @param {Object} params.storeConnection
 * @param {Object} params.normalized — from adapters
 * @param {string} [params.quoteId]
 * @param {string} [params.partner]
 * @param {string} [params.service]
 */
const ingestNormalizedOrder = async ({ storeConnection, normalized, quoteId, partner, service }) => {
  if (!storeConnection || storeConnection.status !== 'active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Store connection inactive');
  }
  if (!normalized || !normalized.externalOrderId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'externalOrderId required');
  }

  const platform = storeConnection.platform;
  const { event, isDuplicate } = await claimEvent({
    platform,
    eventType: 'order.created',
    externalEventId: `${platform}:order:${normalized.externalOrderId}`,
    storeConnectionId: storeConnection.id || storeConnection._id,
    payload: normalized,
  });

  if (isDuplicate) {
    if (event.booking) {
      const existing = await Booking.findById(event.booking);
      if (existing) return { booking: existing, duplicate: true, payment: null };
    }
    const existingByExt = await Booking.findOne({
      storeConnection: storeConnection.id || storeConnection._id,
      externalOrderId: String(normalized.externalOrderId),
      source: platform,
    });
    if (existingByExt) return { booking: existingByExt, duplicate: true, payment: null };
  }

  let money;
  let quoteMeta = {};
  if (quoteId) {
    const q = await quoteBridge.getValidQuote(quoteId, { partner, service });
    money = {
      carrierCost: q.carrierCost,
      marginAmount: q.marginAmount,
      marginPercent: q.marginPercent,
      quotedPrice: q.quotedPrice,
      partner: q.partner,
      service: q.service,
      logisticsQuoteId: q.logisticsQuoteId || null,
      shopMarginAmount: q.shopMarginAmount || 0,
      pickupName: q.pickupName || null,
    };
    quoteMeta = { quoteId, pickup: q.doc.pickup, dropoff: q.doc.dropoff, weightKg: q.doc.weightKg, mode: q.doc.mode };
  } else {
    // Webhook path: save the shop order first. Seller gets courier prices in CloudShip after.
    money = {
      carrierCost: 0,
      marginAmount: 0,
      marginPercent: 0,
      quotedPrice: 0,
      partner: null,
      service: null,
      logisticsQuoteId: null,
      shopMarginAmount: 0,
      pickupName: null,
    };
    quoteMeta = {
      quoteId: null,
      pickup: normalized.pickup,
      dropoff: normalized.dropoff,
      weightKg: normalized.weightKg,
      mode: (storeConnection.settings && storeConnection.settings.defaultMode) || 'Road',
    };
  }

  const now = new Date();
  const timeline = TIMELINE_TEMPLATE.map((step, i) => ({
    ...step,
    timestamp: i === 0 ? now : null,
    done: i === 0,
  }));

  const code = await generateBookingCode();
  let booking;
  try {
    booking = await Booking.create({
      company: storeConnection.company,
      code,
      trackingToken: generateTrackingToken(),
      status: 'pending',
      mode: quoteMeta.mode || 'Road',
      cargo: normalized.cargo || `Order ${normalized.externalOrderId}`,
      value: money.quotedPrice,
      pickup: quoteMeta.pickup || normalized.pickup,
      dropoff: quoteMeta.dropoff || normalized.dropoff,
      timeline,
      bookedAt: now,
      source: platform,
      storeConnection: storeConnection.id || storeConnection._id,
      externalOrderId: String(normalized.externalOrderId),
      quoteId: quoteMeta.quoteId || null,
      carrierCost: money.carrierCost,
      marginAmount: money.marginAmount,
      marginPercent: money.marginPercent,
      quotedPrice: money.quotedPrice,
      currency: (storeConnection.settings && storeConnection.settings.currency) || 'ZAR',
      paymentStatus: 'awaiting',
      selectedPartner: money.partner,
      selectedService: money.service,
      logisticsQuoteId: money.logisticsQuoteId || null,
      partnerId: money.partner || null,
      serviceName: money.service || null,
      shopMarginAmount: money.shopMarginAmount || 0,
      pickupName: money.pickupName || null,
      weightKg: quoteMeta.weightKg || normalized.weightKg || null,
      buyerEmail: normalized.buyerEmail || null,
      buyerPhone: normalized.buyerPhone || null,
      orderTotal: normalized.orderTotal != null ? normalized.orderTotal : null,
      itemsTotal: normalized.itemsTotal != null ? normalized.itemsTotal : null,
      shippingTotal: normalized.shippingTotal != null ? normalized.shippingTotal : null,
      lineItems: Array.isArray(normalized.shopLineItems) ? normalized.shopLineItems : [],
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await Booking.findOne({
        storeConnection: storeConnection.id || storeConnection._id,
        externalOrderId: String(normalized.externalOrderId),
        source: platform,
      });
      if (existing) return { booking: existing, duplicate: true, payment: null };
    }
    await IntegrationEvent.updateOne(
      { _id: event._id },
      { status: 'failed', lastError: err.message }
    );
    throw err;
  }

  if (quoteMeta.quoteId) {
    await quoteBridge.markQuoteConsumed(quoteMeta.quoteId);
  }

  const payment = await paymentBridge.createPaymentForBooking(booking);

  await IntegrationEvent.updateOne(
    { _id: event._id },
    { status: 'processed', booking: booking._id }
  );

  storeConnection.lastWebhookAt = new Date();
  await storeConnection.save();

  return { booking, duplicate: false, payment };
};

/**
 * After logistics status change, push tracking back to the shop (best-effort).
 */
const pushStatusToShop = async (booking, statusPayload) => {
  if (!booking || !booking.storeConnection) return { pushed: false };
  const { StoreConnection } = require('../../models');
  const conn = await StoreConnection.findById(booking.storeConnection);
  if (!conn) return { pushed: false };
  const adapter = getAdapter(conn.platform);
  if (!adapter || typeof adapter.pushStatus !== 'function') {
    return { pushed: false };
  }
  const payload = {
    status: (statusPayload && statusPayload.status) || displayShipmentStatus(booking),
    courierStatus: (statusPayload && statusPayload.courierStatus) || booking.courierStatus || null,
    trackingNumber: booking.trackingNumber,
    trackingUrl: booking.trackingUrl || null,
    bookingCode: booking.code,
    label: displayShipmentLabel({
      ...((booking.toObject && booking.toObject()) || booking),
      courierStatus: (statusPayload && statusPayload.courierStatus) || booking.courierStatus,
    }),
  };
  try {
    const result = await adapter.pushStatus(conn, booking, payload);
    if (result && result.skipped) {
      logger.warn(`Shop status push skipped for ${booking.code} (${conn.platform})`);
      return { pushed: false, skipped: true };
    }
    logger.info(`Pushed ${payload.label} to ${conn.platform} for ${booking.code}`);
    return { pushed: true };
  } catch (err) {
    logger.warn(`Shop status push failed for ${booking.code}: ${err.message}`);
    return { pushed: false, error: err.message };
  }
};

const afterSuccessfulBook = async (booking) => {
  if (!booking || !booking.logisticsBookingRef) return;
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, postBookNotifiedAt: null },
    { $set: { postBookNotifiedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return;
  if (claimed.status === 'pending' && claimed.logisticsBookingRef && !claimed.courierStatus) {
    claimed.courierStatus = 'collection-assigned';
    claimed.timeline = progressTimeline(claimed.timeline, 'booked', new Date());
    await claimed.save();
  }
  const pushed = await pushStatusToShop(claimed, {
    status: displayShipmentStatus(claimed),
    courierStatus: claimed.courierStatus,
    trackingNumber: claimed.trackingNumber,
  });
  if (pushed.pushed) {
    claimed.lastPushedCourierStatus = claimed.courierStatus || displayShipmentStatus(claimed);
    await claimed.save();
  }
  try {
    const { Company } = require('../../models');
    const { emailService } = require('../../services');
    const company = await Company.findById(claimed.company);
    await emailService.sendShipmentBookedEmails({
      booking: claimed,
      shopEmail: company && company.email,
      shopName: company && company.name,
    });
  } catch (err) {
    logger.warn(`Post-book notify failed for ${claimed.code}: ${err.message}`);
  }
};

const applyShopTotals = (booking, totals) => {
  if (!booking || !totals) return false;
  let changed = false;
  if (booking.orderTotal == null && totals.orderTotal != null) {
    booking.orderTotal = totals.orderTotal;
    changed = true;
  }
  if (booking.itemsTotal == null && totals.itemsTotal != null) {
    booking.itemsTotal = totals.itemsTotal;
    changed = true;
  }
  if (booking.shippingTotal == null && totals.shippingTotal != null) {
    booking.shippingTotal = totals.shippingTotal;
    changed = true;
  }
  if ((!booking.lineItems || !booking.lineItems.length) && totals.lineItems && totals.lineItems.length) {
    booking.lineItems = totals.lineItems;
    changed = true;
  }
  return changed;
};

/**
 * Fill orderTotal / line items on older marketplace bookings from the original webhook payload.
 */
const hydrateShopOrderTotals = async (bookings) => {
  const missing = (bookings || []).filter(
    (booking) =>
      ['woocommerce', 'shopify', 'wix', 'lovable', 'bigcommerce'].includes(booking.source) &&
      (booking.orderTotal == null || !booking.lineItems || !booking.lineItems.length)
  );
  if (!missing.length) return bookings;

  const events = await IntegrationEvent.find({
    booking: { $in: missing.map((booking) => booking._id) },
    eventType: 'order.created',
  });
  const byBooking = new Map(events.map((event) => [String(event.booking), event]));

  await Promise.all(
    missing.map(async (booking) => {
      const event = byBooking.get(String(booking._id));
      const payload = event && event.payload;
      if (!payload) return;
      const totals = extractShopTotals(payload.raw || payload, payload.shopLineItems || payload.lineItems);
      if (!applyShopTotals(booking, totals)) return;
      try {
        await booking.save();
      } catch (err) {
        logger.warn(`Shop order hydrate failed for ${booking.code}: ${err.message}`);
      }
    })
  );
  return bookings;
};

module.exports = {
  claimEvent,
  ingestNormalizedOrder,
  pushStatusToShop,
  afterSuccessfulBook,
  hydrateShopOrderTotals,
};
