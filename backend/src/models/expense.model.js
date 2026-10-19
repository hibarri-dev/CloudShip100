const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const expenseSchema = mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['fuel', 'yard_fee', 'airport_fee', 'salary'],
      required: true,
      index: true,
    },
    date: Date,
    period: { type: String, trim: true },
    asset: { type: String, trim: true },
    liters: { type: Number, default: null },
    cost: { type: Number, default: null },
    amount: { type: Number, default: null },
    location: { type: String, trim: true },
    yard: { type: String, trim: true },
    airport: { type: String, trim: true },
    description: { type: String, trim: true },
    person: { type: String, trim: true },
    role: { type: String, trim: true },
  },
  { timestamps: true }
);

expenseSchema.plugin(toJSON);
expenseSchema.plugin(paginate);
expenseSchema.plugin(require('./plugins').livemodeScope);

const Expense = mongoose.model('Expense', expenseSchema);
module.exports = Expense;
