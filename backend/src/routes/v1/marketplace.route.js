const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { StoreConnection, Booking } = require('../../models');
const ApiError = require('../../utils/ApiError');
const catchAsync = require('../../utils/catchAsync');
const carriers = require('../../services/carriers');
const policy = require('../../integrations/marketplacePolicy');
const tracking = require('../../integrations/bridge/carrierTracking.service');
const { createLimiter } = require('../../utils/limits');
const { displayShipmentStatus } = require('../../integrations/utils/shipmentProgress');

const quoteSchema = new mongoose.Schema({ connection: mongoose.Schema.Types.ObjectId, livemode: { type: Boolean, default: true }, input: Object, parcels: [Object], options: [Object], expiresAt: Date }, { timestamps: true });
const dispatchSchema = new mongoose.Schema({ connection: mongoose.Schema.Types.ObjectId, livemode: { type: Boolean, default: true }, externalOrderId: String, quoteId: String,
  partner: String, service: String, currency: String, maxAmount: Number, parcels: [Object], state: String, reason: String, leaseUntil: Date,
}, { timestamps: true });
dispatchSchema.index({ connection: 1, externalOrderId: 1 }, { unique: true });
// Sandbox records are disposable.
quoteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { livemode: false } });
dispatchSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { livemode: false } });
const Quote = mongoose.models.MarketplaceParcelQuote || mongoose.model('MarketplaceParcelQuote', quoteSchema);
const Dispatch = mongoose.models.MarketplaceDispatch || mongoose.model('MarketplaceDispatch', dispatchSchema);
const router = express.Router();

// Browse-time estimates share one small lane, so a burst of product-page visitors queues here instead of
// swamping the carriers and slowing down real checkout quotes, which are never held up by it.
const estimateLane = createLimiter({
  concurrent: Number(process.env.CLOUDSHIP_MAX_CONCURRENT_ESTIMATES) || 6,
  queue: Number(process.env.CLOUDSHIP_MAX_QUEUED_ESTIMATES) || 60,
});

function signature(secret, timestamp, body) { return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'); }
router.use(catchAsync(async (req, res, next) => {
  const key = req.headers['x-cloudship-key'];
  if (typeof key !== 'string') throw new ApiError(401, 'CloudShip key required.');
  const connection = await StoreConnection.findOne({ publicApiKey: key, platform: 'lovable', status: 'active' });
  const timestamp = req.headers['x-cloudship-timestamp'];
  const supplied = req.headers['x-cloudship-signature'];
  if (!connection?.webhookSecret || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 300000 || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/i.test(supplied)) throw new ApiError(401, 'Valid signed CloudShip request required.');
  const expected = signature(connection.webhookSecret, timestamp, req.rawBody || JSON.stringify(req.body));
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) throw new ApiError(401, 'Invalid CloudShip signature.');
  // Use authenticated raw bytes, before the generic XSS middleware modifies string values.
  if (req.rawBody) req.body = JSON.parse(req.rawBody.toString('utf8'));
  req.connectionRecord = connection;
  next();
}));

router.post('/eligibility', (req, res) => res.send(policy.eligibility(req.body.commodities)));
router.post('/connection', (req, res) => res.send({ connected: true, livemode: isLive(req.connectionRecord), invoiceEnabled: invoiceEnabled(req.connectionRecord), storeName: req.connectionRecord.storeName }));
function isLive(connection) { return connection.livemode !== false; }
// Test-mode stores are simulated end to end, so they need no invoicing approval.
function invoiceEnabled(connection) { return !isLive(connection) || String(process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS || '').split(',').map(value => value.trim()).includes(String(connection._id)); }
// phase 'book' lets the simulated carrier raise its price between checkout and booking (magic address `price-increase`).
async function quotesFor(parcels, livemode, phase, estimate = false) {
  const rows = [];
  for (let offset = 0; offset < parcels.length; offset += 5) rows.push(...await Promise.all(parcels.slice(offset, offset + 5).map(parcel => carriers.quoteAll(livemode ? parcel : { ...parcel, sandboxPhase: phase }, { livemode, estimate }))));
  return rows.map(row => row.partners || []);
}
function expanded(input) {
  const allowed = policy.eligibility(input?.parcels?.map(parcel => parcel.commodity || {}));
  if (allowed.status !== 'eligible') throw new ApiError(400, allowed.reason);
  try { return policy.expandShipment(input); } catch (err) { throw new ApiError(400, err.message); }
}
router.post('/rates', catchAsync(async (req, res) => {
  if (!invoiceEnabled(req.connectionRecord)) throw new ApiError(503, 'CloudShip account settlement must be enabled before checkout shipping is available.');
  const parcels = expanded(req.body);
  // `estimate: true` is a non-binding browse price: short carrier waits, nothing saved, no quoteId, cannot be booked.
  if (req.body.estimate === true) {
    const rows = await estimateLane.run(() => quotesFor(parcels, isLive(req.connectionRecord), 'rates', true));
    const estimated = policy.commonOptions(rows);
    return res.send(estimated.length ? { estimate: true, options: estimated } : { estimate: true, options: [], reason: 'No common carrier service is available for these parcels and route.' });
  }
  const rows = await quotesFor(parcels, isLive(req.connectionRecord), 'rates');
  const options = policy.commonOptions(rows);
  if (!options.length) return res.send({ options: [], reason: 'No common carrier service is available for these parcels and route.' });
  const expiresAt = new Date(Math.min(Date.now() + 15 * 60000, ...rows.flat().filter(row => row.available).map(row => new Date(row.expiresAt).getTime()).filter(Number.isFinite)));
  const quote = await Quote.create({ connection: req.connectionRecord._id, livemode: isLive(req.connectionRecord), input: req.body, parcels, options, expiresAt });
  return res.send({ quoteId: String(quote._id), expiresAt, options });
}));

