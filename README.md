# 🍔 QuickBite

A full-stack food ordering app: browse 30 dishes, get AI-assisted suggestions,
build a cart, check out, and watch the order move from the kitchen to your door.
The restaurant side gets its own dashboard with live orders, stock control,
analytics and a demand forecast.

Built with **Express 4**, **SQLite** (via Node's built-in `node:sqlite` — no
native modules to compile) and plain HTML/CSS/JavaScript. No build step, no
front-end framework, three runtime dependencies.

---

## Quick start

```bash
npm install
npm run seed      # demo accounts + 45 days of synthetic order history
npm start         # http://localhost:3000
```

`npm run dev` restarts on change. `npm test` runs all 140 tests.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Customer | `demo@quickbite.test` | `demo1234` |
| Customer | `rahul@quickbite.test` | `demo1234` |
| Kitchen (admin) | `admin@quickbite.test` | `admin1234` |

Signing in as the admin reveals the **Kitchen** link in the header.

### Coupons

| Code | Effect |
| --- | --- |
| `QUICK10` | 10% off, capped at ₹100 (min ₹300) |
| `FREEDEL` | Free delivery (min ₹400) |
| `BITE50` | Flat ₹50 off (min ₹600) |
| `WELCOME20` | 20% off, capped at ₹150 — **once per account** |
| `EXPIRED5` | Deliberately expired, so you can see the expiry check refuse it |

---

## What it does

### Customer

- **30 dishes** across 8 categories, each with a real photo, description,
  cuisine, spice level, calories and prep time
- Live search plus category, veg/non-veg, price and spice filters, and five sort
  orders
- **Dish detail** with reviews, nutrition facts and an AI "goes well with" panel
- **Guest carts** live in `localStorage` but are still priced by the server, and
  are merged into the account on sign-in
- Coupons, GST, delivery and small-order fees all computed **server-side**
- Checkout with saved addresses, and an idempotency key so a double-click or a
  retry cannot create two orders
- **Live tracking** — the page polls while an order walks through placed →
  confirmed → cooking → on the way → delivered
- Cancel free before cooking starts (which puts the stock back); reorder any
  past order in one click; rate a dish once it has been delivered to you
- Dark mode, keyboard-accessible modals, skeleton loaders, honest empty states

### Kitchen (`/admin.html`)

- Revenue, order counts, average order value, discounts given
- Every order with its items and address, filterable by status
- Move an order along the lifecycle — **only to statuses it may legally reach**
- Edit prices and stock, or take a dish off the menu (it vanishes from the
  public menu immediately and can no longer be added to a cart)
- Orders-by-hour and daily-orders charts, revenue by category, coupon usage
- **Demand forecast** for the next 7 days, with its own measured accuracy

---

## The AI layer

Three features, all computed from the live database. None of them is required
for the shop to work — see *Isolation* below.

### 1. Recommendations — `GET /api/ai/recommendations`

A hybrid of three signals, each of which switches itself off when the data
behind it is too thin:

| Signal | What it is | When it activates |
| --- | --- | --- |
| **Popularity** | Units sold, with a Bayesian prior pulling thin-data dishes toward the menu's mean rating | Always |
| **Content** | Cosine similarity between a dish's tag/cuisine/diet vector and a taste profile built from the customer's orders, favourites and browsing | Once the customer has any history |
| **Collaborative** | Item-to-item co-occurrence ("people who ordered this also ordered that"), lift-normalised so a popular dish isn't "similar to everything" | Once **8+** multi-item baskets exist |

The weight of an inactive signal is redistributed across the active ones, and
the response says which strategy was used (`popular` / `personalised` /
`hybrid`) along with the counts that drove the decision. A brand-new visitor
gets popular dishes labelled as such — never a fake "personalised" badge.

### 2. Menu assistant — `POST /api/ai/assistant`

Answers in two stages:

1. A **deterministic parser** turns the question into structured constraints
   (budget, diet, cuisine, course, spice, mood, ingredients, party size) and
   queries the real menu. This always runs and always picks the dishes.
2. **If** `ANTHROPIC_API_KEY` is set, an LLM is asked to phrase the reply *using
   only the dishes stage 1 already chose*. If the key is missing, the call times
   out, or the response is malformed, the deterministic sentence is used.

