const Joi = require('joi');
const { objectId } = require('./custom.validation');

const connectStore = {
  body: Joi.object().keys({
    platform: Joi.string().valid('woocommerce', 'shopify', 'wix', 'lovable', 'bigcommerce').required(),
    storeName: Joi.string().required(),
    storeUrl: Joi.string().allow('').optional(),
    credentials: Joi.object().required(),
    webhookSecret: Joi.string().allow('').optional(),
    livemode: Joi.boolean().optional(),
    settings: Joi.object()
      .keys({
        autoBookOnPaid: Joi.boolean(),
        defaultMode: Joi.string().valid('Road', 'Air', 'Maritime', 'Rail'),
        currency: Joi.string().length(3),
        pickupAddress: Joi.string().allow(''),
        extraMarginPercent: Joi.number().min(0).max(200),
        pickupStrategy: Joi.string().valid('fixed', 'closest'),
        pickupLocations: Joi.array().items(
          Joi.object().keys({
            name: Joi.string().allow(''),
            address: Joi.string().required(),
            street: Joi.string().allow(''),
            city: Joi.string().allow(''),
            state: Joi.string().allow(''),
            postalCode: Joi.string().allow(''),
            country: Joi.string().allow(''),
            isDefault: Joi.boolean(),
          })
        ),
        tableRates: Joi.array().items(
          Joi.object().keys({
            label: Joi.string().allow(''),
            minWeightKg: Joi.number().min(0),
            maxWeightKg: Joi.number().min(0).allow(null),
            country: Joi.string().allow(''),
            price: Joi.number().min(0).required(),
          })
        ),
        paymentRules: Joi.object().keys({
          collectAtCheckout: Joi.boolean(),
          autoBookOnPaid: Joi.boolean(),
        }),
      })
      .optional(),
  }),
};

const updateStore = {
  params: Joi.object().keys({
    connectionId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      storeName: Joi.string(),
      storeUrl: Joi.string().allow(''),
      status: Joi.string().valid('active', 'paused', 'disconnected'),
      credentials: Joi.object(),
      webhookSecret: Joi.string(),
      settings: Joi.object(),
    })
    .min(1),
};

const connectionIdParam = {
  params: Joi.object().keys({
    connectionId: Joi.string().custom(objectId).required(),
  }),
};

const marketplaceQuote = {
  body: Joi.object().keys({
    connectionId: Joi.string().custom(objectId).optional(),
    pickup: Joi.string().required(),
    dropoff: Joi.string().required(),
    weightKg: Joi.number().positive().required(),
    mode: Joi.string().valid('Road', 'Air', 'Maritime', 'Rail'),
    currency: Joi.string().length(3),
    preferredPartner: Joi.string(),
    lockPickup: Joi.boolean(),
    pickupLocked: Joi.boolean(),
    pickupName: Joi.string().allow(''),
  }),
};

const confirmPayment = {
  params: Joi.object().keys({
    paymentIntentId: Joi.string().required(),
  }),
};

const createPayment = {
  params: Joi.object().keys({
    bookingId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    quoteId: Joi.string(),
    partner: Joi.string(),
    service: Joi.string(),
  }),
};

module.exports = {
  connectStore,
  updateStore,
  connectionIdParam,
  marketplaceQuote,
  confirmPayment,
  createPayment,
};