async function view(dispatch) {
  const ids = dispatch.parcels.map(parcel => parcel.bookingId).filter(Boolean);
  // `livemode` in the filter opts these id-targeted reads out of the live-only scope.
  const bookings = ids.length ? await Booking.find({ _id: { $in: ids }, livemode: { $in: [true, false] } }) : [];
  for (const booking of bookings) { try { await tracking.refreshBookingTracking(booking); } catch (err) { /* Reconcile again on the next poll. */ } }
  const statuses = bookings.map(displayShipmentStatus);
  const complete = dispatch.state === 'booked' && statuses.length === dispatch.parcels.length;
  const status = complete && statuses.every(value => ['delivered', 'completed'].includes(value)) ? 'delivered'
    : statuses.some(value => ['warehouse', 'in_transit', 'out_for_delivery', 'delivered', 'completed'].includes(value)) ? 'in_transit' : 'pending';
  return { bookingId: String(dispatch._id), bookingCode: String(dispatch._id), externalOrderId: dispatch.externalOrderId,
    bookingStatus: dispatch.state, reason: dispatch.reason, status, collected: complete && statuses.every(value => ['warehouse', 'in_transit', 'out_for_delivery', 'delivered', 'completed'].includes(value)),
    trackingUrl: bookings.length === 1 ? bookings[0].trackingUrl : undefined,
    parcels: bookings.map(booking => ({ bookingCode: booking.code, status: displayShipmentStatus(booking), trackingUrl: booking.trackingUrl })) };
}
function ref(body) { if (typeof body.externalOrderId !== 'string' || !body.externalOrderId.length || body.externalOrderId.length > 200) throw new ApiError(400, 'Stable shipment reference required.'); return body.externalOrderId; }
router.post('/status', catchAsync(async (req, res) => {
  const dispatch = await Dispatch.findOne({ connection: req.connectionRecord._id, externalOrderId: ref(req.body) });
  if (!dispatch) throw new ApiError(404, 'Shipment not found.');
  res.send(await view(dispatch));
}));

