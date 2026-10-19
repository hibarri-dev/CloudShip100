const crypto = require('crypto');
const httpStatus = require('http-status');
const config = require('../../config/config');
const ApiError = require('../../utils/ApiError');
const { Booking } = require('../../models');
const logisticsClient = require('./logisticsClient.service');
const logger = require('../../config/logger');
const { getStripe } = require('./stripeClient');
const { progressTimeline, courierStatusToStage, bookingStatusFromStage } = require('../utils/shipmentProgress');

const OPEN_INTENT = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing']);

const applyCourierBookedStatus = (booking, courierStatus) => {
  const statusLabel = courierStatus || booking.courierStatus || 'collection-assigned';
  booking.courierStatus = statusLabel;
  const stage = courierStatusToStage(statusLabel) || 'booked';
  booking.status = bookingStatusFromStage(stage);
  booking.timeline = progressTimeline(booking.timeline, stage, new Date());
};

const createPaymentForBooking = async (booking) => {
  if (!booking) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Booking required');
  }
  if (booking.paymentStatus === 'paid') {
    return {
      mode: config.ecommerce.paymentMode,
      status: 'paid',
      paymentIntentId: booking.paymentIntentId,
      amount: booking.quotedPrice != null ? booking.quotedPrice : booking.value,
      currency: booking.currency || 'ZAR',
    };
  }

  const amount = booking.quotedPrice != null ? booking.quotedPrice : booking.value;
  const currency = (booking.currency || 'ZAR').toLowerCase();
  const mode = config.ecommerce.paymentMode;

  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return {
      mode: 'none',
      status: 'awaiting',
      amount: 0,
      currency: currency.toUpperCase(),
    };
  }

  if (mode === 'stripe') {
    if (!config.ecommerce.stripeSecretKey) {
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'STRIPE_SECRET_KEY not configured');
    }
    const stripe = getStripe();
    if (booking.paymentIntentId && !String(booking.paymentIntentId).startsWith('mock_')) {
      const existing = await stripe.paymentIntents.retrieve(booking.paymentIntentId);
      if (existing.status === 'succeeded') {
        return {
          mode: 'stripe',
          status: 'paid',
          paymentIntentId: existing.id,
          amount,
          currency: currency.toUpperCase(),
        };
      }
      if (
        OPEN_INTENT.has(existing.status) &&
        existing.client_secret &&
        existing.amount === Math.round(amount * 100) &&
        Array.isArray(existing.payment_method_types) &&
        existing.payment_method_types.length === 1 &&
        existing.payment_method_types[0] === 'card'
      ) {
        return {
          mode: 'stripe',
          status: 'awaiting',
          paymentIntentId: existing.id,
          clientSecret: existing.client_secret,
          publishableKey: config.ecommerce.stripePublishableKey,
          amount,
          currency: currency.toUpperCase(),
        };
      }
    }
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      payment_method_types: ['card'],
      metadata: {
        bookingId: String(booking.id || booking._id),
        bookingCode: booking.code,
      },
    });
    await Booking.updateOne(
      { _id: booking.id || booking._id },
      { paymentStatus: 'awaiting', paymentIntentId: intent.id }
    );
    return {
      mode: 'stripe',
      status: 'awaiting',
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      publishableKey: config.ecommerce.stripePublishableKey,
      amount,
      currency: currency.toUpperCase(),
    };
  }

  const paymentIntentId = `mock_pi_${crypto.randomBytes(10).toString('hex')}`;
  await Booking.updateOne(
    { _id: booking.id || booking._id },
    { paymentStatus: 'awaiting', paymentIntentId }
  );
  return {
    mode: 'mock',
    status: 'awaiting',
    paymentIntentId,
    confirmUrl: `/v1/ecommerce/payments/${paymentIntentId}/confirm`,
    amount,
    currency: currency.toUpperCase(),
  };
};

const confirmPaymentAndBook = async (paymentIntentId) => {
  // Payment confirmations can arrive outside a dashboard session, so look in both modes.
  const booking = await Booking.findOne({ paymentIntentId, livemode: { $in: [true, false] } });
  if (!booking) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Payment / booking not found');
  }
  if (booking.paymentStatus === 'paid' && booking.logisticsBookingRef) {
    return booking;
  }

  if (config.ecommerce.paymentMode === 'stripe' && !String(paymentIntentId).startsWith('mock_')) {
    if (!config.ecommerce.stripeSecretKey) {
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'STRIPE_SECRET_KEY not configured');
    }
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
      await Booking.updateOne({ _id: booking._id }, { paymentStatus: 'failed' });
      throw new ApiError(httpStatus.PAYMENT_REQUIRED, `Payment not succeeded (${intent.status})`);
    }
  }

  booking.paymentStatus = 'paid';
  await booking.save();

  if (!booking.logisticsBookingRef) {
    try {
      const booked = await logisticsClient.bookShipment({
        partner: booking.selectedPartner,
        service: booking.selectedService,
        pickup: booking.pickup,
        dropoff: booking.dropoff,
        weightKg: booking.weightKg,
        mode: booking.mode,
        cargo: booking.cargo,
        externalOrderId: booking.externalOrderId,
        livemode: booking.livemode !== false,
        buyerPhone: booking.buyerPhone,
        pickupName: booking.pickupName,
        logisticsQuoteId: booking.logisticsQuoteId,
        quoteSnapshot: {
          carrierCost: booking.carrierCost,
          marginAmount: booking.marginAmount,
          quotedPrice: booking.quotedPrice,
        },
      });
      booking.logisticsBookingRef = booked.bookingRef;
      booking.trackingNumber = booked.trackingNumber || null;
      booking.trackingUrl = booked.trackingUrl || booking.trackingUrl || null;
      booking.labelUrl = booked.labelUrl || null;
      booking.carrierShipmentId = booked.bookingRef || null;
      booking.partnerId = booked.partner || booking.selectedPartner;
      booking.serviceName = booked.service || booking.selectedService;
      applyCourierBookedStatus(booking, booked.courierStatus);
      await booking.save();
    } catch (err) {
      logger.error(`Logistics book failed after payment for ${booking.code}: ${err.message}`);
      booking.status = 'pending';
      await booking.save();
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Payment captured but courier booking failed. Ops must retry book'
      );
    }
  }

  return booking;
};

const paymentConfig = () => ({
  mode: config.ecommerce.paymentMode,
  publishableKey: config.ecommerce.stripePublishableKey || '',
  ready: config.ecommerce.paymentMode !== 'stripe' || Boolean(config.ecommerce.stripeSecretKey && config.ecommerce.stripePublishableKey),
});

module.exports = {
  createPaymentForBooking,
  confirmPaymentAndBook,
  paymentConfig,
};
