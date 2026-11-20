# SalonBook — Server (Express REST API)

SalonBook is a salon appointment booking platform where customers browse salon services, request
appointments, and pay online, while admins manage services, appointments, customers, and payments.

This repository contains the **backend**: an Express.js REST API backed by MongoDB. It owns all
business rules and data access for services, appointments, users, transactions, and Stripe payments,
and protects routes with session-token authentication and role/ownership checks. The frontend lives
in the separate Next.js client repository — see the
[client repository](#client-and-server-repository-links).

## Important Features

**Services**

- Public browsing of active services with search by name (`?search=`), category filtering
  (`?category=`), and price sorting (`?sort=price-asc` or `price-desc`).
- Featured services endpoint returning the six newest active services with a shortened description.
- Public service detail endpoint; invalid or unknown IDs return clear errors.
- Admin-only listing, creation, update, and deletion, with validation for required fields, positive
  price and duration, and `active`/`inactive` status.

**Appointments**

- Customers can create appointment requests; the customer identity always comes from the verified
  session token, never from the request body.
- Booking rules enforced server-side: service must exist and be active, the date cannot be in the
  past, admins cannot book, and duplicate active (pending/confirmed) bookings for the same
  service + date + time slot are rejected with `409`.
- Customers can list only their own appointments and cancel only their own **pending** requests.
- Admins can list all requests with joined customer and service information, confirm **pending**
  requests, and cancel pending or confirmed requests.

**Users**

- Profile read and update restricted to the owner; only name, image, and phone can be changed — never
  role or blocked status.
- Admin-only customer listing, block/unblock (customers only), and dashboard statistics.
- Blocked accounts are rejected by the authentication middleware on every protected route.

**Payments and transactions**

- Stripe Checkout session creation for the customer's own **confirmed** and **unpaid** appointment
  only, with the appointment and customer recorded in Stripe metadata.
- Verified Stripe webhook (`checkout.session.completed`) that marks the appointment as paid and
  inserts a transaction record; duplicate events are ignored for idempotency.
- Admin-only, read-only transaction history with customer, service, appointment, amount, currency,
  payment status, and Stripe session reference.

**Security**

- `requireAuth` middleware validates the `Bearer` session token against Better Auth's `session`
  collection, checks expiry, loads the user, and rejects blocked accounts.
- `requireAdmin` middleware enforces the `admin` role after authentication.
- Ownership checks ensure customers can only read or modify their own appointments, profile, and
  payments.

## Technology Stack

- **Node.js** with ES modules (`"type": "module"`)
- **Express.js 5** for the HTTP API
- **MongoDB** accessed through the native `mongodb` driver (no ODM)
- **Stripe** Node SDK for Checkout sessions and webhook signature verification
- **cors** configured for the client origin
- **dotenv** for environment configuration

**Database:** the API uses the `salonbook` database with these collections:

| Collection | Purpose |
| --- | --- |
| `user` | Accounts created and managed by Better Auth (includes `role` and `isBlocked`). |
| `session` | Better Auth sessions; the API looks up `Bearer` tokens here. |
| `services` | Salon services with price, duration, image, and status. |
| `appointments` | Customer appointment requests with status and payment status. |
| `transactions` | Payment records written by the verified Stripe webhook. |

## Installation Instructions

**Prerequisites**

- Node.js 20 or newer and npm
- A MongoDB database (the same database used by the client's Better Auth configuration)
- A Stripe account with a secret key and a webhook signing secret
- The SalonBook Next.js client running for browser-based end-to-end testing

```bash
git clone https://github.com/abdulkader02/A-9-SalonBook-Backend.git
cd A-9-SalonBook-Backend
npm install
```

## How to Run the Project Locally

1. Create a `.env` file in the project root and fill in the variables listed in
   [Required Environment Variables](#required-environment-variables).
2. Start the API:

   ```bash
   node index.js
   ```

   > Note: `package.json` currently defines only a placeholder `test` script — there is no
   > `dev` or `start` script yet, so `node index.js` is the command to run the server.

3. The API listens on **port 5000** (the port is currently hardcoded in `index.js`), so the base URL
   is [http://localhost:5000](http://localhost:5000). A quick health check: `GET /` returns
   `Hello World!`.

4. Point the client at this URL through its `NEXT_PUBLIC_API_URL` variable, then start the client
   (see the [client README](https://github.com/abdulkader02/A-9-SalonBook-frontend#how-to-run-the-project-locally)).

### Local Stripe webhook testing

Stripe cannot reach `localhost` directly, so use the Stripe CLI to forward events and obtain a local
webhook signing secret:

```bash
stripe listen --events checkout.session.completed --forward-to localhost:5000/webhook
```

Copy the signing secret printed by the CLI into `STRIPE_WEBHOOK_SECRET` in your local `.env`, then
restart the server. This step is **only for local development** — once deployed, configure a real
webhook endpoint (for the `/webhook` path) in the Stripe Dashboard and use its signing secret
instead.

## Required Environment Variables

Create `.env` in the project root. Only the variable **names** are listed below — never commit real
secrets.

```bash
MONGODB_URI=your_value_here
CLIENT_URL=your_value_here
STRIPE_SECRET_KEY=your_value_here
STRIPE_WEBHOOK_SECRET=your_value_here
```

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string for the `salonbook` database. |
| `CLIENT_URL` | Public URL of the Next.js client; used for CORS and Stripe success/cancel redirects. |
| `STRIPE_SECRET_KEY` | Stripe secret key used to create Checkout sessions. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret used to verify incoming Stripe webhook events. |

### Main API endpoints

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/` | Public health check |
| `GET` | `/services` | Public (active services; search, category, sort) |
| `GET` | `/services/featured` | Public |
| `GET` | `/services/:id` | Public |
| `POST` | `/services` | Admin |
| `PATCH` | `/services/:id` | Admin |
| `DELETE` | `/services/:id` | Admin |
| `GET` | `/admin/services` | Admin |
| `GET` | `/appointments` | Authenticated customer (own only) |
| `POST` | `/appointments` | Authenticated customer |
| `PATCH` | `/appointments/:id/cancel` | Owner (pending only) |
| `GET` | `/admin/appointments` | Admin |
| `PATCH` | `/appointments/:id/status` | Admin |
| `GET` | `/users` | Admin |
| `GET` | `/users/:id` | Owner |
| `PATCH` | `/users/:id` | Owner |
| `GET` | `/admin/users` | Admin |
| `PATCH` | `/users/:id/block` | Admin |
| `GET` | `/admin/stats` | Admin |
| `POST` | `/create-checkout-session` | Authenticated customer (own confirmed, unpaid appointment) |
| `POST` | `/webhook` | Stripe only (signature verified) |
| `GET` | `/admin/transactions` | Admin |

## Live Website Link

`<ADD_SERVER_LIVE_URL_HERE>`

## Client and Server Repository Links

- **Client (Next.js frontend):** [https://github.com/abdulkader02/A-9-SalonBook-frontend](https://github.com/abdulkader02/A-9-SalonBook-frontend)
- **Server (this repository):** [https://github.com/abdulkader02/A-9-SalonBook-Backend](https://github.com/abdulkader02/A-9-SalonBook-Backend)
