const httpStatus = require('http-status');
const config = require('../../config/config');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const carriers = require('../../services/carriers');
const { courierStatusToStage } = require('../utils/shipmentProgress');

/**
 * Shop plugins (Pratik) talk to this client. In the same process we call Vasanth's
 * live courier adapters. HTTP LOGISTICS_API_URL is only for a split deploy.
 *
 * Contract:
 *  getQuotes → { options: [{ partner, service, price, currency, etaHours, quoteId }] }
 *    price is the courier cost. Quote bridge adds the 10% CloudShip cut.
 *  bookShipment → { bookingRef, trackingNumber, labelUrl? }
 */

/**
 * Dummy rates for automated tests only. Never shown in development or production —
 * unconfigured carriers (DHL, DSV, …) must not appear as live bookable cards.
 */
const stubQuotes = ({ pickup, dropoff, weightKg }) => {
  const base = 45 + Number(weightKg || 1) * 8;
  const distanceFactor = Math.min(String(pickup || '').length + String(dropoff || '').length, 40);
  const courierGuy = Math.round((base + distanceFactor * 0.5) * 100) / 100;
  return {
    options: [
      {
        partner: 'courier_guy',
        service: 'standard',
        price: courierGuy,
        currency: 'ZAR',
        etaHours: 48,
      },
      {
        partner: 'uber_direct',
        service: 'same_day',
        price: Math.round(courierGuy * 1.65 * 100) / 100,
        currency: 'ZAR',
        etaHours: 4,
      },
      {
        partner: 'dhl_express',
        service: 'express',
        price: Math.round(courierGuy * 2.4 * 100) / 100,
        currency: 'ZAR',
        etaHours: 72,
      },
    ],
  };
};

const etaHoursFromRow = (row) => {
  if (Number.isFinite(row.durationMinutes) && row.durationMinutes > 0) {
    return Math.round((row.durationMinutes / 60) * 10) / 10;
  }
  if (Number.isFinite(row.transitDays) && row.transitDays > 0) {
    return row.transitDays * 24;
  }
  return null;
};

const toLogisticsOptions = (quoted) => {
  const rows = (quoted && quoted.partners) || [];
  return {
    options: rows
      .filter((row) => row && row.available && Number.isFinite(Number(row.partnerPrice)))
      .map((row) => ({
        partner: row.partnerId,
        service: row.serviceName || row.serviceCode || row.partnerId,
        price: Number(row.partnerPrice),
        currency: (row.currency || 'ZAR').toUpperCase(),
        etaHours: etaHoursFromRow(row),
        quoteId: row.quoteId || null,
      })),
    skipped: rows
      .filter((row) => row && !row.available && row.error)
      .reduce((list, row) => {
        if (list.some((item) => item.partner === row.partnerId)) return list;
        return list.concat({ partner: row.partnerId, error: row.error });
      }, []),
  };
};

const shipmentFromParams = (params = {}) => ({
  pickup: params.pickup,
  dropoff: params.dropoff,
  weightKg: params.weightKg,
  mode: params.mode || 'Road',
  lengthCm: params.lengthCm,
  widthCm: params.widthCm,
  heightCm: params.heightCm,
  pickupDate: params.pickupDate,
  pickupPhone: params.pickupPhone || params.buyerPhone,
  dropoffPhone: params.dropoffPhone || params.buyerPhone,
  cargo: params.cargo || params.externalOrderId,
});

const liveQuotes = async (params) => {
  const quoted = await carriers.quoteAll(shipmentFromParams(params), { livemode: params.livemode });
  return toLogisticsOptions(quoted);
};

const matchPartnerOption = (quoted, partner, service) => {
  const available = (quoted.partners || []).filter((row) => row.available);
  if (partner === 'shop_table') {
    return available[0] || null;
  }
  const byPartner = available.filter((row) => row.partnerId === partner);
  const pool = byPartner.length ? byPartner : available;
  if (service) {
    const match = pool.find(
      (row) => row.serviceName === service || row.serviceCode === service || row.serviceName === `${service}`
    );
    if (match) return match;
  }
  return pool[0] || null;
};

