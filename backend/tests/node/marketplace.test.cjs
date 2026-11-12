const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const policy = require('../../src/integrations/marketplacePolicy');
const connection = { _id: 'c'.repeat(24), company: 'company', webhookSecret: 'server-secret', storeName: 'Commoditopia' };
const input = { pickup: '2 Main Rd, Sandton, 2196, ZA', pickupPhone: '+27820000000', dropoff: '1 Main Rd, Cape Town, 8000, ZA', parcels: [{ quantity: 2, weightKg: 1, lengthCm: 20, widthCm: 15, heightCm: 10, commodity: { cargoForm: 'solid', packagingType: 'bagged' } }] };
function harness(conn = connection) {
  let quote, dispatch, count = 0, calls = 0, price = 50, fail = false;
  const bookings = [], routes = {}, seen = [], advanced = [];
  const document = data => ({ ...data, async save() { return this; }, markModified() {} });
  class Schema { index() {} } Schema.Types = { ObjectId: String };
  const models = {
    MarketplaceParcelQuote: { async create(data) { quote = document({ ...data, _id: 'a'.repeat(24) }); return quote; }, async findOne(query) { return quote && String(query._id) === String(quote._id) && query.connection === quote.connection ? quote : null; } },
    MarketplaceDispatch: { async create(data) { dispatch = document({ ...data, _id: 'd'.repeat(24) }); return dispatch; }, async findOne(query) { return dispatch && query.connection === dispatch.connection && query.externalOrderId === dispatch.externalOrderId ? dispatch : null; }, async findOneAndUpdate(query, update) { if (dispatch.leaseUntil) return null; Object.assign(dispatch, update.$set); return dispatch; }, async updateOne() { delete dispatch.leaseUntil; } },
  };
  const router = { use(handler) { routes.auth = handler; }, post(route, handler) { routes[route] = handler; } };
  const mocked = name => {
    if (name === 'express') return { Router: () => router };
    if (name === 'crypto') return crypto;
    if (name === 'mongoose') return { Schema, models, Types: { ObjectId: { isValid: value => /^[a-f0-9]{24}$/.test(value) } }, model: name => models[name] };
    if (name === '../../models') return { StoreConnection: { findOne: async () => conn }, Booking: { async create(data) { const booking = document({ ...data, _id: `booking-${count++}` }); bookings.push(booking); return booking; }, async find(query) { return bookings.filter(booking => query._id.$in.includes(booking._id)); } } };
    if (name.endsWith('/limits')) return require('../../src/utils/limits');
    if (name.endsWith('/ApiError')) return class ApiError extends Error { constructor(code, message) { super(message); this.statusCode = code; } };
    if (name.endsWith('/catchAsync')) return fn => fn;
    if (name.endsWith('/marketplacePolicy')) return policy;
    if (name.endsWith('/carrierTracking.service')) return { refreshBookingTracking: async () => {} };
    if (name.endsWith('/shipmentProgress')) return { displayShipmentStatus: booking => booking.courierStatus === 'delivered' ? 'delivered' : booking.courierStatus === 'collected' ? 'warehouse' : 'booked' };
    if (name.endsWith('/carriers')) return { sandbox: { async advance(id, status) { advanced.push([id, status]); } }, async quoteAll(shipment, options) { seen.push(options); return { partners: [{ available: true, partnerId: 'courier_guy', serviceName: 'Economy', currency: 'ZAR', sellPrice: price, partnerPrice: price / 1.1, marginAmount: price - price / 1.1, quoteId: `rate-${count++}`, expiresAt: new Date(Date.now() + 900000) }] }; }, async bookStoredQuote() { calls++; if (fail) throw new Error('Timeout after sending booking'); return { carrierShipmentId: `carrier-${calls}`, trackingNumber: `tracking-${calls}`, trackingUrl: `https://carrier.test/${calls}` }; } };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/routes/v1/marketplace.route.js'), 'utf8'), { require: mocked, module, Buffer, process, Date, console });
  async function call(route, body) { let response; await routes[route]({ body, connectionRecord: conn }, { send(data) { response = data; return data; } }); return response; }
  return { call, routes, bookings, seen, advanced, quote: () => quote, dispatch: () => dispatch, calls: () => calls, setPrice(value) { price = value; }, setFail(value) { fail = value; } };
}
test('commodity policy separates unsupported cargo, incomplete details, and ordinary packaged solids', () => {
  assert.equal(policy.eligibility([{}]).status, 'incomplete');
  assert.equal(policy.eligibility([{ cargoForm: 'gas', packagingType: 'bagged' }]).status, 'unsupported');
  assert.equal(policy.eligibility([{ cargoForm: 'solid', packagingType: 'bagged', perishable: true }]).status, 'unsupported');
  assert.equal(policy.eligibility([{ cargoForm: 'solid', packagingType: 'bagged' }]).status, 'eligible');
  assert.throws(() => policy.expandShipment({ ...input, parcels: [{ ...input.parcels[0], quantity: 21 }] }), /20 parcels/);
});
test('authentication requires a fresh HMAC over the exact bytes; public API key alone is insufficient', async () => {
  const h = harness(), timestamp = String(Date.now()), rawBody = Buffer.from(JSON.stringify(input));
  const req = { headers: { 'x-cloudship-key': 'key', 'x-cloudship-timestamp': timestamp }, rawBody, body: input };
  await assert.rejects(h.routes.auth(req, {}, () => {}), /signed CloudShip/);
  req.headers['x-cloudship-signature'] = crypto.createHmac('sha256', connection.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  let authenticated = false; await h.routes.auth(req, {}, () => { authenticated = true; }); assert.ok(authenticated);
  req.rawBody = Buffer.from('{}'); await assert.rejects(h.routes.auth(req, {}, () => {}), /Invalid CloudShip signature/);
});
test('account settlement must be approved before rates or bookings; prices preserve carrier currency', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS;
  try {
    delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS;
    const h = harness(); await assert.rejects(h.call('/rates', input), /settlement/);
    process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = connection._id;
    const quote = await h.call('/rates', input);
    assert.equal(quote.options[0].quotedPrice, 100); assert.equal(quote.options[0].currency, 'ZAR');
  } finally { if (previous === undefined) delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; else process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('bookings reject price tampering, re-quote expired rates, and cannot duplicate parcel collections', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = connection._id;
  try {
    const h = harness(), quote = await h.call('/rates', input);
    const body = { externalOrderId: 'order:group', quoteId: quote.quoteId, partner: 'courier_guy', service: 'Economy', maxAmount: 100, currency: 'ZAR', buyerPhone: '+27820000001' };
    await assert.rejects(h.call('/book', { ...body, maxAmount: 1 }), /original quoted price/);
    h.quote().expiresAt = new Date(0);
    const booked = await h.call('/book', body);
    assert.equal(booked.bookingStatus, 'booked'); assert.equal(h.calls(), 2);
    assert.equal(h.bookings[0].paymentStatus, 'awaiting'); // Invoice remains unpaid; no second buyer payment.
    await h.call('/book', body); assert.equal(h.calls(), 2);
    h.bookings[0].courierStatus = 'delivered';
    let status = await h.call('/status', { externalOrderId: body.externalOrderId });
    assert.equal(status.status, 'in_transit'); assert.equal(status.collected, false);
    h.bookings[1].courierStatus = 'collected';
    status = await h.call('/status', { externalOrderId: body.externalOrderId }); assert.equal(status.collected, true); assert.notEqual(status.status, 'delivered');
    h.bookings[1].courierStatus = 'delivered'; status = await h.call('/status', { externalOrderId: body.externalOrderId }); assert.equal(status.status, 'delivered');
  } finally { if (previous === undefined) delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; else process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('price increases and uncertain carrier responses require attention without automatic duplicate bookings', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = connection._id;
  try {
    const h = harness(), quote = await h.call('/rates', input);
    const body = { externalOrderId: 'order:group', quoteId: quote.quoteId, partner: 'courier_guy', service: 'Economy', maxAmount: 100, currency: 'ZAR', buyerPhone: '+27820000001' };
    h.setPrice(60); assert.equal((await h.call('/book', body)).bookingStatus, 'needs_attention'); assert.equal(h.calls(), 0);
    h.setPrice(50); h.setFail(true);
    await assert.rejects(h.call('/book', body), /reconcile/); assert.equal(h.calls(), 1);
    await h.call('/book', body); assert.equal(h.calls(), 1);
  } finally { if (previous === undefined) delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; else process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('universal adapter signs callbacks and aggregates multiple parcels into the storefront shipment', async () => {
  let sent;
  const module = { exports: {} };
  const parcels = [{ code: 'one', courierStatus: 'delivered', trackingUrl: 'https://carrier.test/one' }, { code: 'two', courierStatus: 'collected', trackingUrl: 'https://carrier.test/two' }];
  const mocked = name => {
    if (name === 'http-status') return {};
    if (name.endsWith('/ApiError')) return Error;
    if (name.endsWith('/config')) return { env: 'test' };
    if (name.endsWith('/crypto.util')) return { decryptCredentials: () => ({ statusWebhookUrl: 'https://store.test/api/cloudship/status' }), hmacSha256Hex: (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex') };
    if (name.endsWith('/normalize')) return {};
    if (name === 'mongoose') return { models: { MarketplaceDispatch: { findOne: async () => ({ _id: 'dispatch', state: 'booked', parcels: [{ bookingId: 'one' }, { bookingId: 'two' }] }) } } };
    if (name === '../../models') return { Booking: { find: async () => parcels } };
    if (name.endsWith('/shipmentProgress')) return { displayShipmentStatus: parcel => parcel.courierStatus === 'delivered' ? 'delivered' : 'warehouse' };
    throw new Error(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/integrations/ecommerce/lovable.adapter.js'), 'utf8'), { require: mocked, module, fetch: async (url, request) => { sent = request; return { ok: true }; }, Date, Buffer, console });
  await module.exports.pushStatus(connection, { externalOrderId: 'order:group:parcel:0' }, { status: 'delivered' });
  const payload = JSON.parse(sent.body);
  assert.equal(payload.externalOrderId, 'order:group'); assert.equal(payload.bookingCode, 'dispatch');
  assert.equal(payload.status, 'in_transit'); assert.equal(payload.collected, true);
  const timestamp = sent.headers['x-cloudship-timestamp'];
  assert.equal(sent.headers['x-cloudship-signature'], crypto.createHmac('sha256', connection.webhookSecret).update(`${timestamp}.${sent.body}`).digest('hex'));
});

test('test-mode stores are simulated end to end: no invoice approval, sandbox carriers only, test-flagged records, and shipment simulation', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS;
  try {
    const sandbox = { ...connection, livemode: false }, h = harness(sandbox);
    assert.equal((await h.call('/connection', {})).livemode, false);
    const quote = await h.call('/rates', input); // no allow-list entry needed
    assert.equal(h.seen[0].livemode, false); assert.equal(h.quote().livemode, false);
    const body = { externalOrderId: 'order:group', quoteId: quote.quoteId, partner: 'courier_guy', service: 'Economy', maxAmount: 100, currency: 'ZAR', buyerPhone: '+27820000001' };
    await h.call('/book', body);
    assert.equal(h.dispatch().livemode, false); assert.ok(h.bookings.length && h.bookings.every(booking => booking.livemode === false));
    assert.equal(h.seen.at(-1).livemode, false);
    await h.call('/test/advance', { externalOrderId: 'order:group', courierStatus: 'collected' });
    assert.equal(h.advanced.length, h.bookings.length); assert.equal(h.advanced[0][1], 'collected');
  } finally { if (previous !== undefined) process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('live stores still need invoice approval, use live carriers and cannot use shipment simulation', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = connection._id;
  try {
    const h = harness();
    await h.call('/rates', input);
    assert.equal(h.seen[0].livemode, true); assert.equal(h.quote().livemode, true);
    await assert.rejects(h.call('/test/advance', { externalOrderId: 'order:group' }), /test-mode/);
    assert.equal(h.advanced.length, 0);
  } finally { if (previous === undefined) delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; else process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('sandbox carrier prices locally, honours magic addresses, and fails like a carrier would', async () => {
  const sandbox = require('../../src/services/carriers/sandbox.adapter');
  const { options } = await sandbox.quote({ pickup: '1 A St, Sandton', dropoff: '2 B St, Cape Town', weightKg: 2, lengthCm: 20, widthCm: 20, heightCm: 20 });
  assert.deepEqual(options.map(option => option.serviceName), ['Economy', 'Express']); assert.ok(options[1].partnerPrice > options[0].partnerPrice);
  await assert.rejects(sandbox.quote({ pickup: 'x', dropoff: '9 Unserviceable Rd', weightKg: 1 }), /no service/);
  const base = await sandbox.quote({ pickup: 'x', dropoff: 'price-increase road', weightKg: 1 });
  const rebook = await sandbox.quote({ pickup: 'x', dropoff: 'price-increase road', weightKg: 1, sandboxPhase: 'book' });
  assert.equal(rebook.options[0].partnerPrice, Math.round(base.options[0].partnerPrice * 1.5 * 100) / 100);
  await assert.rejects(sandbox.book({ pickup: 'x', dropoff: 'carrier-error lane', weightKg: 1 }), /did not confirm/);
  await assert.rejects(sandbox.book({ pickup: 'x', dropoff: 'y', weightKg: 99 }), /did not confirm/);
});
test('the scope follows the request mode: live sees live, test sees only sandbox data, and test documents are stamped', () => {
  const requestMode = require('../../src/utils/requestMode');
  const hooks = {}, added = [];
  require('../../src/models/plugins/livemodeScope.plugin')({ path: () => false, add: field => added.push(field), pre: (name, fn) => { hooks[name] = fn; } });
  assert.ok(added[0].livemode, 'the field is added when a model lacks it');
  const query = (filter, options = {}) => { const q = { filter, where(extra) { Object.assign(this.filter, extra); }, getFilter() { return this.filter; }, getOptions() { return options; } }; hooks.find.call(q); return q.filter; };
  assert.deepEqual(query({ company: 'c' }), { company: 'c', livemode: { $ne: false } }); // no request: live
  assert.deepEqual(query({ livemode: false }), { livemode: false });
  assert.deepEqual(query({ _id: 'x' }, { anyMode: true }), { _id: 'x' });
  requestMode.run(false, () => {
    assert.deepEqual(query({ company: 'c' }), { company: 'c', livemode: false });
    const pipeline = [{ $group: { _id: '$status' } }];
    hooks.aggregate.call({ pipeline: () => pipeline, options: {} });
    assert.deepEqual(pipeline[0], { $match: { livemode: false } });
    const doc = { isNew: true, livemode: true }; hooks.validate.call(doc, () => {}); assert.equal(doc.livemode, false);
  });
  requestMode.run(true, () => { const doc = { isNew: true, livemode: true }; hooks.validate.call(doc, () => {}); assert.equal(doc.livemode, true); });
  const pipeline = [{ $group: { _id: '$status' } }];
  hooks.aggregate.call({ pipeline: () => pipeline, options: {} });
  assert.deepEqual(pipeline[0], { $match: { livemode: { $ne: false } } });
});
test('authenticated requests take their mode from the x-cloudship-mode header; anything else is live', async () => {
  const passport = require('passport'), requestMode = require('../../src/utils/requestMode');
  passport.authenticate = (strategy, options, callback) => () => callback(null, { role: 'admin', id: 'u' }, null);
  const auth = require('../../src/middlewares/auth');
  const seen = async header => { let live; await auth()({ headers: header ? { 'x-cloudship-mode': header } : {}, params: {} }, {}, () => { live = requestMode.isLive(); }); return live; };
  assert.equal(await seen('test'), false); assert.equal(await seen('TEST'), false);
  assert.equal(await seen('live'), true); assert.equal(await seen(undefined), true); assert.equal(await seen('false'), true);
  assert.equal(requestMode.isLive(), true); // the mode never leaks out of the request
});
test('carrier quotes follow the request mode unless a caller states one explicitly', async () => {
  Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URL: 'mongodb://127.0.0.1/unused', JWT_SECRET: 'unit-test' });
  const { ShipmentQuote } = require('../../src/models');
  ShipmentQuote.create = async () => ({}); // no database in this test
  const carriers = require('../../src/services/carriers'), requestMode = require('../../src/utils/requestMode');
  const shipment = { pickup: '1 A St, Sandton', dropoff: '2 B St, Cape Town', weightKg: 2 };
  const partnersOf = async options => (await carriers.quoteAll(shipment, options)).partners.filter(row => row.available).map(row => row.partnerId);
  await requestMode.run(false, async () => {
    assert.deepEqual(new Set(await partnersOf()), new Set(['sandbox_courier'])); // follows the dashboard's test mode
    assert.equal((await carriers.quoteAll(shipment, { livemode: true })).partners.some(row => row.partnerId === 'sandbox_courier'), false); // explicit wins
  });
  assert.equal((await carriers.quoteAll(shipment)).partners.some(row => row.partnerId === 'sandbox_courier'), false); // no request: live carriers only
});

test('estimate rates are non-binding: flagged to the carrier layer, nothing saved, no quote id to book with', async () => {
  const previous = process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = connection._id;
  try {
    const h = harness();
    const estimate = await h.call('/rates', { ...input, estimate: true });
    assert.equal(estimate.estimate, true); assert.equal(estimate.options[0].quotedPrice, 100);
    assert.equal(estimate.quoteId, undefined); assert.equal(h.quote(), undefined);
    assert.equal(h.seen.at(-1).estimate, true);
    // An ordinary rates request is unchanged: saved, bookable, not flagged.
    const real = await h.call('/rates', input);
    assert.ok(real.quoteId); assert.ok(h.quote()); assert.equal(h.seen.at(-1).estimate, false);
  } finally { if (previous === undefined) delete process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS; else process.env.CLOUDSHIP_INVOICE_CONNECTION_IDS = previous; }
});
test('the limiter runs a fixed number at once, queues the rest in order, and refuses when the line is full', async () => {
  const { createLimiter } = require('../../src/utils/limits');
  const lane = createLimiter({ concurrent: 2, queue: 2 });
  let active = 0, peak = 0; const order = [];
  const job = id => lane.run(async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active -= 1; order.push(id); return id; });
  const first = [1, 2, 3, 4].map(job);
  await assert.rejects(job(5), error => error.statusCode === 503 && /Too many/.test(error.message));
  assert.deepEqual(await Promise.all(first), [1, 2, 3, 4]);
  assert.equal(peak, 2); assert.deepEqual(lane.stats(), { running: 0, waiting: 0 });
  await assert.rejects(lane.run(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(lane.stats(), { running: 0, waiting: 0 });
});
test('an estimate leaves out a carrier that is too slow instead of waiting for it, and saves nothing', async () => {
  process.env.CLOUDSHIP_ESTIMATE_CARRIER_TIMEOUT_MS = '40';
  const Module = require('node:module'); const root = path.join(__dirname, '../../src/services/carriers');
  const stub = (file, exports) => { const resolved = require.resolve(path.join(root, file)); require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }; return resolved; };
  const saved = [];
  const adapter = (id, quote) => ({ id, name: id, isConfigured: () => true, quote });
  const fast = adapter('fast', async () => ({ options: [{ partnerPrice: 10, currency: 'ZAR', serviceName: 'Economy' }] }));
  const slow = adapter('slow', () => new Promise(resolve => setTimeout(() => resolve({ options: [{ partnerPrice: 5, currency: 'ZAR', serviceName: 'Economy' }] }), 400)));
  const keys = [stub('courierGuy.adapter.js', fast), stub('uberDirect.adapter.js', slow), stub('dhlExpress.adapter.js', adapter('d', async () => { throw new Error('off'); })), stub('fedex.adapter.js', adapter('f', async () => { throw new Error('off'); })), stub('dsv.adapter.js', adapter('s', async () => { throw new Error('off'); })),
    stub('sandbox.adapter.js', adapter('sandbox', async () => ({ options: [] }))), stub('quoteStore.js', { put: async payload => { saved.push(payload); return { quoteId: 'saved-1', expiresAt: new Date().toISOString() }; } }),
    require.resolve('../../src/config/config')];
  require.cache[keys.at(-1)] = { id: keys.at(-1), filename: keys.at(-1), loaded: true, exports: { margin: { percent: 0, flat: 0 } } };
  const indexPath = require.resolve(path.join(root, 'index.js')); delete require.cache[indexPath];
  try {
    const carriers = require(indexPath);
    const started = Date.now();
    const estimate = await carriers.quoteAll({ pickup: 'A', dropoff: 'B', weightKg: 1 }, { livemode: true, estimate: true });
    assert.ok(Date.now() - started < 300, 'did not wait for the slow carrier');
    assert.deepEqual(estimate.partners.filter(row => row.available).map(row => row.partnerId), ['fast']);
    assert.match(estimate.partners.find(row => row.partnerId === 'slow').error, /did not answer/);
    assert.equal(saved.length, 0); assert.match(estimate.cheapest.quoteId, /^est_/);
    // Checkout quotes still wait for every carrier and are saved so they can be booked.
    const real = await carriers.quoteAll({ pickup: 'A', dropoff: 'B', weightKg: 1 }, { livemode: true });
    assert.deepEqual(real.partners.filter(row => row.available).map(row => row.partnerId).sort(), ['fast', 'slow']);
    assert.equal(saved.length, 2);
  } finally { delete process.env.CLOUDSHIP_ESTIMATE_CARRIER_TIMEOUT_MS; for (const key of [...keys, indexPath]) delete require.cache[key]; }
});
