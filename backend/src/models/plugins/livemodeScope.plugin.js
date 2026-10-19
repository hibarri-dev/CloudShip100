const requestMode = require('../../utils/requestMode');

/**
 * Separates sandbox (test-mode) records from live ones.
 *
 * - Every read follows the current request's mode: live requests see `livemode != false` (so
 *   legacy documents without the field stay live), test requests see only `livemode: false`.
 *   Outside a request (webhooks, pollers) the mode is live.
 * - Documents created while a request is in test mode are stamped `livemode: false`.
 * - Reads that mention `livemode` themselves, or set `.setOptions({ anyMode: true })`, are left
 *   alone: use that for id-targeted lookups that must work in either mode.
 * - Updates are not scoped; they always target a known document.
 */
const livemodeScope = (schema) => {
  if (!schema.path('livemode')) schema.add({ livemode: { type: Boolean, default: true } });

  const condition = () => (requestMode.isLive() ? { $ne: false } : false);

  const scope = function scopeToMode() {
    if (this.getOptions().anyMode) return;
    if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'livemode')) return;
    this.where({ livemode: condition() });
  };
  ['find', 'findOne', 'countDocuments', 'distinct'].forEach((hook) => schema.pre(hook, scope));

  schema.pre('aggregate', function scopeAggregate() {
    const first = this.pipeline()[0];
    if (first && first.$match && Object.prototype.hasOwnProperty.call(first.$match, 'livemode')) return;
    if (this.options && this.options.anyMode) return;
    this.pipeline().unshift({ $match: { livemode: condition() } });
  });

  schema.pre('validate', function stampMode(next) {
    if (this.isNew && !requestMode.isLive()) this.livemode = false;
    next();
  });
};

module.exports = livemodeScope;
