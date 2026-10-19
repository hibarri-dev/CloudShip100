const httpStatus = require('http-status');
const ApiError = require('../../utils/ApiError');
const config = require('../../config/config');
const { safeEqualString, hmacSha256Hex } = require('../utils/crypto.util');
const { buildNormalizedOrder, formatAddress } = require('./normalize');

/**
 * Lovable / universal SDK adapter.
 * Auth: publicApiKey on StoreConnection + HMAC header x-cloudship-signature = hex(HMAC-SHA256(rawBody, webhookSecret))
 * Body for rates/orders is already close to CloudShip shape.
 */

const verifyWebhook = (storeConnection, req) => {
  const apiKey = req.headers['x-cloudship-key'] || req.headers['x-api-key'];
  const publicKeyOk = Boolean(storeConnection.publicApiKey && apiKey && apiKey === storeConnection.publicApiKey);
  if (storeConnection.publicApiKey && apiKey && apiKey !== storeConnection.publicApiKey) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid CloudShip API key');
  }
  const secret = storeConnection.webhookSecret;
  const signature = req.headers['x-cloudship-signature'];
  if (signature) {
    if (!secret) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Webhook secret is not configured');
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const expected = hmacSha256Hex(secret, raw);
    if (!safeEqualString(String(signature).toLowerCase(), expected.toLowerCase())) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid CloudShip signature');
    }
    return true;
  }
  if (publicKeyOk) {
    return true;
  }
  if (config.env === 'development' || config.env === 'test') {
    return true;
  }
  throw new ApiError(httpStatus.UNAUTHORIZED, 'Missing CloudShip API key or signature');
};

const normalizeOrder = (payload) => {
  const dropoff =
    payload.dropoff ||
    formatAddress(payload.shippingAddress || payload.destination || {}) ||
    payload.to;
  const pickup = payload.pickup || formatAddress(payload.origin || {}) || 'Merchant warehouse';
  return buildNormalizedOrder({
    externalOrderId: payload.externalOrderId || payload.orderId || payload.id,
    pickup,
    dropoff,
    weightKg: payload.weightKg || payload.weight,
    cargo: payload.cargo || payload.description,
    buyerEmail: payload.buyerEmail || (payload.buyer && payload.buyer.email),
    buyerPhone: payload.buyerPhone || (payload.buyer && payload.buyer.phone),
    currency: payload.currency,
    lineItems: payload.lineItems || payload.items,
    raw: payload,
  });
};

const parseRateRequest = (body) => {
  const dropoff =
    body.dropoff || formatAddress(body.shippingAddress || body.destination || {}) || body.to;
  const pickup = body.pickup || formatAddress(body.origin || {}) || 'Merchant warehouse';
  const weightKg = Number(body.weightKg || body.weight || 1);
  return {
    pickup,
    dropoff,
    weightKg: weightKg > 0 ? weightKg : 1,
    currency: body.currency,
  };
};

/** Universal SDK does not need push — caller polls /track; optional callback URL later */
const pushStatus = async (storeConnection, booking, statusPayload) => {
  const creds = (() => {
    try {
      const { decryptCredentials } = require('../utils/crypto.util');
      return decryptCredentials(storeConnection.credentialsEncrypted);
    } catch (e) {
      return {};
    }
  })();
  if (!creds.statusWebhookUrl) {
    return { skipped: true };
  }
  let callbackPayload = {
    externalOrderId: booking.externalOrderId,
    bookingCode: booking.code,
    status: statusPayload.status || booking.status,
    courierStatus: statusPayload.courierStatus || booking.courierStatus || null,
    trackingNumber: booking.trackingNumber,
    trackingUrl: booking.trackingUrl || null,
    logisticsBookingRef: booking.logisticsBookingRef,
  };
  // Marketplace bundles contain multiple carrier parcels but update one storefront shipment.
  if (/:parcel:\d+$/.test(booking.externalOrderId || '')) {
    const mongoose = require('mongoose');
    const Dispatch = mongoose.models.MarketplaceDispatch;
    const externalOrderId = booking.externalOrderId.replace(/:parcel:\d+$/, '');
    const dispatch = Dispatch && await Dispatch.findOne({ connection: storeConnection._id, externalOrderId });
    if (!dispatch || dispatch.state !== 'booked') return { skipped: true };
    const { Booking } = require('../../models');
    const { displayShipmentStatus } = require('../utils/shipmentProgress');
    const parcels = await Booking.find({ _id: { $in: dispatch.parcels.map(parcel => parcel.bookingId).filter(Boolean) }, livemode: { $in: [true, false] } });
    const statuses = parcels.map(displayShipmentStatus);
    const all = parcels.length === dispatch.parcels.length;
    callbackPayload = { externalOrderId, bookingCode: String(dispatch._id),
      status: all && statuses.every(status => status === 'delivered') ? 'delivered' : statuses.some(status => ['warehouse', 'in_transit', 'out_for_delivery', 'delivered'].includes(status)) ? 'in_transit' : 'pending',
      collected: all && statuses.every(status => ['warehouse', 'in_transit', 'out_for_delivery', 'delivered'].includes(status)),
      parcels: parcels.map(parcel => ({ bookingCode: parcel.code, status: displayShipmentStatus(parcel), trackingUrl: parcel.trackingUrl })),
    };
  }
  const rawBody = JSON.stringify(callbackPayload);
  const timestamp = String(Date.now());
  const signed = storeConnection.webhookSecret
    ? { 'x-cloudship-timestamp': timestamp, 'x-cloudship-signature': hmacSha256Hex(storeConnection.webhookSecret, `${timestamp}.${rawBody}`) } : {};
  const res = await fetch(creds.statusWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signed },
    body: rawBody,
  });
  if (!res.ok) {
    throw new Error(`Lovable status webhook failed: ${res.status}`);
  }
  return { ok: true };
};

module.exports = {
  platform: 'lovable',
  verifyWebhook,
  normalizeOrder,
  parseRateRequest,
  pushStatus,
};
