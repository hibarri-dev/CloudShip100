const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Simulated carrier for test-mode (cs_test_) stores. It never contacts a real carrier:
 * prices are computed locally and bookings are fake, so integrators can exercise the whole
 * rates -> book -> tracking -> callback flow without cost, real collections or live data.
 *
 * Magic values (put them anywhere in the pickup or dropoff address):
 *   unserviceable   no rates are returned
 *   carrier-error   rates are returned but booking fails (an uncertain carrier result)
 *   price-increase  booking-time re-quote is 50% dearer than the checkout quote
 * A parcel weighing exactly 99 kg also fails to book.
 */
const id = 'sandbox_courier';
const name = 'Sandbox Courier';
const SEQUENCE = ['collection-assigned', 'collected', 'in-transit', 'out-for-delivery', 'delivered'];

const shipmentSchema = new mongoose.Schema(
  { carrierShipmentId: { type: String, unique: true }, courierStatus: String, createdAt: { type: Date, default: Date.now } },
  { versionKey: false }
);
shipmentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
const SandboxShipment = mongoose.models.SandboxShipment || mongoose.model('SandboxShipment', shipmentSchema);

const isConfigured = () => true;
const has = (shipment, word) => `${shipment.pickup || ''} ${shipment.dropoff || ''}`.toLowerCase().includes(word);

const quote = async (shipment) => {
  if (has(shipment, 'unserviceable')) throw new Error('Sandbox: no service between these addresses');
  const weight = Number(shipment.weightKg) > 0 ? Number(shipment.weightKg) : 1;
  const volumeKg = ((Number(shipment.lengthCm) || 0) * (Number(shipment.widthCm) || 0) * (Number(shipment.heightCm) || 0)) / 5000;
  const base = 50 + Math.max(weight, volumeKg) * 8;
  const surcharge = has(shipment, 'price-increase') && shipment.sandboxPhase === 'book' ? 1.5 : 1;
  const price = (factor) => Math.round(base * factor * surcharge * 100) / 100;
  return {
    options: [
      { partnerPrice: price(1), currency: 'ZAR', serviceName: 'Economy', serviceCode: 'sandbox-economy', meta: { transitDays: 3 } },
      { partnerPrice: price(1.8), currency: 'ZAR', serviceName: 'Express', serviceCode: 'sandbox-express', meta: { transitDays: 1 } },
    ],
  };
};

const book = async (shipment) => {
  if (has(shipment, 'carrier-error') || Number(shipment.weightKg) === 99) throw new Error('Sandbox: carrier did not confirm the booking');
  const carrierShipmentId = `sbx_${crypto.randomBytes(8).toString('hex')}`;
  await SandboxShipment.create({ carrierShipmentId, courierStatus: SEQUENCE[0] });
  return {
    carrierShipmentId,
    trackingNumber: carrierShipmentId.toUpperCase(),
    trackingUrl: `https://sandbox.cloudship100.com/track/${carrierShipmentId}`,
    labelUrl: null,
    courierStatus: SEQUENCE[0],
  };
};

const track = async ({ carrierShipmentId } = {}) => {
  const row = carrierShipmentId && (await SandboxShipment.findOne({ carrierShipmentId }));
  if (!row) throw new Error('Sandbox shipment not found');
  return { courierStatus: row.courierStatus, trackingNumber: row.carrierShipmentId.toUpperCase(), trackingUrl: null, events: [] };
};

/** Test control: move a sandbox shipment to `courierStatus`, or to the next stage when omitted. */
const advance = async (carrierShipmentId, courierStatus) => {
  const row = await SandboxShipment.findOne({ carrierShipmentId });
  if (!row) throw new Error('Sandbox shipment not found');
  const next = courierStatus || SEQUENCE[Math.min(SEQUENCE.indexOf(row.courierStatus) + 1, SEQUENCE.length - 1)] || SEQUENCE[1];
  row.courierStatus = next;
  await row.save();
  return next;
};

module.exports = { id, name, isConfigured, quote, book, track, advance, SEQUENCE };
