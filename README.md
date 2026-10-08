# 🍔 QuickBite

A full-stack food ordering app: browse a menu, build a cart, check out, and watch
the order move from the kitchen to your door. The restaurant side gets its own
dashboard for live orders, revenue and menu availability.

Built with **Express 4**, **SQLite** (via Node's built-in `node:sqlite` — no
native modules to compile) and plain HTML/CSS/JavaScript on the front end.

---

## Quick start

```bash
npm install     # installs express, jsonwebtoken, bcryptjs
npm run seed    # creates the demo accounts and one sample past order
npm start       # http://localhost:3000
```

Use `npm run dev` for an auto-restarting server while you work.

### Demo accounts

| Role     | Email                  | Password   |
| -------- | ---------------------- | ---------- |
| Customer | `demo@quickbite.test`  | `demo123`  |
| Admin    | `admin@quickbite.test` | `admin123` |

Signing in as the admin reveals the **Admin** link in the header, which opens the
kitchen dashboard at `/admin.html`.

### Coupons to try

| Code      | What it does                       |
| --------- | ---------------------------------- |
| `QUICK10` | 10% off, capped at ₹100 (min ₹300) |
| `FREEDEL` | Free delivery (min ₹400)           |
| `BITE50`  | Flat ₹50 off (min ₹600)            |

---

## What it does

**Customer side**

- Menu loaded from the database with live search, category and veg/non-veg
  filters, and sorting by price, rating or name
- Quantity steppers, add to cart, and a slide-out cart drawer
- **Guest carts** live in `localStorage` and are merged into the account on sign-in
- Coupons, GST and the free-delivery threshold are all calculated **server-side**
- Checkout with delivery details and payment method, confirmed with an order code
- Order history with a **live tracker** — the page polls and the order walks
  through placed → confirmed → cooking → on the way → delivered
- Cancel while the order is still new, reorder any past order in one click
- Favourites, dark mode, keyboard-accessible modals

**Restaurant side (`/admin.html`)**

- Revenue, order counts and customer totals
- Every order with its items and address, filterable by status
- Move an order to any status by hand (which stops the simulated timeline)
- Change prices or take a dish off the menu — it disappears from the public menu
  immediately and can no longer be added to a cart

---

## Project layout

```
QuickBite/
├── server/
│   ├── index.js          Express app: API routes, static site, error handling
│   ├── db.js             SQLite schema, seed data, transaction helper
│   ├── auth.js           Password hashing (bcrypt), JWTs, auth middleware
│   ├── pricing.js        The single source of truth for money
│   ├── orderState.js     Order lifecycle + the simulated kitchen clock
│   └── routes/           auth · menu · cart · orders · admin
├── public/
│   ├── index.html        Home, menu, cart drawer, checkout, auth
│   ├── orders.html       Order history and live tracking
│   ├── admin.html        Kitchen dashboard
│   ├── css/style.css     Design system, light + dark themes
│   ├── js/api.js         API client, session store, guest cart (shared)
│   ├── js/app.js         Home page behaviour
│   ├── js/orders.js      Tracking page behaviour
│   ├── js/admin.js       Dashboard behaviour
│   └── images/           Dish photography and the logo
├── scripts/seed.js       Demo accounts + a sample past order
├── tests/                30 tests: API end-to-end + jsdom UI smoke tests
├── data/                 The SQLite file lives here (git-ignored)
└── legacy/               The original single-page prototype, kept for reference
```

---

## API

All responses are JSON. Authenticated routes take `Authorization: Bearer <token>`.

### Public

| Method | Route               | Purpose                                              |
| ------ | ------------------- | ---------------------------------------------------- |
| `GET`  | `/api/health`       | Liveness check                                       |
| `GET`  | `/api/menu`         | Menu, with `?q=`, `?category=`, `?diet=`, `?sort=`   |
| `GET`  | `/api/menu/:id`     | A single dish                                        |
| `GET`  | `/api/menu/coupons` | Active coupons                                       |
| `POST` | `/api/menu/quote`   | Price a basket without storing it (used by guests)   |
| `POST` | `/api/auth/register`| Create an account, returns a JWT                     |
| `POST` | `/api/auth/login`   | Sign in, returns a JWT                               |

