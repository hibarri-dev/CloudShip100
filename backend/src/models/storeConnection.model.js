const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const storeConnectionSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['woocommerce', 'shopify', 'wix', 'lovable', 'bigcommerce'],
      required: true,
    },
    storeName: {
      type: String,
      required: true,
      trim: true,
    },
    storeUrl: {
      type: String,
      trim: true,
      default: '',
    },
    /** Encrypted blob — never return raw secrets via API */
    credentialsEncrypted: {
      type: String,
      required: true,
      private: true,
    },
    webhookSecret: {
      type: String,
      trim: true,
      default: '',
      private: true,
    },
    /** Public key merchants embed (Lovable / universal SDK) */
    publicApiKey: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    /** false = test-mode store (cs_test_ key): simulated carriers, no invoicing approval, hidden from live views. Fixed at creation. */
    livemode: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'disconnected'],
      default: 'active',
    },
    settings: {
      autoBookOnPaid: { type: Boolean, default: true },
      defaultMode: {
        type: String,
        enum: ['Road', 'Air', 'Maritime', 'Rail'],
        default: 'Road',
      },
      currency: { type: String, default: 'ZAR', uppercase: true },
      pickupAddress: { type: String, trim: true, default: '' },
      extraMarginPercent: { type: Number, default: 0, min: 0 },
      pickupStrategy: { type: String, enum: ['fixed', 'closest'], default: 'fixed' },
          pickupLocations: [
            {
              name: { type: String, trim: true, default: 'Warehouse' },
              address: { type: String, trim: true, required: true },
              street: { type: String, trim: true, default: '' },
              city: { type: String, trim: true, default: '' },
              state: { type: String, trim: true, default: '' },
              postalCode: { type: String, trim: true, default: '' },
              country: { type: String, trim: true, uppercase: true, default: 'ZA' },
              isDefault: { type: Boolean, default: false },
            },
          ],
      tableRates: [
        {
          label: { type: String, trim: true, default: 'Standard shipping' },
          minWeightKg: { type: Number, default: 0 },
          maxWeightKg: { type: Number, default: null },
          country: { type: String, trim: true, uppercase: true, default: '' },
          price: { type: Number, required: true },
        },
      ],
      paymentRules: {
        collectAtCheckout: { type: Boolean, default: true },
        autoBookOnPaid: { type: Boolean, default: true },
      },
    },
    lastWebhookAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

storeConnectionSchema.index({ company: 1, platform: 1, storeUrl: 1 });

storeConnectionSchema.plugin(toJSON);
storeConnectionSchema.plugin(paginate);

/**
 * @typedef StoreConnection
 */
const StoreConnection = mongoose.model('StoreConnection', storeConnectionSchema);

module.exports = StoreConnection;