router.post('/book', catchAsync(async (req, res) => {
  const connection = req.connectionRecord;
  if (!invoiceEnabled(connection)) throw new ApiError(403, 'CloudShip account invoicing is not enabled for this store.');
  const externalOrderId = ref(req.body);
  if (typeof req.body.buyerPhone !== 'string' || !req.body.buyerPhone.trim()) throw new ApiError(400, 'Buyer contact phone is required.');
  let dispatch = await Dispatch.findOne({ connection: connection._id, externalOrderId });
  if (!dispatch) {
    if (!mongoose.Types.ObjectId.isValid(req.body.quoteId)) throw new ApiError(400, 'Valid CloudShip quote required.');
    const quote = await Quote.findOne({ _id: req.body.quoteId, connection: connection._id });
    // Expiry may precede seller acceptance. Re-quote the immutable original shipment below.
    const option = quote?.options.find(row => row.partner === req.body.partner && row.service === req.body.service);
    if (!option || option.currency !== req.body.currency || option.quotedPrice !== req.body.maxAmount) throw new ApiError(409, 'The shipment must use its original quoted price and currency.');
    try { dispatch = await Dispatch.create({ connection: connection._id, livemode: isLive(connection), externalOrderId, quoteId: String(quote._id), partner: option.partner,
      service: option.service, currency: option.currency, maxAmount: option.quotedPrice,
      parcels: quote.parcels.map(parcel => ({ shipment: parcel, state: 'pending' })), state: 'pending' }); }
    catch (err) { if (err.code !== 11000) throw err; dispatch = await Dispatch.findOne({ connection: connection._id, externalOrderId }); }
  }
  if (dispatch.state === 'booked' || dispatch.parcels.some(parcel => parcel.state === 'booking')) return res.send(await view(dispatch));
  const claimed = await Dispatch.findOneAndUpdate({ _id: dispatch._id, leaseUntil: { $exists: false } }, { $set: { leaseUntil: new Date(Date.now() + 120000) } }, { new: true });
  if (!claimed) throw new ApiError(409, 'Shipment booking is already being processed.');
  dispatch = claimed;
  try {
    const rows = await quotesFor(dispatch.parcels.map(parcel => parcel.shipment), isLive(connection), 'book');
    const selected = rows.map(row => policy.choose(row, dispatch.partner, dispatch.service, dispatch.currency));
    const total = selected.reduce((sum, row, index) => sum + (dispatch.parcels[index].state === 'booked' ? Number(dispatch.parcels[index].price) : Number(row?.sellPrice || Infinity)), 0);
    if (total > dispatch.maxAmount + 0.001) { dispatch.state = 'needs_attention'; dispatch.reason = 'The selected carrier is unavailable or its price increased. Operations must arrange delivery within the paid amount; no extra buyer charge was made.'; await dispatch.save(); return res.send(await view(dispatch)); }
    for (let i = 0; i < dispatch.parcels.length; i += 1) {
      if (dispatch.parcels[i].state === 'booked') continue;
      const parcel = dispatch.parcels[i];
      const selectedQuote = selected[i];
      parcel.state = 'booking'; parcel.price = selectedQuote.sellPrice;
      dispatch.state = 'booking'; dispatch.reason = 'Booking in progress. If interrupted, operations must reconcile the carrier before retrying.';
      dispatch.markModified('parcels'); await dispatch.save();
      // Persist a stable booking before contacting the carrier so ambiguous responses are visible to ops.
      const booking = await Booking.create({ company: connection.company, code: `BKG-CMT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
        trackingToken: crypto.randomBytes(24).toString('hex'), mode: 'Road', cargo: parcel.shipment.cargo,
        pickup: parcel.shipment.pickup, dropoff: parcel.shipment.dropoff, weightKg: parcel.shipment.weightKg,
        value: selectedQuote.sellPrice, quotedPrice: selectedQuote.sellPrice, carrierCost: selectedQuote.partnerPrice,
        marginAmount: selectedQuote.marginAmount, currency: dispatch.currency, paymentStatus: 'awaiting', livemode: isLive(connection),
        source: 'lovable', storeConnection: connection._id, externalOrderId: `${externalOrderId}:parcel:${i}`,
        selectedPartner: dispatch.partner, selectedService: dispatch.service, logisticsQuoteId: selectedQuote.quoteId,
        buyerPhone: req.body.buyerPhone, buyerEmail: req.body.buyerEmail, bookedAt: new Date() });
      parcel.bookingId = String(booking._id); dispatch.markModified('parcels'); await dispatch.save();
      const booked = await carriers.bookStoredQuote(selectedQuote.quoteId, { pickupPhone: parcel.shipment.pickupPhone, dropoffPhone: req.body.buyerPhone, dropoffName: req.body.buyerName, livemode: isLive(connection) });
      // Awaiting is deliberate: carrier service is booked on account, invoice payment is separate.
      Object.assign(booking, { logisticsBookingRef: booked.carrierShipmentId || booked.trackingNumber, carrierShipmentId: booked.carrierShipmentId,
        trackingNumber: booked.trackingNumber, trackingUrl: booked.trackingUrl, labelUrl: booked.labelUrl, partnerId: dispatch.partner,
        serviceName: dispatch.service, courierStatus: booked.courierStatus || 'collection-assigned' });
      await booking.save();
      parcel.state = 'booked'; dispatch.markModified('parcels'); await dispatch.save();
    }
    dispatch.state = 'booked'; dispatch.reason = ''; await dispatch.save();
    return res.send(await view(dispatch));
  } catch (err) {
    dispatch.state = 'needs_attention'; dispatch.reason = 'Courier booking could not be confirmed. Operations must reconcile the carrier before retrying to avoid a duplicate collection.';
    await dispatch.save();
    throw new ApiError(502, dispatch.reason);
  } finally { await Dispatch.updateOne({ _id: dispatch._id }, { $unset: { leaseUntil: 1 } }); }
}));
// Test control, sandbox stores only: move every parcel of a shipment forward and let the normal tracking
// refresh fire the signed status callback, exactly as a real carrier update would.
router.post('/test/advance', catchAsync(async (req, res) => {
  const connection = req.connectionRecord;
  if (isLive(connection)) throw new ApiError(403, 'Shipment simulation is only available to test-mode stores.');
  const dispatch = await Dispatch.findOne({ connection: connection._id, externalOrderId: ref(req.body) });
  if (!dispatch) throw new ApiError(404, 'Shipment not found.');
  if (dispatch.state !== 'booked') throw new ApiError(409, 'Shipment is not booked yet.');
  const bookings = await Booking.find({ _id: { $in: dispatch.parcels.map(parcel => parcel.bookingId).filter(Boolean) }, livemode: { $in: [true, false] } });
  for (const booking of bookings) {
    try { await carriers.sandbox.advance(booking.carrierShipmentId, req.body.courierStatus); }
    catch (err) { throw new ApiError(400, err.message); }
  }
  res.send(await view(dispatch));
}));
module.exports = router;
