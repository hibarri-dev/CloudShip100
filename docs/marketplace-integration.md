# Commoditopia marketplace API

All routes are POST under `/v1/marketplace`: `connection`, `eligibility`, `rates`, `book`, and `status`.

Use an active Lovable / Universal store. Every call requires `x-cloudship-key`, `x-cloudship-timestamp` (Unix milliseconds), and `x-cloudship-signature` (hex HMAC-SHA256 of `timestamp + "." + exactRawBody`, using the store webhook secret). Five-minute replay window. Keep credentials server-side.

`connection` returns store connection/account approval status. Operator environment variable `CLOUDSHIP_INVOICE_CONNECTION_IDS` is a comma-separated allowlist of store connection IDs approved for account invoicing. No rates or booking until approved. Bookings remain awaiting invoice settlement; the API does not charge the storefront buyer again.

`eligibility`: `{commodities:[{cargoForm,packagingType,specialClassifications,perishable,flammable}]}` -> status `eligible`, `unsupported`, or `incomplete`, with a reason. The policy is in `backend/src/integrations/marketplacePolicy.js`. Current specialist exclusions include bulk/tankers/containers, liquids/gases, hazardous/perishable goods, and extra loading labour. It must be updated alongside real carrier service capabilities.

`rates`: `{pickup,dropoff,pickupPhone,cargo,parcels:[{quantity,weightKg,lengthCm,widthCm,heightCm,commodity:{...}}]}` -> `{quoteId,expiresAt,options:[{partner,service,currency,quotedPrice,etaHours}]}`. Uses the supplied collection address and real carrier adapters. Maximum 20 physical parcels; one common service is quoted for the whole shipment. Carrier currencies remain unchanged. No estimates are substituted for live quotes.

`book`: `{externalOrderId,quoteId,partner,service,currency,maxAmount,buyerPhone,buyerName,buyerEmail}`. Call only after storefront payment settlement and seller acceptance. The quote is store-bound; maxAmount/currency must match it. Requotes the stored shipment even after checkout quote expiry and refuses price increases. Store connection plus externalOrderId is unique. Persists per-parcel state before booking. Repeated calls return the existing dispatch. An uncertain carrier result requires operations reconciliation; it is not automatically rebooked.

`status`: `{externalOrderId}` -> `{bookingId,bookingCode,bookingStatus,reason,status,collected,parcels:[{bookingCode,status,trackingUrl}]}`. bookingCode here identifies the multi-parcel dispatch; individual parcel codes belong to ordinary CloudShip bookings. All parcels must be collected before collected=true, and delivered before status=delivered.

Optional status callbacks use the store encrypted `statusWebhookUrl` credential. The universal adapter aggregates bundle updates and signs callbacks with the same timestamp/raw-body convention. Poll status as a reconciliation fallback.

Create the unique `(connection, externalOrderId)` index on `marketplacedispatches` before production traffic if automatic index creation is disabled. Carrier cancellation/refund and invoice settlement are manual operations; do not conflate them with a storefront buyer refund. Never reset an uncertain `booking` parcel or an interrupted dispatch lease without first checking the carrier for an existing shipment.

Tests: `node --test tests/node/marketplace.test.cjs`. Commoditopia deployment instructions are in that backend's `docs/cloudship-integration.md`.

## Test mode (sandbox)

Flip the **Live / Test switch** in the dashboard header (customer portal and ops dashboard), then create the store under E-commerce > Lovable / Universal: stores take the mode the dashboard is in (API callers can pass `livemode: false` on `POST /v1/ecommerce/stores`). It is issued a `cs_test_…` key and its own `webhookSecret`; the mode cannot be changed afterwards, and only Lovable / Universal stores can be test stores. Use the same endpoints and signing as live; only the credentials differ.

Test-mode stores:
- use a simulated carrier (`sandbox_courier`, services Economy and Express). No real carrier is ever called, nothing is collected and nothing is invoiced;
- need no invoicing approval (`CLOUDSHIP_INVOICE_CONNECTION_IDS` is ignored for them);
- create records flagged `livemode: false`. These are hidden from every ordinary read (dashboards, analytics, driver/warehouse screens, carrier polling, emails) and deleted automatically after 30 days. The dashboards show them when the switch is on Test (see below);
- cannot use the older `/v1/webhooks/*` routes.

Magic values, placed anywhere in the pickup or dropoff address:

| Value | Effect |
|---|---|
| `unserviceable` | `/rates` returns no options |
| `carrier-error` | rates succeed, `/book` fails with an uncertain carrier result (`needs_attention`) |
| `price-increase` | the booking-time re-quote is 50% dearer than the checkout quote (`needs_attention`) |

A parcel weighing exactly 99 kg also fails to book.

`POST /v1/marketplace/test/advance` `{externalOrderId, courierStatus?}` (test stores only, `403` for live) moves every parcel of a booked shipment to the next stage (`collection-assigned`, `collected`, `in-transit`, `out-for-delivery`, `delivered`) or to the stated `courierStatus`, then fires the normal signed status callback to the store's `statusWebhookUrl`. The response is the same body as `/status`.

`/connection` returns `livemode` so a storefront can show which mode it is connected to.

### The dashboard switch

The Live / Test switch (top bar, both dashboards) is remembered per browser and sent with every authenticated dashboard request as `x-cloudship-mode: test`. In Test mode the whole dashboard shows only sandbox data: bookings, trips, parcels, invoices, expenses, payment requests, damage logs and notifications, plus the store list and every count and chart. Things created while in Test mode (bookings, notifications, stores, ...) are stamped `livemode: false`, and the portal's own quotes and bookings use the simulated carrier. Switching back to Live shows live data exactly as before. Static resources (users, companies, drivers, fleet, warehouses, pricing rates) are shared between modes.

Only authenticated dashboard requests honour the header. Webhooks, the marketplace API, public tracking and background pollers ignore it: they are live unless the store connection itself is a test store.
