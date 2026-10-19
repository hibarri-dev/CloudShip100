const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

/* eslint-disable no-param-reassign */

const withCodeId = (definition) => {
  const schema = mongoose.Schema(
    {
      code: { type: String, required: true, unique: true, trim: true },
      ...definition,
    },
    {
      timestamps: true,
      toJSON: {
        transform(doc, ret) {
          ret.id = doc.code;
          delete ret.code;
          if (ret.openedAt) {
            ret.createdAt = ret.openedAt;
          }
          if (ret.collectionPoint !== undefined) {
            ret.collection = ret.collectionPoint;
            delete ret.collectionPoint;
          } else if (doc._doc && doc._doc.collection) {
            ret.collection = doc._doc.collection;
          }
          return ret;
        },
      },
    }
  );
  schema.plugin(toJSON);
  return schema;
};

const parcelSchema = withCodeId({
  orderId: { type: String, trim: true, index: true },
  bookingId: { type: String, trim: true },
  cargo: { type: String, trim: true },
  weightKg: { type: Number, default: null },
  shipper: { type: String, trim: true },
  consignee: { type: String, trim: true },
  client: { type: String, trim: true },
  pickup: { type: String, trim: true },
  dropoff: { type: String, trim: true },
  warehouse: { type: String, trim: true },
  zone: { type: String, trim: true },
  batchId: { type: String, trim: true, default: null },
  labelCode: { type: String, trim: true, default: null },
  status: { type: String, default: 'expected' },
  fleetType: { type: String, default: null },
  truck: { type: String, default: null },
  driver: { type: String, default: null },
  driverEmployeeId: { type: String, default: null },
  partner: { type: String, default: null },
  mode: { type: String, default: 'Road' },
  receivedAt: { type: String, default: null },
});

const batchSchema = withCodeId({
  name: { type: String, trim: true },
  warehouse: { type: String, trim: true },
  destination: { type: String, trim: true },
  parcelIds: { type: [String], default: [] },
  status: { type: String, default: 'open' },
  openedAt: { type: String, default: null },
});

const suggestionSchema = withCodeId({
  parcelId: { type: String, trim: true, index: true },
  reason: { type: String, trim: true },
  fleetType: { type: String, default: null },
  truck: { type: String, default: null },
  driver: { type: String, default: null },
  employeeId: { type: String, default: null },
  partner: { type: String, default: null },
  score: { type: Number, default: 0 },
  source: { type: String, default: 'seed' },
});

const zoneSchema = withCodeId({
  name: { type: String, trim: true },
  warehouse: { type: String, trim: true },
  type: { type: String, trim: true },
  radiusM: { type: Number, default: null },
  rule: { type: String, trim: true },
  active: { type: Boolean, default: true },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
});

const eventSchema = withCodeId({
  parcelId: { type: String, trim: true, index: true },
  time: { type: String, trim: true },
  title: { type: String, trim: true },
  detail: { type: String, trim: true },
});

const routeSchema = withCodeId({
  name: { type: String, trim: true },
  parcelIds: { type: [String], default: [] },
  baselineHrs: { type: Number, default: null },
  optimizedHrs: { type: Number, default: null },
  fuelSavePct: { type: Number, default: 0 },
  stops: { type: [String], default: [] },
  status: { type: String, default: 'suggested' },
  fleetType: { type: String, default: 'own' },
  distanceKm: { type: Number, default: null },
  durationMinutes: { type: Number, default: null },
  optimized: { type: Boolean, default: false },
});

const driverSchema = withCodeId({
  name: { type: String, trim: true },
  fleetType: { type: String, default: 'own' },
  partner: { type: String, trim: true },
  status: { type: String, default: 'available' },
  yard: { type: String, trim: true },
  assignedParcels: { type: [String], default: [] },
  vehicle: { type: String, trim: true },
  shift: { type: String, trim: true },
});

const mapAssetSchema = withCodeId({
  type: { type: String, trim: true },
  label: { type: String, trim: true },
  status: { type: String, trim: true },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  driver: { type: String, trim: true },
  payload: { type: String, trim: true },
  distance: { type: String, trim: true },
  collectionPoint: { type: String, trim: true },
  delivery: { type: String, trim: true },
});

parcelSchema.plugin(require('./plugins').livemodeScope);
const Parcel = mongoose.model('WarehouseParcel', parcelSchema);
const WarehouseBatch = mongoose.model('WarehouseBatch', batchSchema);
const AssignmentSuggestion = mongoose.model('AssignmentSuggestion', suggestionSchema);
const WarehouseZone = mongoose.model('WarehouseZone', zoneSchema);
const DispatchEvent = mongoose.model('DispatchEvent', eventSchema);
const WarehouseRoute = mongoose.model('WarehouseRoute', routeSchema);
const WarehouseDriver = mongoose.model('WarehouseDriver', driverSchema);
const WarehouseMapAsset = mongoose.model('WarehouseMapAsset', mapAssetSchema);

module.exports = {
  Parcel,
  WarehouseBatch,
  AssignmentSuggestion,
  WarehouseZone,
  DispatchEvent,
  WarehouseRoute,
  WarehouseDriver,
  WarehouseMapAsset,
};
