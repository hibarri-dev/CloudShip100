const crypto = require('crypto');
const { ShipmentQuote } = require('../../models');

const TTL_MS = 15 * 60 * 1000;

const put = async (payload) => {
  const quoteId = `csq_${crypto.randomBytes(8).toString('hex')}`;
  const expiresAt = new Date(Date.now() + TTL_MS);
  const shipment = payload.shipment || {};
  await ShipmentQuote.create({
    quoteId,
    pickup: shipment.pickup || 'unknown',
    dropoff: shipment.dropoff || 'unknown',
    weightKg: Number(shipment.weightKg) > 0 ? Number(shipment.weightKg) : 0.01,
    mode: shipment.mode || 'Road',
    livemode: payload.livemode !== false,
    currency: payload.currency || 'ZAR',
    carrierCost: Number(payload.partnerPrice) || 0,
    marginAmount: Number(payload.marginAmount) || 0,
    marginPercent: Number(payload.marginPercent) || 0,
    quotedPrice: Number(payload.sellPrice) || 0,
    selectedPartner: payload.partnerId || null,
    selectedService: payload.serviceName || null,
    expiresAt,
    payload,
  });
  return { quoteId, expiresAt: expiresAt.toISOString() };
};

const get = async (quoteId) => {
  const doc = await ShipmentQuote.findOne({
    quoteId,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  });
  return doc ? doc.payload : null;
};

const consume = async (quoteId) => {
  await ShipmentQuote.findOneAndUpdate({ quoteId }, { $set: { consumedAt: new Date() } });
};

module.exports = {
  put,
  get,
  consume,
};
