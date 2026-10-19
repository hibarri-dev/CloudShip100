const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const tripSchema = mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
    },
    driverProfile: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'DriverProfile',
      required: true,
      index: true,
    },
    vehicle: {
      type: String,
      trim: true,
    },
    cargo: {
      type: String,
      required: true,
      trim: true,
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
    status: {
      type: String,
      enum: ['starting_soon', 'in_progress', 'ending_soon', 'completed', 'cancelled'],
      default: 'starting_soon',
    },
    distanceKm: {
      type: Number,
      default: 0,
    },
    eta: Date,
    startAt: Date,
    endAt: Date,
    mode: {
      type: String,
      enum: ['road', 'air', 'maritime', 'rail'],
      default: 'road',
    },
    onTime: {
      type: Boolean,
      default: true,
    },
    clientOrderId: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

tripSchema.index({ driverProfile: 1, code: 1 }, { unique: true });
tripSchema.plugin(toJSON);
tripSchema.plugin(require('./plugins').livemodeScope);

const Trip = mongoose.model('Trip', tripSchema);
module.exports = Trip;