The model never selects dishes and never sees a price it could invent. It is
sent dish names, prices and descriptions — **never** a customer's name, email,
phone, address, payment details or password. `tests/ai.test.js` asserts across
seven different questions that every dish named is real and every price quoted
matches the database.

With no key configured — the default in this repo — the assistant still answers
every question. That path is the one the tests exercise.

### 3. Analytics and forecasting — `GET /api/ai/{analytics,forecast,trends}`

Descriptive analytics (peak hour, busiest weekday, top sellers, category mix)
are always real.

The **forecast** is a seasonal-naive baseline (same weekday, recent weeks)
blended 60/40 with a 7-day moving average, and it refuses to produce numbers at
all below **14 days** of history:

```json
{ "available": false, "reason": "insufficient-data",
  "message": "A forecast needs at least 14 days of order history; there are 3 so far..." }
```

When it does run, it reports its own error from a **real holdout**: the last 7
days are each predicted using only the days before them, and the mean absolute
error is returned alongside the prediction. On the seeded demo data that comes
out at ≈1.3 orders/day (24% MAPE) — the dashboard shows that figure rather than
claiming unqualified accuracy.

### Isolation

Every AI route is wrapped so a failure returns an empty, explained result
instead of an error, and nothing in the checkout path imports anything from
`server/ai/`. A test asserts that an order can still be placed when the AI
endpoints are misbehaving.

---

## The cinematic act

The home page opens on three scroll-driven scenes. Every animation in
them is **scroll-linked, not scroll-triggered** — each transform is a
continuous function of scroll offset, so everything scrubs backwards
exactly as it plays forwards.

**Scene 1 — the burger.** A modelled burger rises into place, turns
toward the camera, separates into its ingredients, puts itself back
together, then descends and leaves to the lower left.

**Scene 2 — explore flavours.** Category cards rise, un-tilt and settle
as the section crosses the viewport, and tilt in 3D under the pointer.
Every card is a real category from the API with its real dish count, its
real lowest price and a photo of a real dish from it; clicking one drives
the menu's own category filter rather than a second copy of it.

**Scene 3 — the exploded showcase.** A pinned section in which the
modelled pizza comes apart into crust, sauce, mozzarella and basil,
holds, and reassembles — all scrubbed, so scrolling back up puts it
together again. Beside it, a glass panel names the highest-rated pizza
actually on the menu with its real description, price, rating, prep time
and photograph. Its buttons are wired to the same cart and detail
handlers the menu grid uses, so they genuinely work.

The section is pinned because the explode only reads if the object holds
still while it comes apart. Unpinned, the pizza drifts up the screen at
the same time and the two motions cancel out. The pin lasts a little
over one viewport, so it never feels like the page has stopped
responding.

**The rest of the page** gets the same language, dialled down and
section by section. "Picked for you" lifts gently, because it is a
personal shelf rather than a spectacle. "How it works" has its five
stages climb in order, each from further back than the last, so it reads
as a journey — and they are the five statuses an order really moves
through, read from the server's own lifecycle rather than written out
again here. The menu grid deliberately gets **nothing**: it is thirty
cards on a utility surface people scan and filter, and the one screen
that needs to feel instant should not feel staged. Restraint there is
the design decision, not an omission.

### Ascending and descending

The motion that defines the act is vertical travel through real depth,
not translation on a flat plane. Measured across one pass:

| | |
| --- | --- |
| Burger | rises from below the frame, turns 4.4 radians, moves from z −3.4 to +1.2 and back to −2.6, separates into eight layers and reassembles, then descends and exits lower-left |
| Pizza | rises from below the lower-right, climbs 3.4 frame-heights, tips from almost edge-on to nearly flat, then settles **back down** into its showcase position |
| Pizza layers | spread from 0.14 to 1.71 world units apart and close again |
| Scene 2 cards | arrive from translateZ −140 to −440 px — genuinely different distances, not scaled imitations — then drift up, down, forward and back at depth-derived rates |
| Journey legs | five stages climb in sequence from z −220, −330, −440, −550, −660 |

None of it is monotonic, and none of it is a fade. Every value is a
continuous function of scroll offset, so all of it runs backwards.

### The handoff

