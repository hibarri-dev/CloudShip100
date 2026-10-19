const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const paymentRequestSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Company',
      required: true,
    },
    invoice: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Invoice',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['due', 'overdue', 'paid'],
      default: 'due',
    },
  },
  {
    timestamps: true,
  }
);

paymentRequestSchema.plugin(toJSON);
paymentRequestSchema.plugin(paginate);
paymentRequestSchema.plugin(require('./plugins').livemodeScope);

/**
 * @typedef PaymentRequest
 */
const PaymentRequest = mongoose.model('PaymentRequest', paymentRequestSchema);

module.exports = PaymentRequest;
