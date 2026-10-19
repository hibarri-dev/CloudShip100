const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const { companyService } = require('../services');
const storeConnectionService = require('../services/storeConnection.service');
const quoteBridge = require('../integrations/bridge/quoteBridge.service');
const paymentBridge = require('../integrations/bridge/paymentBridge.service');
const orderBridge = require('../integrations/bridge/orderBridge.service');
const { getAdapter } = require('../integrations/ecommerce');
const { displayShipmentStatus, displayShipmentLabel, progressTimeline } = require('../integrations/utils/shipmentProgress');
const carrierTracking = require('../integrations/bridge/carrierTracking.service');

const connectStore = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const connection = await storeConnectionService.createStoreConnection(company.id, req.body);
  res.status(httpStatus.CREATED).send(connection);
});

const listStores = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const rows = await storeConnectionService.listStoreConnections(company.id);
  res.send(rows);
});

const updateStore = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const connection = await storeConnectionService.updateStoreConnection(
    company.id,
    req.params.connectionId,
    req.body
  );
  res.send(connection);
});

const disconnectStore = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const connection = await storeConnectionService.disconnectStore(company.id, req.params.connectionId);
  res.send(connection);
});

/**
 * Authenticated marketplace quote (portal / testing). Public rates go through webhooks.
 */
const createQuote = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  let storeConnectionId = req.body.connectionId || null;
  let storeConnection = null;
  if (storeConnectionId) {
    storeConnection = await storeConnectionService.getStoreConnectionForCompany(company.id, storeConnectionId);
  }
  const quote = await quoteBridge.createMarketplaceQuote({
    ...req.body,
    storeConnection,
    storeConnectionId,
    companyId: company.id,
  });
  res.status(httpStatus.CREATED).send(quote);
});

const createPayment = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const { Booking } = require('../models');
  const booking = await Booking.findOne({
    _id: req.params.bookingId,
    company: company.id,
  });
  if (!booking) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found');
  }
  if (req.body && req.body.quoteId && req.body.partner) {
    await quoteBridge.applySelectedQuoteToBooking(booking, {
      quoteId: req.body.quoteId,
      partner: req.body.partner,
      service: req.body.service,
    });
  }
  const payment = await paymentBridge.createPaymentForBooking(booking);
  res.send(payment);
});

const getPaymentConfig = catchAsync(async (req, res) => {
  res.send(paymentBridge.paymentConfig());
});

const confirmPayment = catchAsync(async (req, res) => {
  const booking = await paymentBridge.confirmPaymentAndBook(req.params.paymentIntentId);
  await orderBridge.afterSuccessfulBook(booking);
  res.send(booking);
});

/**
 * Public tracking widget lookup (Stage 2 shortcode / iframe). No auth.
 * Returns only non-sensitive shipment fields.
 */
const publicTrack = catchAsync(async (req, res) => {
  const { Booking } = require('../models');
  const code = String(req.params.code || '').trim();
  if (!code) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Tracking token required');
  }
  // Test-mode shipments are trackable by their token too; `livemode` in the filter opts out of the live-only scope.
  const booking = await Booking.findOne({
    livemode: { $in: [true, false] },
    $or: [{ trackingToken: code }, { code }],
  });
  if (!booking) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Tracking not found');
  }
  await carrierTracking.refreshBookingTracking(booking);
  const status = displayShipmentStatus(booking);
  res.send({
    code: booking.code,
    status,
    statusLabel: displayShipmentLabel(booking),
    pickup: booking.pickup,
    dropoff: booking.dropoff,
    trackingNumber: booking.trackingNumber,
    trackingUrl: booking.trackingUrl || null,
    timeline: progressTimeline(booking.timeline, status),
    updatedAt: booking.updatedAt,
  });
});

/**
 * Manual order ingest for a connected store (useful for Lovable SDK + QA).
 */
const ingestOrder = catchAsync(async (req, res) => {
  const company = await companyService.getOrCreateCompanyForUser(req.user);
  const conn = await storeConnectionService.getStoreConnectionForCompany(
    company.id,
    req.params.connectionId
  );
  const adapter = getAdapter(conn.platform);
  const normalized = adapter.normalizeOrder(req.body, conn);
  const result = await orderBridge.ingestNormalizedOrder({
    storeConnection: conn,
    normalized,
    quoteId: req.body.quoteId,
    partner: req.body.partner,
    service: req.body.service,
  });
  res.status(result.duplicate ? httpStatus.OK : httpStatus.CREATED).send(result);
});

module.exports = {
  connectStore,
  listStores,
  updateStore,
  disconnectStore,
  createQuote,
  createPayment,
  confirmPayment,
  getPaymentConfig,
  ingestOrder,
  publicTrack,
};