The burger's act ends where Scene 2 begins, and the pizza's begins while
the burger is still leaving — so for a moment both are on stage at once.
The burger exits low and to the left; the modelled pizza rises from low
and to the right, tips toward the viewer, crosses behind the flavour
cards, and arrives at Scene 3 where the pin takes over.

Only one pizza is ever visible. The dish's photograph appears full-size
in Scene 3 on any page without WebGL, and shrinks to a chip inside the
glass panel when the modelled pizza has the stage. An earlier cut showed
both at once, and a modelled pizza sat next to a photographed one with
each undermining the other.

**Three.js for the scenes, GSAP ScrollTrigger for the timelines.** One
fixed, viewport-sized canvas holds the whole 3D world, with the page
lifted above it by z-index, so a single object can travel from one
section into the next without being clipped by any section box.

The 3D is the subject in Scene 1 and the backdrop in Scenes 2 and 3; the
canvas opacity says so, stepping 1.00 → 0.55 → 0.22 as the act proceeds.
At full strength the pizza crossing behind the flavour grid burned
through the cards and through the section's own subtitle.

**The burger is modelled in code**, not downloaded — lathed profiles for
the buns and discs, a waved annulus for the lettuce, an instanced
Fibonacci spiral of sesame seeds across the dome. That avoids both the
megabytes and the licence audit a GLTF model would bring, and the shapes
are parameterised so a phone can be given a cheaper one.

### What it costs, and who pays it

The bundle is split in two, by what a device can actually use:

| File | Size | Loaded when |
| --- | --- | --- |
| `motion.bundle.js` + shared chunk | 114 KB (45 KB gzipped) | motion is welcome — drives the Scene 2 and Scene 3 DOM choreography |
| `scene.bundle.js` | 548 KB (140 KB gzipped) | the device has a working WebGL context |

A laptop with WebGL disabled gets the full scroll choreography for 114 KB
and never downloads Three.js to find that out. Splitting also keeps GSAP
to **one** instance: two copies would each run their own ticker, scroll
listener and ScrollTrigger registry, so a refresh from one could not
reach the other's triggers.

| | |
| --- | --- |
| Loading | Both are lazy, after first paint. Neither is ever on the critical path |
| Frame rate | 93–120 fps measured in headless Chrome at 1440×900, 820×1180 and 390×844 on this machine. Not a claim about low-end phones |
| Draw calls | One scene, ~23 meshes, 3 instanced clouds. No shadow maps; the contact shadow is a gradient sprite |
| Culling | Each object stops being drawn once it is fully outside the frame — the pizza spends all of Scene 1 below the viewport |
| Below the act | **Zero** frames rendered. The canvas fades out past Scene 3 and the loop bails before drawing. This is asserted by a test, because an invisible scene looks identical whether or not it is being drawn — and for a while it was being drawn, 145 times in 1.2 seconds |
| Mobile | Fewer polygons, fewer floating ingredients, device-pixel-ratio capped at 1.25, pointer parallax off |

No `transmission` material anywhere, deliberately: a single non-zero
`transmission` makes Three.js render the whole scene into a second
render target every frame.

### When it does not run

All three scenes are **additive**, in two independent layers:

- `js/scenes.js` has no dependencies at all. It renders both scenes from
  the menu payload and wires every interaction — the category filter, the
  cart buttons, the pointer tilt. It always runs.
- `js/cinematic/` adds motion on top, and only then. Its animations start
  from the resting state and animate *from* an offset, never *to*
  visibility, so nothing it does is load-bearing for seeing content.

`boot.js` decides how much to load, and the `html.qb-3d` class that
activates the dark treatment is only added *after* WebGL has produced a
real frame. The WebGL layer declines, silently and completely, when:

- the visitor prefers reduced motion (and it tears down live if that
  preference is switched on mid-visit)
- the device has no usable WebGL context
- the bundle fails to load, or the scene throws while starting
- the WebGL context is lost

In every one of those cases the hero keeps its original photo collage —
still in the markup, as the fallback rather than a replacement — and
Scenes 2 and 3 render on the ordinary light page, which is what they are
styled for first. The dark treatment is the override, not the base. All
three failure paths are tested, including a check that the category
filter still works with the WebGL bundle blocked.

