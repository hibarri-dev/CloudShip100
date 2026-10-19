const crypto = require('crypto');
const httpStatus = require('http-status');
const { ShipmentQuote, StoreConnection } = require('../../models');
const ApiError = require('../../utils/ApiError');
const config = require('../../config/config');
const logisticsClient = require('./logisticsClient.service');
const { applyMargin } = require('./margin.service');
const shopPricing = require('./shopPricing.service');
const requestMode = require('../../utils/requestMode');

const buildQuoteId = () => `qt_${crypto.randomBytes(12).toString('hex')}`;

const loadSettings = async (input) => {
  if (input.storeConnection && input.storeConnection.settings) {
    return shopPricing.settingsOf(input.storeConnection);
  }
  if (!input.storeConnectionId) return {};
  const conn = await StoreConnection.findById(input.storeConnectionId);
  return shopPricing.settingsOf(conn);
};

const priceLiveOption = (opt, currency, extraPercent) => {
  const money = applyMargin(opt.price);
  const shop = shopPricing.applyShopMarkup(money.quotedPrice, extraPercent);
  return {
    partner: opt.partner,
    service: opt.service,
    carrierCost: money.carrierCost,
    marginAmount: money.marginAmount,
    marginPercent: money.marginPercent,
    shopMarginAmount: shop.shopMarginAmount,
    shopMarginPercent: shop.shopMarginPercent,
    quotedPrice: shop.quotedPrice,
    etaHours: opt.etaHours != null ? opt.etaHours : null,
    currency: (opt.currency || currency).toUpperCase(),
    logisticsQuoteId: opt.quoteId || null,
  };
};

const tableOptions = (settings, liveOptions, shipment, currency) => {
  const cheapestLive = liveOptions.reduce(
    (best, cur) => (cur.quotedPrice < best.quotedPrice ? cur : best),
    liveOptions[0]
  );
  if (!cheapestLive) return [];
  const floor = cheapestLive.quotedPrice - (cheapestLive.shopMarginAmount || 0);
  return shopPricing.matchingTableRates(settings, shipment).flatMap((rate) => {
    const price = shopPricing.roundMoney(rate.price);
    if (price < floor) return [];
    return [
      {
        partner: 'shop_table',
        service: rate.label || 'Standard shipping',
        carrierCost: cheapestLive.carrierCost,
        marginAmount: cheapestLive.marginAmount,
        marginPercent: cheapestLive.marginPercent,
        shopMarginAmount: shopPricing.roundMoney(price - cheapestLive.carrierCost - cheapestLive.marginAmount),
        shopMarginPercent: 0,
        quotedPrice: price,
        etaHours: cheapestLive.etaHours,
        currency,
        logisticsQuoteId: cheapestLive.logisticsQuoteId || null,
      },
    ];
  });
};

const createMarketplaceQuote = async (input) => {
  const dropoff = String(input.dropoff || '').trim();
  const weightKg = Number(input.weightKg);
  const mode = input.mode || 'Road';
  const currency = (input.currency || 'ZAR').toUpperCase();
  const settings = await loadSettings(input);

  if (!dropoff) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'pickup and dropoff are required');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'weightKg must be > 0');
  }

  const resolved = await shopPricing.resolvePickup({
    settings,
    fallbackPickup: input.pickup,
    dropoff,
    lockPickup: Boolean(input.lockPickup || input.pickupLocked),
  });
  const pickup = resolved.address;
  if (!pickup) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'pickup and dropoff are required');
  }

  const raw = await logisticsClient.getQuotes({
    pickup,
    dropoff,
    weightKg,
    currency,
    mode: settings.defaultMode || mode,
  });

  const extraPercent = settings.extraMarginPercent != null ? settings.extraMarginPercent : 0;
  let options = (raw.options || []).map((opt) => priceLiveOption(opt, currency, extraPercent));
  options = options.concat(tableOptions(settings, options, { weightKg, dropoff }, currency));
  options = options.map((opt) => ({ ...opt, pickupName: resolved.name }));

  if (!options.length) {
    return {
      quoteId: null,
      expiresAt: null,
      pickup,
      pickupName: resolved.name,
      dropoff,
      weightKg,
      mode: settings.defaultMode || mode,
      currency: (settings.currency || currency).toUpperCase(),
      options: [],
      skipped: raw.skipped || [],
      selected: null,
    };
  }

  let selected = options[0];
  if (input.preferredPartner) {
    const match = options.find((o) => o.partner === input.preferredPartner);
    if (match) selected = match;
  }
  if (!input.preferredPartner) {
    selected = options.reduce((best, cur) => (cur.quotedPrice < best.quotedPrice ? cur : best), options[0]);
  }

  const ttlMin = config.ecommerce.quoteTtlMinutes;
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
  const quoteId = buildQuoteId();

  const doc = await ShipmentQuote.create({
    quoteId,
    livemode: requestMode.isLive(),
    storeConnection: input.storeConnectionId || null,
    company: input.companyId || null,
    pickup,
    dropoff,
    weightKg,
    mode: settings.defaultMode || mode,
    currency: (settings.currency || currency).toUpperCase(),
    options,
    selectedPartner: selected.partner,
    selectedService: selected.service,
    logisticsQuoteId: selected.logisticsQuoteId || null,
    carrierCost: selected.carrierCost,
    marginAmount: selected.marginAmount,
    marginPercent: selected.marginPercent,
    quotedPrice: selected.quotedPrice,
    shopMarginAmount: selected.shopMarginAmount || 0,
    pickupName: resolved.name,
    expiresAt,
  });

  return {
    quoteId: doc.quoteId,
    expiresAt: doc.expiresAt,
    pickup: doc.pickup,
    pickupName: resolved.name,
    dropoff: doc.dropoff,
    weightKg: doc.weightKg,
    mode: doc.mode,
    currency: doc.currency,
    options,
    skipped: raw.skipped || [],
    selected: {
      partner: selected.partner,
      service: selected.service,
      carrierCost: selected.carrierCost,
      marginAmount: selected.marginAmount,
      marginPercent: selected.marginPercent,
      shopMarginAmount: selected.shopMarginAmount || 0,
      quotedPrice: selected.quotedPrice,
      etaHours: selected.etaHours,
      currency: selected.currency,
      logisticsQuoteId: selected.logisticsQuoteId || null,
    },
  };
};

