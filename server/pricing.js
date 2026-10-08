'use strict';

const { db } = require('./db');

const DELIVERY_FEE = 40;          // ₹ flat
const FREE_DELIVERY_ABOVE = 500;  // ₹ subtotal
const TAX_PERCENT = 5;            // GST

const findCoupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1');

/**
 * Prices a set of `{ price, quantity }` lines. All money is whole rupees so
 * the client can never disagree with the server about a total.
 *
 * @returns {{subtotal:number, discount:number, delivery_fee:number, tax:number,
 *            total:number, coupon:object|null, coupon_error:string|null}}
 */
function priceCart(lines, couponCode) {
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

  let discount = 0;
  let deliveryFee = subtotal === 0 || subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  let coupon = null;
  let couponError = null;

  const code = (couponCode || '').trim().toUpperCase();
  if (code) {
    const found = findCoupon.get(code);
    if (!found) {
      couponError = `Coupon ${code} is not valid.`;
    } else if (subtotal < found.min_subtotal) {
      couponError = `Coupon ${code} needs a subtotal of at least ₹${found.min_subtotal}.`;
    } else {
      coupon = found;
      if (found.percent_off > 0) {
        discount = Math.round((subtotal * found.percent_off) / 100);
        if (found.max_discount > 0) discount = Math.min(discount, found.max_discount);
      }
      if (found.flat_off > 0) discount += found.flat_off;
      discount = Math.min(discount, subtotal);
      if (found.free_delivery) deliveryFee = 0;
    }
  }

  const taxable = Math.max(subtotal - discount, 0);
  const tax = Math.round((taxable * TAX_PERCENT) / 100);
  const total = taxable + deliveryFee + tax;

  return {
    subtotal,
    discount,
    delivery_fee: deliveryFee,
    tax,
    total,
    coupon: coupon
      ? { code: coupon.code, description: coupon.description }
      : null,
    coupon_error: couponError,
    rules: {
      delivery_fee: DELIVERY_FEE,
      free_delivery_above: FREE_DELIVERY_ABOVE,
      tax_percent: TAX_PERCENT,
    },
  };
}

/** Delivery ETA: slowest item prep time + 15 min on the road. */
function estimateEta(lines) {
  const slowest = lines.reduce((max, l) => Math.max(max, l.prep_minutes || 20), 0);
  return slowest + 15;
}

module.exports = { priceCart, estimateEta, DELIVERY_FEE, FREE_DELIVERY_ABOVE, TAX_PERCENT };
