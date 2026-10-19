const crypto = require('crypto');
const httpStatus = require('http-status');
const { Booking, Contract, Invoice, PaymentRequest, Notification } = require('../models');
const pricingService = require('./pricing.service');
const carriers = require('./carriers');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const { progressTimeline, courierStatusToStage, bookingStatusFromStage } = require('../integrations/utils/shipmentProgress');
const { generateTrackingToken } = require('../utils/trackingToken');
const emailService = require('./email.service');

const TIMELINE_STAGE_ORDER = ['booked', 'warehouse', 'in_transit', 'out_for_delivery', 'delivered'];

const TIMELINE_TEMPLATE = [
  { stage: 'booked', label: 'Booked' },
  { stage: 'warehouse', label: 'Warehouse' },
  { stage: 'in_transit', label: 'In Transit' },
  { stage: 'out_for_delivery', label: 'Out for Delivery' },
  { stage: 'delivered', label: 'Delivered' },
];

/**
 * Get all bookings for a company
 * @param {ObjectId} companyId
 * @returns {Promise<Booking[]>}
 */
const queryBookingsByCompany = async (companyId) => {
  return Booking.find({ company: companyId }).sort('-bookedAt');
};

/**
 * Operator list of all bookings, optionally filtered by status.
 * `history` includes both completed and history statuses.
 * @param {string} [status]
 * @returns {Promise<Booking[]>}
 */
const queryAllBookings = async (status) => {
  const filter = {};
  if (status === 'history') {
    filter.status = { $in: ['completed', 'history'] };
  } else if (status) {
    filter.status = status;
  }
  return Booking.find(filter).populate('company', 'name').sort('-bookedAt');
};

const generateBookingCode = async (prefix = 'BKG') => {
  for (let i = 0; i < 8; i += 1) {
    const code = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const exists = await Booking.exists({ code, livemode: { $in: [true, false] } });
    if (!exists) return code;
  }
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};

/**
 * Create a booking: quote via the pricing engine when weight is given, generate the matching
 * Contract / Invoice / PaymentRequest / Notification, and ingest an expected inbound parcel
 * so warehouse receiving still has to confirm arrival.
 * @param {Company} company
 * @param {Object} body - { pickup, dropoff, cargo, mode, weightKg?, value? }
 * @returns {Promise<Booking>}
 */
const createBooking = async (company, body, actor = {}) => {
  if (actor.role === 'customer' && body.value != null && !body.quoteId && !(Number(body.weightKg) > 0)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Get a live quote before booking. Customer price is not accepted.');
  }
  const { pickup, dropoff, cargo, weightKg, mode, quoteId } = body;
  const value = actor.role === 'customer' ? undefined : body.value;

  let quotedPickup = pickup;
  let quotedDropoff = dropoff;
  let price = value;
  let distanceKm = null;
  let durationMinutes = null;
  let partnerFields = {};

  if (quoteId) {
    try {
      const booked = await carriers.bookStoredQuote(quoteId, {
        pickupPhone: company.phone,
        dropoffPhone: company.phone,
        pickupName: company.name,
        dropoffName: cargo,
      });
      price = booked.sellPrice;
      partnerFields = {
        partnerId: booked.partnerId,
        partnerName: booked.partnerName,
        quoteId,
        partnerPrice: booked.partnerPrice,
        marginAmount: booked.marginAmount,
        trackingNumber: booked.trackingNumber || null,
        trackingUrl: booked.trackingUrl || null,
        carrierShipmentId: booked.carrierShipmentId || null,
        labelUrl: booked.labelUrl || null,
        serviceName: booked.serviceName || null,
        courierStatus: booked.courierStatus || 'collection-assigned',
      };
    } catch (err) {
      logger.error(err);
      throw new ApiError(httpStatus.BAD_REQUEST, carriers.friendlyBookMessage(err.message));
    }
  } else if (weightKg) {
    const quote = await pricingService.getQuote({ pickup, dropoff, weightKg, mode });
    quotedPickup = quote.pickup;
    quotedDropoff = quote.dropoff;
    price = quote.price;
    distanceKm = quote.distanceKm;
    durationMinutes = quote.durationMinutes;
  }

  if (price == null) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'quoteId, weightKg or value is required');
  }

  const code = await generateBookingCode();
  const now = new Date();
  const stage = courierStatusToStage(partnerFields.courierStatus) || (partnerFields.trackingNumber ? 'booked' : 'pending');
  const status = bookingStatusFromStage(stage);
  const timeline = progressTimeline(
    TIMELINE_TEMPLATE.map((step, i) => ({
      ...step,
      timestamp: i === 0 ? now : null,
      done: i === 0,
    })),
    stage === 'pending' ? 'booked' : stage,
    now
  );

  const booking = await Booking.create({
    company: company.id,
    code,
    trackingToken: generateTrackingToken(),
    status,
    mode,
    cargo,
    value: price,
    pickup: quotedPickup,
    dropoff: quotedDropoff,
    distanceKm,
    durationMinutes,
    timeline,
    bookedAt: now,
    lastNotifiedStatus: 'booked',
    ...partnerFields,
  });

  const dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await Contract.create({
    company: company.id,
    booking: booking.id,
    title: `${mode} Freight — ${quotedPickup} to ${quotedDropoff}`,
    price,
    pickup: quotedPickup,
    destination: quotedDropoff,
    terms: `Payment due within 7 days of delivery. Carrier liable for damage up to contract value. Booking reference ${code}.`,
    status: 'pending_signature',
    startDate: now,
    endDate: dueDate,
  });

  const invoice = await Invoice.create({
    company: company.id,
    booking: booking.id,
    amount: price,
    status: 'Open',
    due: dueDate,
  });

  await PaymentRequest.create({
    company: company.id,
    invoice: invoice.id,
    amount: price,
    dueDate,
    status: 'due',
  });

  await Notification.create({
    company: company.id,
    title: `Booking ${code} confirmed`,
    body: `Your shipment from ${quotedPickup} to ${quotedDropoff} has been booked${
      partnerFields.partnerName ? ` with ${partnerFields.partnerName}` : ''
    }. Price ${Number(price).toFixed(2)}.`,
    type: 'booking',
    unread: true,
  });

  // Lazy require avoids a cycle: warehouse.service -> bookingSync.service -> booking.service.
  // eslint-disable-next-line global-require
  const warehouseService = require('./warehouse.service');
  await warehouseService.ingestBooking(booking, company, { weightKg });

  const to = company.email;
  await emailService.sendBookingConfirmationEmail({ booking, to });

  return booking;
};

module.exports = {
  queryBookingsByCompany,
  queryAllBookings,
  createBooking,
  TIMELINE_STAGE_ORDER,
};