### Rebuilding it

The bundles and their shared chunk are committed, so a clone runs with no
build step. After editing `public/js/cinematic/scene.js` or `motion.js`:

```bash
npm run build:3d      # tree-shake + minify with esbuild
```

A test asserts the committed output still matches its source, so a
forgotten rebuild fails the suite rather than shipping silently.

Three.js and GSAP are **devDependencies**. They are bundled into a static
asset at build time and never loaded by the server, so the runtime
dependency count is still three.

---

## Project layout

```
QuickBite/
├── server/
│   ├── index.js            Express app: middleware, routes, static site, errors
│   ├── db.js               SQLite connection, transactions, reference-data seed
│   ├── migrations.js       Forward-only, additive schema migrations
│   ├── auth.js             bcrypt hashing, JWTs, auth middleware
│   ├── middleware.js       Security headers, rate limiting, logging, validation
│   ├── pricing.js          THE source of truth for money
│   ├── orderState.js       Lifecycle, legal transitions, simulated kitchen clock
│   ├── data/menu.js        The 30-dish menu — single source of truth
│   ├── ai/
│   │   ├── recommend.js    Hybrid recommender
│   │   ├── assistant.js    Menu assistant (rules + optional LLM phrasing)
│   │   └── analytics.js    Analytics, forecasting, holdout evaluation
│   └── routes/             auth · menu · cart · orders · addresses · payments · ai · admin
├── public/
│   ├── index.html          Home: menu, recommendations, assistant, cart, checkout
│   ├── orders.html         Order history, live tracking, ratings
│   ├── admin.html          Kitchen dashboard
│   ├── css/style.css       Design system, light + dark
│   ├── css/cinematic.css   The dark cinematic treatment (scoped to html.qb-3d)
│   ├── css/scenes.css      Scenes 2 and 3, light page first
│   ├── js/api.js           API client, session, guest cart (shared)
│   ├── js/scenes.js        Scenes 2 and 3: content and interaction, no deps
│   ├── js/{app,orders,admin}.js
│   ├── js/cinematic/
│   │   ├── boot.js         Feature-detects, then lazy-loads the right tier
│   │   ├── scene.js        The WebGL world — burger and pizza — source
│   │   ├── motion.js       GSAP choreography for the Scene 2/3 DOM — source
│   │   └── *.bundle.js     Built artefacts, committed (npm run build:3d)
│   └── images/dishes/      30 photos + CREDITS.md
├── scripts/
│   ├── seed.js             Demo accounts, synthetic history, reviews
│   ├── visual-qa.js        Screenshot + console/overflow sweep in real Chrome
│   ├── build-cinematic.js  Tree-shakes and minifies the 3D bundle
│   ├── migrate.js          Deploy-time migration runner
│   └── fetch-images.js     Pulls openly-licensed dish photos from Commons
├── tests/                  170 tests across 8 suites
├── data/                   The SQLite file (git-ignored)
└── legacy/                 The original prototype, kept for reference
```

---

## API

JSON throughout. Authenticated routes take `Authorization: Bearer <token>`.

### Public

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness — runs a real query |
| `GET` | `/api/menu` | `?q= &category= &cuisine= &diet= &max_price= &spice= &sort=` |
| `GET` | `/api/menu/:idOrSlug` | One dish, with its reviews |
| `GET` | `/api/menu/coupons` | Active coupons (expired/exhausted hidden) |
| `POST` | `/api/menu/quote` | Price a basket without storing it (guests) |
| `POST` | `/api/auth/register` · `/api/auth/login` | Returns a JWT |
| `GET` | `/api/ai/recommendations` · `/api/ai/similar/:id` | |
| `POST` | `/api/ai/assistant` | |
| `GET` | `/api/ai/status` | Whether an LLM is configured |
| `POST` | `/api/payments/webhook` | Gateway callback — HMAC-verified |

### Customer

