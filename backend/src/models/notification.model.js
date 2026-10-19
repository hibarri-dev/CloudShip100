const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const notificationSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Company',
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      default: 'general',
    },
    unread: {
      type: Boolean,
      default: true,
    },
    dismissed: {
      type: Boolean,
      default: false,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.plugin(toJSON);
notificationSchema.plugin(paginate);
notificationSchema.plugin(require('./plugins').livemodeScope);

/**
 * @typedef Notification
 */
const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
