'use strict';

/**
 * Sales analytics and demand forecasting.
 *
 * The forecast is a seasonal-naive baseline (same weekday last week) blended
 * with a moving average, and it is *only* produced when there is enough history
 * to justify it. Below that threshold the API returns descriptive analytics and
 * says plainly that there is not enough data — it never dresses up a guess as a
 * prediction.
 *
 * Accuracy is reported from a real holdout: the last 7 days are predicted using
 * only the days before them, and the error is measured against what happened.
 */

const { db } = require('./../db');

/** Minimum distinct days of sales before a forecast is offered at all. */
const MIN_DAYS_FOR_FORECAST = 14;
/** Below this, a weekday-seasonal term is meaningless. */
const MIN_DAYS_FOR_SEASONALITY = 21;
const HOLDOUT_DAYS = 7;

const dailyOrders = db.prepare(`
  SELECT date(placed_at) AS day,
         COUNT(*)        AS orders,
         SUM(total)      AS revenue
  FROM orders
  WHERE status != 'cancelled'
  GROUP BY day
  ORDER BY day
`);

const hourly = db.prepare(`
  SELECT CAST(strftime('%H', placed_at) AS INTEGER) AS hour,
         COUNT(*) AS orders,
         SUM(total) AS revenue
  FROM orders
  WHERE status != 'cancelled'
  GROUP BY hour ORDER BY hour
`);

const weekday = db.prepare(`
  SELECT CAST(strftime('%w', placed_at) AS INTEGER) AS weekday,
         COUNT(*) AS orders,
         SUM(total) AS revenue
  FROM orders
  WHERE status != 'cancelled'
  GROUP BY weekday ORDER BY weekday
`);

const topDishes = db.prepare(`
  SELECT oi.item_id, oi.name,
         SUM(oi.quantity) AS units,
         SUM(oi.quantity * oi.price) AS revenue,
         COUNT(DISTINCT oi.order_id) AS orders
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.status != 'cancelled'
  GROUP BY oi.item_id, oi.name
  ORDER BY units DESC
  LIMIT 10
`);

const categoryMix = db.prepare(`
  SELECT m.category,
         SUM(oi.quantity) AS units,
         SUM(oi.quantity * oi.price) AS revenue
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN menu_items m ON m.id = oi.item_id
  WHERE o.status != 'cancelled'
  GROUP BY m.category
  ORDER BY revenue DESC
`);

const couponUse = db.prepare(`
  SELECT code, COUNT(*) AS redemptions, SUM(amount_off) AS discount_given
  FROM coupon_redemptions GROUP BY code ORDER BY redemptions DESC
`);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/* ------------------------------------------------------------------ */
/* Series helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turns sparse daily rows into a continuous series with explicit zeros, so a
 * quiet day counts as "no orders" rather than disappearing from the average.
 */
function densify(rows) {
  if (rows.length === 0) return [];

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const start = new Date(`${rows[0].day}T00:00:00Z`);
  const end = new Date(`${rows[rows.length - 1].day}T00:00:00Z`);
  const series = [];

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    series.push({
      day: key,
      weekday: d.getUTCDay(),
      orders: row ? row.orders : 0,
      revenue: row ? row.revenue : 0,
    });
  }
  return series;
}

/**
 * Predicts one day from the history before it.
 *
 * Blends a trailing 7-day mean with the same weekday a week earlier. When
 * there is not enough history for the seasonal term, it degrades to the mean.
 */
function predictNext(history, targetWeekday) {
  if (history.length === 0) return { orders: 0, revenue: 0 };

  const recent = history.slice(-7);
  const trailingOrders = mean(recent.map((d) => d.orders));
  const trailingRevenue = mean(recent.map((d) => d.revenue));

  const sameWeekday = history.filter((d) => d.weekday === targetWeekday);
  if (history.length < MIN_DAYS_FOR_SEASONALITY || sameWeekday.length < 2) {
    return { orders: trailingOrders, revenue: trailingRevenue };
  }

  const seasonalOrders = mean(sameWeekday.slice(-3).map((d) => d.orders));
  const seasonalRevenue = mean(sameWeekday.slice(-3).map((d) => d.revenue));

  // 60% weekday pattern, 40% recent level.
  return {
    orders: 0.6 * seasonalOrders + 0.4 * trailingOrders,
    revenue: 0.6 * seasonalRevenue + 0.4 * trailingRevenue,
  };
}

/**
 * Walk-forward evaluation on the final `HOLDOUT_DAYS` days: each is predicted
 * using only the days before it. Returns MAE and MAPE, or null when the series
 * is too short for the holdout to mean anything.
 */
