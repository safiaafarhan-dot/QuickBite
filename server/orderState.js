'use strict';

const { transaction } = require('./db');

/** Ordered lifecycle. `cancelled` is terminal and lives outside the chain. */
const FLOW = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
const ALL_STATUSES = [...FLOW, 'cancelled'];

const LABELS = {
  placed: 'Order placed',
  confirmed: 'Restaurant confirmed',
  preparing: 'Being prepared',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * Which statuses each status may move to. An order only ever moves forward
 * along the chain, and nothing moves out of a terminal state.
 */
const ALLOWED_TRANSITIONS = {
  placed: ['confirmed', 'preparing', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/** Customers may call off an order only before the kitchen starts cooking. */
const CUSTOMER_CANCELLABLE = ['placed', 'confirmed'];

const canCustomerCancel = (status) => CUSTOMER_CANCELLABLE.includes(status);

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function canTransition(from, to) {
  if (!ALL_STATUSES.includes(to)) return { ok: false, reason: `Unknown status "${to}".` };
  if (from === to) return { ok: false, reason: `The order is already ${LABELS[to].toLowerCase()}.` };

  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length === 0
        ? `A ${from.replace(/_/g, ' ')} order cannot change status.`
        : `An order cannot go from "${from}" to "${to}".`,
    };
  }
  return { ok: true };
}

/**
 * Fraction of the ETA at which each stage begins, so a 35-minute order and a
 * 20-minute order both feel right while tracking.
 */
const STAGE_AT = {
  confirmed: 0.05,
  preparing: 0.15,
  out_for_delivery: 0.6,
  delivered: 1,
};

const SELECT_LIVE = `
  SELECT id, status, eta_minutes, placed_at
  FROM orders
  WHERE auto_advance = 1 AND status NOT IN ('delivered', 'cancelled')
`;
const SELECT_LIVE_ONE = `
  SELECT id, status, eta_minutes, placed_at
  FROM orders
  WHERE id = $1 AND auto_advance = 1 AND status NOT IN ('delivered', 'cancelled')
`;
const UPDATE_STATUS = 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2';
const INSERT_EVENT = 'INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)';
const EVENT_EXISTS = 'SELECT 1 FROM order_events WHERE order_id = $1 AND status = $2';

/**
 * Minutes since a stored UTC timestamp.
 *
 * The database layer renders timestamps as `'YYYY-MM-DD HH:MM:SS'` in UTC —
 * the same shape SQLite stored — so this parses exactly as it always did.
 */
function minutesSince(utcTimestamp) {
  const placed = Date.parse(`${String(utcTimestamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(placed)) return 0;
  return (Date.now() - placed) / 60000;
}

function expectedStatus(order) {
  const elapsed = minutesSince(order.placed_at);
  const eta = Math.max(order.eta_minutes, 1);
  let status = 'placed';
  for (const stage of ['confirmed', 'preparing', 'out_for_delivery', 'delivered']) {
    if (elapsed >= eta * STAGE_AT[stage]) status = stage;
  }
  return status;
}

async function advanceOne(tx, order) {
  const target = expectedStatus(order);
  if (FLOW.indexOf(target) <= FLOW.indexOf(order.status)) return order.status;

  // Backfill every stage the order passed through so the timeline stays honest.
  for (let i = FLOW.indexOf(order.status) + 1; i <= FLOW.indexOf(target); i++) {
    const stage = FLOW[i];
    if (!(await tx.get(EVENT_EXISTS, [order.id, stage]))) {
      await tx.run(INSERT_EVENT, [order.id, stage, '']);
    }
  }
  await tx.run(UPDATE_STATUS, [target, order.id]);
  return target;
}

/**
 * Brings every live order (or just one) up to date with the clock.
 *
 * The reads and the writes run in one transaction now. Under SQLite this was a
 * sequence of statements on the single connection that owned the file; against
 * a pooled PostgreSQL they could otherwise interleave with a concurrent
 * request and write a status derived from a row another connection had already
 * moved on.
 */
async function advanceOrders(orderId) {
  await transaction(async (tx) => {
    const rows = orderId
      ? await tx.all(SELECT_LIVE_ONE, [orderId])
      : await tx.all(SELECT_LIVE);

    for (const row of rows) await advanceOne(tx, row);
  });
}

module.exports = {
  FLOW,
  ALL_STATUSES,
  LABELS,
  ALLOWED_TRANSITIONS,
  canTransition,
  canCustomerCancel,
  advanceOrders,
  minutesSince,
};