const getValidQuote = async (quoteId, select = {}) => {
  const doc = await ShipmentQuote.findOne({ quoteId });
  if (!doc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Quote not found');
  }
  if (doc.consumedAt) {
    throw new ApiError(httpStatus.CONFLICT, 'Quote already used');
  }
  if (doc.expiresAt.getTime() < Date.now()) {
    throw new ApiError(httpStatus.GONE, 'Quote expired. Request a new rate');
  }

  let carrierCost = doc.carrierCost;
  let marginAmount = doc.marginAmount;
  let marginPercent = doc.marginPercent;
  let quotedPrice = doc.quotedPrice;
  let partner = doc.selectedPartner;
  let service = doc.selectedService;
  let logisticsQuoteId = doc.logisticsQuoteId || null;
  let shopMarginAmount = doc.shopMarginAmount || 0;

  if (select.partner) {
    const opt = (doc.options || []).find(
      (o) => o.partner === select.partner && (!select.service || o.service === select.service)
    );
    if (!opt) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Selected partner/service not in quote');
    }
    carrierCost = opt.carrierCost;
    marginAmount = opt.marginAmount;
    marginPercent = opt.marginPercent;
    quotedPrice = opt.quotedPrice;
    partner = opt.partner;
    service = opt.service;
    logisticsQuoteId = opt.logisticsQuoteId || null;
    shopMarginAmount = opt.shopMarginAmount || 0;
  }

  return {
    doc,
    carrierCost,
    marginAmount,
    marginPercent,
    quotedPrice,
    partner,
    service,
    logisticsQuoteId,
    shopMarginAmount,
    pickupName: doc.pickupName,
    pickup: doc.pickup,
  };
};

const markQuoteConsumed = async (quoteId) => {
  await ShipmentQuote.updateOne({ quoteId }, { consumedAt: new Date() });
};

const applySelectedQuoteToBooking = async (booking, { quoteId, partner, service } = {}) => {
  if (!booking) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Booking required');
  }
  if (booking.paymentStatus === 'paid' || booking.logisticsBookingRef) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot change courier after payment');
  }
  if (!quoteId || !partner) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'quoteId and partner are required');
  }
  const q = await getValidQuote(quoteId, { partner, service });
  booking.quoteId = quoteId;
  booking.selectedPartner = q.partner;
  booking.selectedService = q.service;
  booking.carrierCost = q.carrierCost;
  booking.marginAmount = q.marginAmount;
  booking.marginPercent = q.marginPercent;
  booking.quotedPrice = q.quotedPrice;
  booking.value = q.quotedPrice;
  booking.shopMarginAmount = q.shopMarginAmount || 0;
  booking.logisticsQuoteId = q.logisticsQuoteId || null;
  booking.pickupName = q.pickupName || booking.pickupName;
  if (q.pickup) booking.pickup = q.pickup;
  await booking.save();
  return booking;
};

module.exports = {
  createMarketplaceQuote,
  getValidQuote,
  markQuoteConsumed,
  applySelectedQuoteToBooking,
  buildQuoteId,
};
