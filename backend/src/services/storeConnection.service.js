const httpStatus = require('http-status');
const crypto = require('crypto');
const { StoreConnection } = require('../models');
const ApiError = require('../utils/ApiError');
const { encryptCredentials, randomApiKey } = require('../integrations/utils/crypto.util');
const requestMode = require('../utils/requestMode');

/**
 * Connect a shop for a company. Credentials encrypted at rest.
 */
const createStoreConnection = async (companyId, body) => {
  const {
    platform,
    storeName,
    storeUrl,
    credentials,
    webhookSecret,
    settings,
  } = body;
  // New stores belong to the mode the dashboard is in, unless the API caller says otherwise.
  const livemode = body.livemode === undefined ? requestMode.isLive() : body.livemode !== false;
  if (!livemode && platform !== 'lovable') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Test mode is only available for Lovable / Universal stores. Switch to Live mode to connect other platforms.');
  }

  if (!credentials || typeof credentials !== 'object') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'credentials object is required');
  }

  const publicApiKey = platform === 'lovable' ? randomApiKey(livemode ? 'cs_live' : 'cs_test') : undefined;
  const secret = webhookSecret || crypto.randomBytes(24).toString('hex');

  const doc = await StoreConnection.create({
    company: companyId,
    platform,
    storeName,
    storeUrl: storeUrl || '',
    credentialsEncrypted: encryptCredentials(credentials),
    webhookSecret: secret,
    publicApiKey,
    livemode,
    settings: {
      autoBookOnPaid: settings && settings.autoBookOnPaid != null ? settings.autoBookOnPaid : true,
      defaultMode: (settings && settings.defaultMode) || 'Road',
      currency: (settings && settings.currency) || 'ZAR',
      pickupAddress: (settings && settings.pickupAddress) || credentials.pickupAddress || '',
      extraMarginPercent: settings && settings.extraMarginPercent != null ? settings.extraMarginPercent : 0,
      pickupStrategy: (settings && settings.pickupStrategy) || 'fixed',
      pickupLocations:
        (settings && settings.pickupLocations && settings.pickupLocations.length
          ? settings.pickupLocations
          : [{ name: 'Main warehouse', address: (settings && settings.pickupAddress) || credentials.pickupAddress || '', isDefault: true }]
        ).filter((row) => row && row.address),
      tableRates: (settings && settings.tableRates) || [],
      paymentRules: {
        collectAtCheckout: !(settings && settings.paymentRules && settings.paymentRules.collectAtCheckout === false),
        autoBookOnPaid: !(settings && settings.paymentRules && settings.paymentRules.autoBookOnPaid === false),
      },
    },
    status: 'active',
  });

  return sanitizeConnection(doc, { includeSecrets: true });
};

const listStoreConnections = async (companyId) => {
  const rows = await StoreConnection.find({
    company: companyId,
    livemode: requestMode.isLive() ? { $ne: false } : false,
  }).sort('-createdAt');
  return rows.map((d) => sanitizeConnection(d));
};

const getStoreConnectionForCompany = async (companyId, connectionId) => {
  const doc = await StoreConnection.findOne({ _id: connectionId, company: companyId });
  if (!doc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Store connection not found');
  }
  return doc;
};

const updateStoreConnection = async (companyId, connectionId, body) => {
  const doc = await getStoreConnectionForCompany(companyId, connectionId);
  if (body.storeName) doc.storeName = body.storeName;
  if (body.storeUrl != null) doc.storeUrl = body.storeUrl;
  if (body.status) doc.status = body.status;
  if (body.webhookSecret) doc.webhookSecret = body.webhookSecret;
  if (body.credentials) {
    doc.credentialsEncrypted = encryptCredentials(body.credentials);
  }
  if (body.settings) {
    doc.settings = {
      ...((doc.settings && doc.settings.toObject && doc.settings.toObject()) || doc.settings || {}),
      ...body.settings,
    };
  }
  await doc.save();
  return sanitizeConnection(doc);
};

const disconnectStore = async (companyId, connectionId) => {
  const doc = await getStoreConnectionForCompany(companyId, connectionId);
  doc.status = 'disconnected';
  await doc.save();
  return sanitizeConnection(doc);
};

/**
 * Resolve connection for inbound webhooks.
 */
const findById = async (id) => StoreConnection.findById(id);

const findActiveByPlatformAndUrl = async (platform, storeUrl) => {
  if (!storeUrl) return null;
  return StoreConnection.findOne({
    platform,
    status: 'active',
    storeUrl: new RegExp(String(storeUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  });
};

const findByPublicApiKey = async (publicApiKey) => {
  if (!publicApiKey) return null;
  return StoreConnection.findOne({ publicApiKey, status: 'active' });
};

const sanitizeConnection = (doc, { includeSecrets = false } = {}) => {
  const json = doc.toJSON ? doc.toJSON() : doc;
  const out = {
    id: json.id,
    company: json.company,
    platform: json.platform,
    storeName: json.storeName,
    storeUrl: json.storeUrl,
    status: json.status,
    livemode: json.livemode !== false,
    settings: json.settings,
    publicApiKey: json.publicApiKey || undefined,
    lastWebhookAt: json.lastWebhookAt,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };
  if (includeSecrets) {
    out.webhookSecret = doc.webhookSecret;
    out.publicApiKey = doc.publicApiKey;
  }
  return out;
};

module.exports = {
  createStoreConnection,
  listStoreConnections,
  getStoreConnectionForCompany,
  updateStoreConnection,
  disconnectStore,
  findById,
  findActiveByPlatformAndUrl,
  findByPublicApiKey,
  sanitizeConnection,
};
