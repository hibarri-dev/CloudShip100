const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const invoiceSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Company',
      required: true,
    },
    booking: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Booking',
      default: null,
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['Open', 'Paid'],
      default: 'Open',
    },
    due: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

invoiceSchema.plugin(toJSON);
invoiceSchema.plugin(paginate);
invoiceSchema.plugin(require('./plugins').livemodeScope);

/**
 * @typedef Invoice
 */
const Invoice = mongoose.model('Invoice', invoiceSchema);

module.exports = Invoice;