const toBooked = (booked) => ({
  bookingRef: booked.carrierShipmentId || booked.trackingNumber,
  trackingNumber: booked.trackingNumber || booked.carrierShipmentId,
  trackingUrl: booked.trackingUrl || null,
  labelUrl: booked.labelUrl || null,
  courierStatus: booked.courierStatus || null,
  partner: booked.partnerId,
  service: booked.serviceName,
});

const liveBook = async (params) => {
  const extras = {
    pickupPhone: params.pickupPhone || params.buyerPhone,
    dropoffPhone: params.dropoffPhone || params.buyerPhone,
    dropoffName: params.dropoffName,
    pickupName: params.pickupName,
    livemode: params.livemode,
  };
  if (params.logisticsQuoteId) {
    try {
      return toBooked(await carriers.bookStoredQuote(params.logisticsQuoteId, extras));
    } catch (err) {
      logger.warn(`Live quote ${params.logisticsQuoteId} could not be booked (${err.message}); requesting a fresh rate`);
    }
  }
  const quoted = await carriers.quoteAll(shipmentFromParams(params), { livemode: params.livemode });
  const match = matchPartnerOption(quoted, params.partner, params.service);
  if (!match || !match.quoteId) {
    throw new Error('No live courier rate for that partner');
  }
  return toBooked(await carriers.bookStoredQuote(match.quoteId, extras));
};

const requestJson = async (method, path, body) => {
  const base = config.ecommerce.logisticsApiUrl;
  if (!base) {
    return null;
  }
  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(config.ecommerce.logisticsApiKey
      ? { Authorization: `Bearer ${config.ecommerce.logisticsApiKey}` }
      : {}),
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error(`Logistics API ${method} ${path} failed: ${res.status} ${text}`);
    throw new ApiError(httpStatus.BAD_GATEWAY, `Logistics partner API error (${res.status})`);
  }
  return res.json();
};

const useLiveCarriers = () => config.env !== 'test';

const getQuotes = async (params) => {
  if (useLiveCarriers()) {
    try {
      return await liveQuotes(params);
    } catch (err) {
      logger.error(`Live courier quotes failed: ${err.message}`);
    }
  }
  const remote = await requestJson('POST', '/quotes', params);
  if (remote && Array.isArray(remote.options) && remote.options.length) {
    return remote;
  }
  if (config.ecommerce.logisticsApiUrl && !remote) {
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Logistics quotes unavailable');
  }
  if (useLiveCarriers()) {
    return { options: [], skipped: [] };
  }
  return stubQuotes(params);
};

const bookShipment = async (params) => {
  if (useLiveCarriers()) {
    try {
      return await liveBook(params);
    } catch (err) {
      logger.error(`Live courier book failed: ${err.message}`);
      throw new ApiError(httpStatus.BAD_GATEWAY, err.message || 'Logistics booking failed');
    }
  }
  const remote = await requestJson('POST', '/book', params);
  if (remote && remote.bookingRef) {
    return remote;
  }
  if (config.ecommerce.logisticsApiUrl) {
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Logistics booking failed');
  }
  const ref = `STUB-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
  return {
    bookingRef: ref,
    trackingNumber: `TRK-${ref}`,
    labelUrl: null,
    partner: params.partner,
    service: params.service,
    courierStatus: 'collection-assigned',
    stub: true,
  };
};

const getTracking = async ({ bookingRef, trackingNumber, partner } = {}) => {
  const adapter = partner ? carriers.getAdapter(partner) : null;
  if (adapter && typeof adapter.track === 'function') {
    const tracked = await adapter.track({ trackingNumber, carrierShipmentId: bookingRef });
    return {
      status: courierStatusToStage(tracked.courierStatus) || tracked.courierStatus,
      courierStatus: tracked.courierStatus,
      trackingNumber: tracked.trackingNumber || trackingNumber || bookingRef,
      events: tracked.events || [],
    };
  }
  const remote = await requestJson('GET', `/tracking/${encodeURIComponent(bookingRef)}`);
  if (remote) return remote;
  return {
    status: 'booked',
    courierStatus: 'collection-assigned',
    trackingNumber: bookingRef,
    events: [],
    stub: true,
  };
};

module.exports = {
  getQuotes,
  bookShipment,
  getTracking,
  stubQuotes,
  toLogisticsOptions,
};