| Method | Route | Purpose |
| --- | --- | --- |
| `GET`/`PATCH` | `/api/auth/me` | Profile |
| `GET` | `/api/cart` | Cart with totals (`?coupon=`) |
| `POST` | `/api/cart/items` · `PATCH`/`DELETE` `/api/cart/items/:id` | |
| `DELETE` | `/api/cart` · `POST` `/api/cart/merge` | |
| `POST` | `/api/orders` | Checkout — accepts `Idempotency-Key` |
| `GET` | `/api/orders` | History (`?limit= &offset=`) |
| `GET` | `/api/orders/:id` | One order with its timeline |
| `POST` | `/api/orders/:id/cancel` · `/reorder` | |
| `POST` | `/api/menu/:id/favorite` · `/api/menu/:id/reviews` | |
| `GET`/`POST` | `/api/addresses` · `PATCH`/`DELETE` `/api/addresses/:id` | |
| `POST` | `/api/payments/intent` · `GET` `/api/payments/status/:orderId` | |

### Admin

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/orders` | `?status=live\|all\|placed…` |
| `GET` | `/api/admin/stats` · `/api/admin/menu` · `/api/admin/coupons` | |
| `PATCH` | `/api/admin/orders/:id` | Status — illegal transitions refused with 409 |
| `PATCH` | `/api/admin/menu/:id` · `/api/admin/coupons/:code` | |
| `GET` | `/api/ai/analytics` · `/api/ai/forecast` · `/api/ai/trends` | |

---

## How a few things work

**Money is never trusted from the client.** Every amount is a whole number of
rupees in an `INTEGER` column — there is no floating-point arithmetic anywhere in
the pricing path, so a total cannot drift by a paisa. `server/pricing.js`
recomputes the subtotal, discount, fees and GST from the database on every cart
read *and again* at checkout. A request claiming `{"total": 1}` is ignored; a
test asserts it.

**Checkout is one transaction.** Stock decrements, the order and its lines, the
coupon redemption, the cart clear and the idempotency claim either all happen or
none do. The decrement is guarded (`WHERE stock >= ?`), so two simultaneous
checkouts for the last portion cannot both succeed — the loser rolls back
entirely and gets a 409.

**Replays are safe.** Send the same `Idempotency-Key` twice and the second call
returns the original order with `replayed: true` instead of creating another.

**The kitchen clock is simulated.** Each order gets an ETA from its slowest dish
plus 15 minutes. `orderState.js` works out which stage it should be in whenever
it is read, and backfills any stages it passed through so the timeline stays
complete. An admin setting a status by hand clears `auto_advance`, handing
control to the kitchen. Transitions are validated in both directions — an order
cannot go backwards, skip a stage, or move once delivered.

**Payment status is decided by the server.** An order starts `pending` (or
`on_delivery` for cash) and only becomes `paid` when a webhook arrives with a
valid HMAC-SHA256 signature over the raw body *and* an amount matching the stored
total. Replays are ignored. The browser saying "paid" changes nothing.

---

## Testing

```bash
npm test                # all 170
npm run test:api        # 43 — auth, cart, coupons, checkout, stock, lifecycle, admin
npm run test:ai         # 24 — recommender, assistant grounding, forecast honesty
npm run test:security   # 20 — injection, IDOR, rate limits, headers, payments
npm run test:ui         # 21 — the real pages in jsdom against a live server
npm run test:browser    # 17 — real Chrome: layout, cascade, CSP, charts, a11y
npm run test:3d         # 30 — real Chrome: all three cinematic scenes
npm run test:assets     # 11 — photo files, licences, attribution, CSP hygiene
npm run test:startup    #  4 — port clashes and production config refusal
```

Each suite gets its own throwaway SQLite file, so suites never see each other's
data and nothing can touch a real database.

Highlights of what is actually asserted:

- a client-supplied `total` is ignored, and the server's figure is stored
- customer B gets 404 — not 403 — on every one of customer A's orders,
  addresses and payment records
- `WELCOME20` works once per account and is refused the second time
- an expired coupon is refused; a flat/percentage cap is applied
- stock cannot be oversold, and cancelling returns it
- an admin cannot move an order backwards, skip a stage, or touch a delivered one
- SQL injection payloads are stored as literal text and the schema survives
- a webhook with no signature, a wrong signature, or a mismatched amount leaves
  the order unpaid
- the assistant never names a dish or price that is not in the database
- the forecast refuses to predict below 14 days of history
- an order can still be placed while the AI endpoints are failing
- every redistributed photo is attributed with an author, licence and source
- the 3D burger's real transform changes continuously with scroll — and
  **rewinds exactly** when you scroll back up, which is what separates a
  scrubbed timeline from a play-once reveal. The same is asserted of the
  pizza, and of the Scene 2 cards
- the burger and the pizza are genuinely on stage together at the
  handoff, and both are gone before Scene 3 composes
- every flavour card's count, lowest price and photo are checked against
  the menu payload the page actually loaded, and every category on the
  menu has a card
- the featured dish's name, description, price, rating, prep time and
  photo all match a real menu row, and its Add-to-cart really reaches
  the cart
- the plate's pointer tilt inverts across its centre, and a tap on a
  touch device leaves no card stuck mid-tilt
- Scene 3 really is pinned: its box stays at the top of the viewport and
  fills it for the whole showcase
- the pizza's four layers separate to more than four times their resting
  spread and return to it exactly
- the Scene 2 cards arrive from measurably different translateZ values,
  their configured depths do not run in order, and their drift rewinds
- choosing a category still lands you on the menu — the defect that pin
  introduced, where a native smooth scroll was cancelled mid-flight and
  stranded the page inside the pinned section
- the journey's five legs wait at five different depths, climb in
  sequence and rewind. Two defects hid here, and both were invisible in
  the code: the pinned section above them adds a viewport of scroll
  distance, and until it was given a refresh priority every trigger
  below it resolved about 1035px too early, so the whole entrance played
  out below the fold and the stages were already flat on arrival. Then,
  because a staggered tween only writes a target's start values when
  that target's own slot opens, four of the five stood at their finished
  position until the scrub reached them and snapped backwards
- nothing is rendered at all once the act is behind you
- the ingredients genuinely separate mid-scroll and the layer stack
  returns to its resting height by the end
- reduced motion and a failed 3D bundle both leave a complete, working
  flat page

### Browser testing

`tests/browser.test.js` drives **real Chrome** through `playwright-core`, using
the browser already installed on the machine (no download). It guards the faults
jsdom structurally cannot see — a jsdom test reads `element.hidden === true` and
passes while the browser still paints the element:

- `[hidden]` genuinely removes an element, for every styled component family
- signing in actually removes the Sign-in button; a customer never sees the
  kitchen link; the admin tabs show one view at a time
- no page scrolls sideways at 320, 390, 820 or 1440 px
- no Content-Security-Policy violation on any page
- a failed photo really does fall back to the placeholder
- the analytics bars have genuine, varying heights
- Escape closes the cart and focus moves into it; the skip link appears on focus

`tests/cinematic.test.js` does the same for the cinematic scenes. They
expose their real rig values and scroll ranges on `window.__qbHero` and
`window.__qbMotion`, and the tests read them at offsets derived from
those ranges, because "the animation is genuinely scroll-linked" is the
one claim about this feature which a screenshot cannot settle.

Both suites **skip and say so** if Chrome or `playwright-core` is missing —
a skip is never counted as a pass.

> Several of the defects those tests now guard were invisible to every
> existing check and were only found by looking at the rendered page: the
> hero headline painting dark-on-dark (re-pointing a CSS custom property
> does nothing for elements that merely *inherit* a computed colour); the
> sticky header silently losing its stickiness because the rule that
> lifted page content above the WebGL canvas set `position: relative` on
> it; an onion ring standing on its edge like a bicycle wheel because
> `TorusGeometry` is built in the XY plane; and the Scene 2 cards being
> transparent enough mid-entrance for the pizza behind them to read
> straight through the artwork; half the pizza sitting behind the glass
> panel in Scene 3 (measured: pizza 463–977px, panel 140–715px); and a
> renderer quietly drawing an invisible canvas at 120fps.

```bash
npm run qa:visual       # screenshots at 3 widths + console/network/overflow report
```

`scripts/visual-qa.js` captures 50+ screenshots into `qa-screenshots/` and
reports console errors, failed requests, horizontal overflow, broken images and
clipped text. It is a QA tool, not part of the app.

### What is still **not** covered

- **Human judgement of the visuals.** The screenshots were reviewed and the
  layout faults they revealed were fixed, but "does this look good" is not
  something a test asserts.
- **Browsers other than Chrome.** Firefox and Safari/WebKit are unverified.
  This matters more now than it did: the 3D hero leans on WebGL,
  `backdrop-filter` and CSS mask gradients, none of which have been
  checked outside Chrome.
- **Frame rate on real low-end hardware.** The 118–121 fps figures are
  headless Chrome on a developer machine, measured during the pinned
  explode at 320, 390, 820 and 1440px. No phone, and no integrated-GPU
  laptop, has been profiled.
- **The modelled pizza is a generic margherita.** It is not a render of
  whichever dish the showcase names — that dish's real name, price,
  rating and photograph are in the panel beside it. If the menu's
  best-rated pizza changes, the 3D object does not.
- **Real devices.** Viewport emulation is not the same as a physical phone
  (touch targets, iOS Safari's dynamic toolbar, notch insets).
- **Screen readers.** Semantics, labels and focus order are checked
  programmatically; NVDA/VoiceOver behaviour is not.
- **Load and concurrency.** No load test has been run.

## Security

| Area | Measure |
| --- | --- |
| Passwords | bcrypt (cost 10); min 8 chars with a letter and a digit; common passwords rejected |
| Sessions | Stateless JWTs, 7-day expiry. Rotating `JWT_SECRET` revokes everything |
| Authorization | Every owned resource is queried with `WHERE … AND user_id = ?`; role checked server-side on every admin route |
| Enumeration | A missing account and a wrong password return the same message, and both run a bcrypt comparison so they take the same time |
| Privilege escalation | `role` is never read from a request body |
| SQL injection | Parameterised statements throughout; sort/filter values are whitelisted, never interpolated |
| XSS | All interpolated values pass through `escapeHtml`; a strict CSP (`default-src 'self'`, no inline scripts) |
| CSRF | Not applicable — auth is a `Bearer` header, not a cookie, so a cross-site form cannot carry it |
| Rate limiting | 10 credential attempts / 15 min, 10 checkouts / min, 20 assistant calls / min, 300 API calls / min, all per IP |
| Headers | CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP, HSTS in production |
| Errors | Stack traces never reach the client; responses carry a `request_id` that matches the server log |
| Logging | One JSON line per request — no bodies, no headers, no secrets |
| Dependencies | 3 runtime deps. `npm run audit:deps` reports 0 vulnerabilities |

**Known limitations, stated plainly:**

- Rate limiting is in-process, so it only holds for a single instance.
- JWTs cannot be revoked individually before expiry; rotating the secret revokes
  all of them at once.
- There is no email verification or password reset — both need a mail provider,
  which is not configured.
- The payment gateway is a sandbox. No real money moves, and no provider
  credentials exist in this repo.

---

## Configuration

See `.env.example` for the full list. The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | dev-only default | **Required** when `NODE_ENV=production` — the server refuses to start without it |
| `PORT` | `3000` | |
| `DB_FILE` | `data/quickbite.db` | |
| `TRUST_PROXY_HOPS` | `0` | Set to `1` behind a reverse proxy |
| `PAYMENT_WEBHOOK_SECRET` | *(none)* | Without it the webhook rejects everything |
| `ANTHROPIC_API_KEY` | *(none)* | Optional — only changes how the assistant *phrases* replies |

Useful commands:

```bash
npm run migrate -- --status    # what is applied, what is pending
npm run migrate -- --backup    # back up, then migrate
npm run reset                  # delete the database and re-seed from scratch
npm run images                 # re-fetch dish photography
npm run build:3d               # rebuild the cinematic 3D bundle
```

Deployment, backups and platform constraints: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Notes

- Requires **Node 22.5+** for `node:sqlite`. An experimental-feature warning on
  start is expected.
- Dish photography comes from Wikimedia Commons under licences that permit
  redistribution; every photo's author and licence is recorded in
  [`public/images/dishes/CREDITS.md`](public/images/dishes/CREDITS.md).
  `scripts/fetch-images.js` rejects anything non-redistributable, panoramic,
  chain-branded, or showing identifiable people, and pins reviewed choices by
  filename so re-running cannot silently swap a photo.
- `npm run seed` generates **synthetic** order history so the dashboard has
  something to analyse. Do not run it against a real database — use
  `npm run seed:accounts`.
- `legacy/` holds the original prototype and is not used by the app.
