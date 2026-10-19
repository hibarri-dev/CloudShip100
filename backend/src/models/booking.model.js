const mongoose = require('mongoose');
const { toJSON, paginate, livemodeScope } = require('./plugins');

const lineItemSchema = mongoose.Schema(
  {
    name: { type: String, trim: true },
    quantity: { type: Number, default: 1 },
    total: { type: Number, default: null },
  },
  { _id: false }
);

const timelineStepSchema = mongoose.Schema(
  {
    stage: { type: String, required: true },
    label: { type: String, required: true },
    timestamp: { type: Date, default: null },
    done: { type: Boolean, default: false },
  },
  { _id: false }
);

const bookingSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Company',
      required: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    distanceKm: {
      type: Number,
      default: null,
    },
    durationMinutes: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'in_transit', 'completed', 'history'],
      default: 'pending',
    },
    mode: {
      type: String,
      enum: ['Road', 'Air', 'Maritime', 'Rail'],
      required: true,
    },
    cargo: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: Number,
      required: true,
    },
    pickup: {
      type: String,
      required: true,
      trim: true,
    },
    dropoff: {
      type: String,
      required: true,
      trim: true,
    },
    timeline: {
      type: [timelineStepSchema],
      default: [],
    },
    bookedAt: {
      type: Date,
      default: Date.now,
    },
    // Marketplace / e-commerce bridge fields (Pratik Stage 1)
    /** false = sandbox booking from a test-mode store: simulated carrier, hidden from live views, auto-deleted. */
    livemode: {
      type: Boolean,
      default: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['portal', 'woocommerce', 'shopify', 'wix', 'lovable', 'bigcommerce', 'api'],
      default: 'portal',
    },
    storeConnection: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'StoreConnection',
      default: null,
    },
    externalOrderId: {
      type: String,
      trim: true,
      default: null,
    },
    quoteId: {
      type: String,
      trim: true,
      default: null,
    },
    carrierCost: {
      type: Number,
      default: null,
    },
    marginAmount: {
      type: Number,
      default: null,
    },
    marginPercent: {
      type: Number,
      default: null,
    },
    quotedPrice: {
      type: Number,
      default: null,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'ZAR',
    },
    paymentStatus: {
      type: String,
      enum: ['not_required', 'awaiting', 'paid', 'failed', 'refunded'],
      default: 'not_required',
    },
    paymentIntentId: {
      type: String,
      trim: true,
      default: null,
    },
    postBookNotifiedAt: {
      type: Date,
      default: null,
    },
    logisticsBookingRef: {
      type: String,
      trim: true,
      default: null,
    },
    trackingNumber: {
      type: String,
      trim: true,
      default: null,
    },
    trackingToken: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    selectedPartner: {
      type: String,
      trim: true,
      default: null,
    },
    selectedService: {
      type: String,
      trim: true,
      default: null,
    },
    weightKg: {
      type: Number,
      default: null,
    },
    buyerEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    buyerPhone: {
      type: String,
      trim: true,
      default: null,
    },
    orderTotal: {
      type: Number,
      default: null,
    },
    itemsTotal: {
      type: Number,
      default: null,
    },
    shippingTotal: {
      type: Number,
      default: null,
    },
    lineItems: {
      type: [lineItemSchema],
      default: [],
    },
    logisticsQuoteId: { type: String, default: null, trim: true },
    shopMarginAmount: { type: Number, default: 0 },
    pickupName: { type: String, default: null, trim: true },
    // Carrier partner fields (Vasanth logistics integrations)
    partnerId: { type: String, default: null, trim: true },
    partnerName: { type: String, default: null, trim: true },
    partnerPrice: { type: Number, default: null },
    trackingUrl: { type: String, default: null, trim: true },
    courierStatus: { type: String, default: null, trim: true },
    lastPushedCourierStatus: { type: String, default: null, trim: true },
    lastNotifiedStatus: { type: String, default: null, trim: true },
    carrierShipmentId: { type: String, default: null, trim: true },
    labelUrl: { type: String, default: null, trim: true },
    serviceName: { type: String, default: null, trim: true },
  },
  {
    timestamps: true,
  }
);

bookingSchema.index(
  { source: 1, externalOrderId: 1, storeConnection: 1 },
  {
    unique: true,
    partialFilterExpression: { externalOrderId: { $type: 'string' } },
  }
);

bookingSchema.index({ paymentIntentId: 1 }, { sparse: true });
// Sandbox data is disposable.
bookingSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { livemode: false } });

bookingSchema.plugin(toJSON);
bookingSchema.plugin(paginate);
bookingSchema.plugin(livemodeScope);

/**
 * @typedef Booking
 */
const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking;