function evaluate(series) {
  if (series.length < MIN_DAYS_FOR_FORECAST + HOLDOUT_DAYS) return null;

  const errors = [];
  const percentages = [];

  for (let i = series.length - HOLDOUT_DAYS; i < series.length; i++) {
    const actual = series[i];
    const predicted = predictNext(series.slice(0, i), actual.weekday);
    const error = Math.abs(predicted.orders - actual.orders);
    errors.push(error);
    if (actual.orders > 0) percentages.push((error / actual.orders) * 100);
  }

  return {
    holdout_days: HOLDOUT_DAYS,
    mae_orders: Number(mean(errors).toFixed(2)),
    mape_percent: percentages.length ? Number(mean(percentages).toFixed(1)) : null,
    note: 'Measured on the most recent 7 days, each predicted using only earlier days.',
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Descriptive analytics — always available, whatever the data volume. */
function describe() {
  const daily = dailyOrders.all();
  const series = densify(daily);

  const hours = hourly.all();
  const peak = hours.length
    ? hours.reduce((best, h) => (h.orders > best.orders ? h : best), hours[0])
    : null;

  const days = weekday.all().map((d) => ({ ...d, name: DAY_NAMES[d.weekday] }));
  const busiestDay = days.length
    ? days.reduce((best, d) => (d.orders > best.orders ? d : best), days[0])
    : null;

  const totals = db.prepare(`
    SELECT COUNT(*) AS orders,
           COALESCE(SUM(total), 0) AS revenue,
           COALESCE(SUM(discount), 0) AS discounts
    FROM orders WHERE status != 'cancelled'
  `).get();

  return {
    totals: {
      ...totals,
      average_order: totals.orders > 0 ? Math.round(totals.revenue / totals.orders) : 0,
      days_of_history: series.length,
      distinct_selling_days: daily.length,
    },
    daily: series,
    by_hour: hours.map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00` })),
    by_weekday: days,
    peak_hour: peak ? { ...peak, label: `${String(peak.hour).padStart(2, '0')}:00` } : null,
    busiest_day: busiestDay,
    top_items: topDishes.all(),
    category_mix: categoryMix.all(),
    coupons: couponUse.all(),
  };
}

/**
 * Demand forecast for the next `horizon` days.
 *
 * @returns {{available: boolean, reason?: string, days?: object[], accuracy?: object}}
 */
function forecast({ horizon = 7 } = {}) {
  const series = densify(dailyOrders.all());

  if (series.length < MIN_DAYS_FOR_FORECAST) {
    return {
      available: false,
      reason: 'insufficient-data',
      message:
        `A forecast needs at least ${MIN_DAYS_FOR_FORECAST} days of order history; `
        + `there ${series.length === 1 ? 'is' : 'are'} ${series.length} so far. `
        + 'The descriptive figures above are real; no prediction is being shown.',
      days_available: series.length,
      days_required: MIN_DAYS_FOR_FORECAST,
    };
  }

  const history = [...series];
  const days = [];
  const last = new Date(`${series[series.length - 1].day}T00:00:00Z`);

  for (let i = 1; i <= Math.min(horizon, 14); i++) {
    const target = new Date(last);
    target.setUTCDate(target.getUTCDate() + i);

    const prediction = predictNext(history, target.getUTCDay());
    const day = {
      day: target.toISOString().slice(0, 10),
      weekday: DAY_NAMES[target.getUTCDay()],
      orders: Math.round(prediction.orders),
      revenue: Math.round(prediction.revenue),
    };
    days.push(day);

    // Feed the prediction forward so later days build on earlier ones.
    history.push({ ...day, weekday: target.getUTCDay() });
  }

  return {
    available: true,
    method: series.length >= MIN_DAYS_FOR_SEASONALITY
      ? 'seasonal-naive blended with a 7-day moving average'
      : '7-day moving average (not enough history for a weekday pattern yet)',
    days,
    accuracy: evaluate(series),
    days_of_history: series.length,
  };
}

/** Dishes whose sales are trending up or down over the last two weeks. */
function trends() {
  const rows = db.prepare(`
    SELECT oi.name,
           SUM(CASE WHEN o.placed_at >= datetime('now', '-7 days')  THEN oi.quantity ELSE 0 END) AS recent,
           SUM(CASE WHEN o.placed_at <  datetime('now', '-7 days')
                     AND o.placed_at >= datetime('now', '-14 days') THEN oi.quantity ELSE 0 END) AS previous
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'cancelled' AND o.placed_at >= datetime('now', '-14 days')
    GROUP BY oi.name
  `).all();

  const movers = rows
    .filter((r) => r.recent + r.previous >= 3)   // ignore one-off noise
    .map((r) => ({
      name: r.name,
      recent: r.recent,
      previous: r.previous,
      change_percent: r.previous === 0
        ? null
        : Number((((r.recent - r.previous) / r.previous) * 100).toFixed(1)),
    }))
    .sort((a, b) => (b.change_percent ?? 0) - (a.change_percent ?? 0));

  return {
    available: movers.length > 0,
    message: movers.length === 0
      ? 'Not enough recent sales to compare week on week yet.'
      : null,
    rising: movers.filter((m) => (m.change_percent ?? 0) > 0).slice(0, 5),
    falling: movers.filter((m) => (m.change_percent ?? 0) < 0).slice(-5).reverse(),
  };
}

module.exports = {
  describe,
  forecast,
  trends,
  densify,
  predictNext,
  evaluate,
  MIN_DAYS_FOR_FORECAST,
};