### Customer (requires a token)

| Method   | Route                      | Purpose                              |
| -------- | -------------------------- | ------------------------------------ |
| `GET`    | `/api/auth/me`             | The signed-in user                   |
| `PATCH`  | `/api/auth/me`             | Update name, phone, address          |
| `GET`    | `/api/cart`                | Cart with totals (`?coupon=`)        |
| `POST`   | `/api/cart/items`          | Add a dish                           |
| `PATCH`  | `/api/cart/items/:id`      | Set a quantity (0 removes the line)  |
| `DELETE` | `/api/cart/items/:id`      | Remove a line                        |
| `DELETE` | `/api/cart`                | Empty the cart                       |
| `POST`   | `/api/cart/merge`          | Fold a guest cart into the account   |
| `POST`   | `/api/orders`              | Check out                            |
| `GET`    | `/api/orders`              | Order history (`?limit=`)            |
| `GET`    | `/api/orders/:id`          | One order, with its timeline         |
| `POST`   | `/api/orders/:id/cancel`   | Cancel (only before cooking starts)  |
| `POST`   | `/api/orders/:id/reorder`  | Put the order back in the cart       |
| `POST`   | `/api/menu/:id/favorite`   | Toggle a favourite                   |

### Admin (requires an admin token)

| Method  | Route                     | Purpose                                 |
| ------- | ------------------------- | --------------------------------------- |
| `GET`   | `/api/admin/orders`       | All orders (`?status=live\|all\|placed…`) |
| `GET`   | `/api/admin/stats`        | Revenue, counts and top sellers         |
| `PATCH` | `/api/admin/orders/:id`   | Set an order's status                   |
| `PATCH` | `/api/admin/menu/:id`     | Change a price or availability          |

---

## How a few things work

**Money is never trusted from the client.** `server/pricing.js` recomputes the
subtotal, discount, delivery fee and GST from the database on every cart read and
again at checkout. A request that claims `"total": 1` is simply ignored.

**The kitchen clock is simulated.** Each order gets an ETA from the slowest dish's
prep time plus 15 minutes on the road. `server/orderState.js` works out which
stage the order should be in from the elapsed time whenever an order is read, and
backfills any stages it passed through so the timeline stays complete. An admin
setting a status by hand clears `auto_advance`, which hands control to the kitchen.

**Guest carts.** Signed out, the cart lives in `localStorage` but is still priced
by `POST /api/menu/quote`, so the totals a guest sees are the ones the server
would charge. On sign-in, `POST /api/cart/merge` folds the basket into the account.

---

## Testing

```bash
npm test
```

30 tests run against a throwaway SQLite file:

- `tests/api.test.js` — auth, authorization boundaries, cart maths, coupon rules,
  checkout, order ownership, cancellation rules, the lifecycle clock, and admin routes
- `tests/ui.test.js` — the real HTML pages loaded into jsdom against a live
  server: the menu renders, the cart updates, coupons validate, sign-in adopts the
  guest cart, checkout places an order, tracking works, and the admin gate holds

---

## Configuration

Copy `.env.example` and set values in your environment:

| Variable         | Default                 | Notes                                   |
| ---------------- | ----------------------- | --------------------------------------- |
| `PORT`           | `3000`                  |                                         |
| `JWT_SECRET`     | a dev-only default      | **Required** when `NODE_ENV=production` |
| `JWT_EXPIRES_IN` | `7d`                    |                                         |
| `DB_FILE`        | `data/quickbite.db`     |                                         |

`npm run reset` deletes the database and re-seeds it from scratch.

---

## Notes

- `images/biriyani.jpg` is not in the repo, so the Chicken Biryani card falls back
  to `images/placeholder.svg`. Drop a photo at that path and it appears — no code
  change needed.
- Requires **Node 22.5+** for the built-in `node:sqlite` module. It prints an
  experimental-feature warning on start, which is expected.
- `legacy/` holds the original prototype files and is not used by the app.
