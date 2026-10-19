const { AsyncLocalStorage } = require('async_hooks');

/**
 * Live/test mode of the current authenticated request (the dashboard's Test/Live switch).
 * Set once by the auth middleware from the `x-cloudship-mode` header and read implicitly by the
 * live-data scope on models, the carrier layer and store listing. Outside a request (webhooks,
 * pollers, server-to-server APIs) there is no mode, which means live.
 */
const storage = new AsyncLocalStorage();

const isLive = () => {
  const store = storage.getStore();
  return !store || store.livemode !== false;
};

const run = (livemode, fn) => storage.run({ livemode: livemode !== false }, fn);

const fromRequest = (req) => String(req.headers['x-cloudship-mode'] || '').toLowerCase() !== 'test';

module.exports = { isLive, run, fromRequest };
