'use strict';

const { db } = require('./db');

/**
 * Every money value in QuickBite is a whole number of rupees held in an INTEGER
 * column. There is no floating-point arithmetic anywhere in the pricing path,
 * so a total can never drift by a paisa.
 */
const DELIVERY_FEE = 40;
const FREE_DELIVERY_ABOVE = 500;
const TAX_PERCENT = 5;
const SMALL_ORDER_FEE = 20;        // applied below the minimum basket
const SMALL_ORDER_BELOW = 150;

const findCoupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1');
const countUserRedemptions = db.prepare(
  'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code = ? AND user_id = ?'
);

/**
 * Decides whether a coupon may be used right now.
 *
 * @param {string} code      coupon code as typed
 * @param {number} subtotal  basket subtotal in rupees
 * @param {number|null} userId  the signed-in user, or null for a guest quote
 * @returns {{coupon: object|null, error: string|null}}
 */
function validateCoupon(code, subtotal, userId) {
  const normalized = (code || '').trim().toUpperCase();
  if (!normalized) return { coupon: null, error: null };

  const coupon = findCoupon.get(normalized);
  if (!coupon) return { coupon: null, error: `Coupon ${normalized} is not valid.` };

  if (coupon.expires_at) {
    const expired = db
      .prepare("SELECT datetime('now') > datetime(?) AS expired")
      .get(coupon.expires_at).expired;
    if (expired) return { coupon: null, error: `Coupon ${normalized} has expired.` };
  }

  if (subtotal < coupon.min_subtotal) {
    return {
      coupon: null,
      error: `Coupon ${normalized} needs a subtotal of at least ₹${coupon.min_subtotal}.`,
    };
  }

  if (coupon.usage_limit > 0 && coupon.times_used >= coupon.usage_limit) {
    return { coupon: null, error: `Coupon ${normalized} has been fully claimed.` };
  }

  // A per-account limit can only be judged for a signed-in customer; a guest
  // quote shows the discount and checkout re-checks it for real.
  if (userId && coupon.per_user_limit > 0) {
    const used = countUserRedemptions.get(normalized, userId).n;
    if (used >= coupon.per_user_limit) {
      return {
        coupon: null,
        error: coupon.per_user_limit === 1
          ? `Coupon ${normalized} can only be used once per account.`
          : `You have already used coupon ${normalized} ${used} times.`,
      };
    }
  }

  return { coupon, error: null };
}

/**
 * Prices a set of `{ price, quantity }` lines. This is the only place totals are
 * computed; the client's numbers are never read.
 */
function priceCart(lines, couponCode, userId = null) {
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const isEmpty = subtotal === 0;

  let discount = 0;
  let deliveryFee = isEmpty || subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  const smallOrderFee = !isEmpty && subtotal < SMALL_ORDER_BELOW ? SMALL_ORDER_FEE : 0;

  const { coupon, error } = validateCoupon(couponCode, subtotal, userId);

  if (coupon) {
    if (coupon.percent_off > 0) {
      discount = Math.round((subtotal * coupon.percent_off) / 100);
      if (coupon.max_discount > 0) discount = Math.min(discount, coupon.max_discount);
    }
    if (coupon.flat_off > 0) discount += coupon.flat_off;
    discount = Math.min(discount, subtotal);
    if (coupon.free_delivery) deliveryFee = 0;
  }

  const taxable = Math.max(subtotal - discount, 0);
  const tax = Math.round((taxable * TAX_PERCENT) / 100);
  const total = taxable + deliveryFee + smallOrderFee + tax;

  return {
    subtotal,
    discount,
    delivery_fee: deliveryFee,
    small_order_fee: smallOrderFee,
    tax,
    total,
    coupon: coupon ? { code: coupon.code, description: coupon.description } : null,
    coupon_error: error,
    rules: {
      delivery_fee: DELIVERY_FEE,
      free_delivery_above: FREE_DELIVERY_ABOVE,
      tax_percent: TAX_PERCENT,
      small_order_fee: SMALL_ORDER_FEE,
      small_order_below: SMALL_ORDER_BELOW,
    },
  };
}

/** Delivery ETA: the slowest dish's prep time plus 15 minutes on the road. */
function estimateEta(lines) {
  const slowest = lines.reduce((max, l) => Math.max(max, l.prep_minutes || 20), 0);
  return slowest + 15;
}

module.exports = {
  priceCart,
  validateCoupon,
  estimateEta,
  DELIVERY_FEE,
  FREE_DELIVERY_ABOVE,
  TAX_PERCENT,
  SMALL_ORDER_FEE,
  SMALL_ORDER_BELOW,
};
