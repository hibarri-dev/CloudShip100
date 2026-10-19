const config = require('../../config/config');
const { applyMargin } = require('./margin');
const quoteStore = require('./quoteStore');
const { publicQuotes, friendlyBookMessage } = require('./publicQuote');
const {
  SPEED_LABEL,
  classifySpeed,
  minutesFromMeta,
  transitDaysFromMeta,
  normalizeOptions,
} = require('./speed');
const courierGuy = require('./courierGuy.adapter');
const uberDirect = require('./uberDirect.adapter');
const dhlExpress = require('./dhlExpress.adapter');
const fedex = require('./fedex.adapter');
const dsv = require('./dsv.adapter');

const sandbox = require('./sandbox.adapter');
const requestMode = require('../../utils/requestMode');

const adapters = [courierGuy, uberDirect, dhlExpress, fedex, dsv];

// Test-mode stores only ever see the simulated carrier; live stores never see it.
const adaptersFor = (livemode) => (livemode === false ? [sandbox] : adapters);
const getAdapter = (partnerId) => [...adapters, sandbox].find((adapter) => adapter.id === partnerId);

const unavailable = (adapter, error) => [
  {
    partnerId: adapter.id,
    partnerName: adapter.name,
    available: false,
    error,
  },
];

const priceOption = async (adapter, shipment, option, livemode) => {
  const priced = applyMargin(option.partnerPrice, config.margin);
  const stored = await quoteStore.put({
    partnerId: adapter.id,
    partnerName: adapter.name,
    shipment,
    ...option,
    ...priced,
    livemode: livemode !== false,
  });
  const speed = classifySpeed({
    partnerId: adapter.id,
    serviceName: option.serviceName,
    serviceCode: option.serviceCode,
  });
  const meta = option.meta || {};
  return {
    partnerId: adapter.id,
    partnerName: adapter.name,
    available: true,
    quoteId: stored.quoteId,
    expiresAt: option.expiresAt || stored.expiresAt,
    partnerPrice: priced.partnerPrice,
    marginAmount: priced.marginAmount,
    sellPrice: priced.sellPrice,
    currency: option.currency || 'ZAR',
    serviceName: option.serviceName,
    serviceCode: option.serviceCode,
    speed,
    speedLabel: SPEED_LABEL[speed],
    durationMinutes: minutesFromMeta(meta),
    pickupMinutes: Number.isFinite(Number(meta.pickupDuration)) ? Number(meta.pickupDuration) : null,
    transitDays: transitDaysFromMeta(meta),
    deliveryDate: meta.deliveryDate || null,
    error: null,
  };
};

const quoteAdapter = async (adapter, shipment, livemode) => {
  if (!adapter.isConfigured()) {
    return unavailable(adapter, 'Not configured. Add API credentials to the backend .env');
  }
  try {
    const raw = await adapter.quote(shipment);
    const options = normalizeOptions(raw).filter((row) => Number.isFinite(Number(row.partnerPrice)));
    if (!options.length) {
      return unavailable(adapter, 'No rates returned');
    }
    return Promise.all(options.map((option) => priceOption(adapter, shipment, option, livemode)));
  } catch (err) {
    return unavailable(adapter, err.message || 'Quote failed');
  }
};

// Unless told otherwise, quotes and bookings follow the current request's Test/Live mode.
const quoteAll = async (shipment, { livemode = requestMode.isLive() } = {}) => {
  const nested = await Promise.all(adaptersFor(livemode).map((adapter) => quoteAdapter(adapter, shipment, livemode)));
  const partners = nested.flat();
  const available = partners.filter((row) => row.available);
  available.sort((a, b) => a.sellPrice - b.sellPrice);
  const withDuration = available.filter((row) => Number.isFinite(row.durationMinutes) && row.durationMinutes > 0);
  const fastest = withDuration.length
    ? [...withDuration].sort((a, b) => a.durationMinutes - b.durationMinutes)[0]
    : null;
  return { partners, cheapest: available[0] || null, fastest };
};

const bookStoredQuote = async (quoteId, extras = {}) => {
  const stored = await quoteStore.get(quoteId);
  if (!stored) {
    throw new Error('Quote expired or not found. Request a new price.');
  }
  // A quote is only bookable in the mode it was issued in.
  const wantLive = extras.livemode === undefined ? requestMode.isLive() : extras.livemode !== false;
  if ((stored.livemode !== false) !== wantLive) {
    throw new Error('Quote expired or not found. Request a new price.');
  }
  const adapter = getAdapter(stored.partnerId);
  if (!adapter) {
    throw new Error(`Unknown partner ${stored.partnerId}`);
  }
  const shipment = {
    ...stored.shipment,
    pickupPhone: stored.shipment.pickupPhone || extras.pickupPhone,
    dropoffPhone: stored.shipment.dropoffPhone || extras.dropoffPhone,
    pickupName: stored.shipment.pickupName || extras.pickupName,
    dropoffName: stored.shipment.dropoffName || extras.dropoffName,
  };
  const booked = await adapter.book(shipment, stored);
  await quoteStore.consume(quoteId);
  return {
    ...booked,
    partnerId: stored.partnerId,
    partnerName: stored.partnerName,
    partnerPrice: stored.partnerPrice,
    marginAmount: stored.marginAmount,
    sellPrice: stored.sellPrice,
    currency: stored.currency,
    serviceName: stored.serviceName,
  };
};

module.exports = {
  adapters,
  sandbox,
  getAdapter,
  quoteAll,
  publicQuotes,
  bookStoredQuote,
  friendlyBookMessage,
};
