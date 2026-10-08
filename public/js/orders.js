/* QuickBite — order history, live tracking and dish ratings. */
(() => {
  'use strict';

  const {
    api, session, money, escapeHtml,
    formatDateTime, timeAgo, toast, theme, installImageFallback,
  } = window.QB;

  const el = {};
  for (const id of [
    'ordersList', 'ordersSubtitle', 'loadMoreBtn', 'scrim',
    'reviewModal', 'reviewForm', 'reviewStars', 'reviewDish', 'reviewImage',
    'reviewError', 'reviewSubmit', 'siteHeader',
  ]) el[id] = document.getElementById(id);

  const STEPS = [
    ['placed', 'Placed'],
    ['confirmed', 'Confirmed'],
    ['preparing', 'Cooking'],
    ['out_for_delivery', 'On the way'],
    ['delivered', 'Delivered'],
  ];

  const PAGE_SIZE = 10;

  const highlightId = Number(new URLSearchParams(location.search).get('order')) || null;

  let orders = [];
  let offset = 0;
  let hasMore = false;
  let pollTimer = null;
  let reviewTarget = null;
  let reviewRating = 0;

  /* ================================================================ */
  /* Rendering                                                         */
  /* ================================================================ */

  function tracker(order) {
    if (order.status === 'cancelled') {
      return '<p class="tracker-eta">This order was cancelled and the kitchen was told.</p>';
    }

    const index = STEPS.findIndex(([key]) => key === order.status);
    const progress = ((index + 1) / STEPS.length) * 100;

    const eta = order.status === 'delivered'
      ? `Delivered ${timeAgo(order.updated_at)}`
      : order.minutes_remaining > 0
        ? `Arriving in about <strong>${order.minutes_remaining} min</strong>`
        : '<strong>Arriving any moment now</strong>';

    return `
      <div class="tracker">
        <div class="tracker-bar" role="progressbar" aria-valuenow="${Math.round(progress)}"
             aria-valuemin="0" aria-valuemax="100" aria-label="Order progress">
          <div class="tracker-fill" style="width:${progress}%"></div>
        </div>
        <div class="tracker-steps">
          ${STEPS.map(([, label], i) =>
            `<span class="tracker-step${i <= index ? ' is-done' : ''}">${label}</span>`).join('')}
        </div>
        <p class="tracker-eta">${eta}</p>
      </div>`;
  }

  function paymentLabel(order) {
    if (order.payment_method === 'cod') return 'Cash on delivery';
    const state = { paid: 'paid', pending: 'awaiting payment', failed: 'payment failed' }[order.payment_status];
    return `${order.payment_method.toUpperCase()}${state ? ` · ${state}` : ''}`;
  }

  function card(order) {
    const live = !['delivered', 'cancelled'].includes(order.status);
    const delivered = order.status === 'delivered';

    return `
      <article class="order-card${live ? ' order-card--live' : ''}"
               data-order="${order.id}" ${order.id === highlightId ? 'id="highlighted"' : ''}>
        <header class="order-head">
          <div>
            <p class="order-code">${escapeHtml(order.code)}</p>
            <p class="order-when">
              ${formatDateTime(order.placed_at)} ·
              ${order.items.reduce((n, i) => n + i.quantity, 0)} item(s) ·
              ${escapeHtml(paymentLabel(order))}
            </p>
          </div>
          <span class="status-pill" data-status="${order.status}">${escapeHtml(order.status_label)}</span>
        </header>

        <div class="order-body">
          ${tracker(order)}

          <div class="order-items">
            ${order.items.map((i) => `
              <div class="order-item">
                <img src="${escapeHtml(i.image)}" alt="" />
                <div>
                  <p class="order-item-name">${escapeHtml(i.name)}</p>
                  <p class="order-item-qty">${i.quantity} × ${money(i.price)}</p>
                </div>
                <span>${money(i.price * i.quantity)}</span>
              </div>`).join('')}
          </div>

          ${delivered ? `
            <div class="rate-row">
              <span>Enjoyed it? Rate what you ate:</span>
              ${order.items.filter((i) => i.item_id).map((i) => `
                <button class="btn btn--ghost btn--sm"
                        data-rate="${i.item_id}"
                        data-rate-name="${escapeHtml(i.name)}"
                        data-rate-image="${escapeHtml(i.image)}">★ ${escapeHtml(i.name)}</button>`).join('')}
            </div>` : ''}

          <p class="order-address">
            📍 ${escapeHtml(order.address)} · ${escapeHtml(order.phone)}
            ${order.notes ? `<br />📝 ${escapeHtml(order.notes)}` : ''}
            ${order.coupon_code ? `<br />🎟 ${escapeHtml(order.coupon_code)} saved you ${money(order.discount)}` : ''}
          </p>

          <div class="order-foot">
            <div>
              <span class="order-total">${money(order.total)}</span>
              <span class="order-when"> · ${escapeHtml(paymentLabel(order))}</span>
            </div>
            <div class="order-actions">
              ${order.can_cancel ? `<button class="btn btn--ghost btn--sm" data-cancel="${order.id}">Cancel order</button>` : ''}
              <button class="btn btn--primary btn--sm" data-reorder="${order.id}">Reorder</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function skeleton() {
    return Array.from({ length: 2 }, () => `
      <div class="order-card" aria-hidden="true">
        <div class="order-head"><div class="sk-line w40 skeleton" style="height:16px;width:120px"></div></div>
        <div class="order-body">
          <div class="sk-line skeleton" style="height:7px"></div>
          <div class="sk-line w80 skeleton"></div>
          <div class="sk-line w60 skeleton"></div>
        </div>
      </div>`).join('');
  }

  function renderGate(title, text) {
    el.ordersList.innerHTML = `
      <div class="gate">
        <p class="state-emoji">🔐</p>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(text)}</p>
        <a class="btn btn--primary" href="index.html">Go to the menu and sign in</a>
      </div>`;
    el.ordersSubtitle.textContent = '';
    el.loadMoreBtn.hidden = true;
  }

  function render() {
    if (orders.length === 0) {
      el.ordersList.innerHTML = `
        <div class="gate">
          <p class="state-emoji">🧾</p>
          <h2>No orders yet</h2>
          <p>Once you place your first order it will appear here with live tracking.</p>
          <a class="btn btn--primary" href="index.html#menu">Browse the menu</a>
        </div>`;
      el.ordersSubtitle.textContent = '';
      el.loadMoreBtn.hidden = true;
      stopPolling();
      return;
    }

    el.ordersList.innerHTML = orders.map(card).join('');
    el.loadMoreBtn.hidden = !hasMore;

    const live = orders.filter((o) => !['delivered', 'cancelled'].includes(o.status));
    el.ordersSubtitle.textContent = live.length
      ? `${live.length} order${live.length > 1 ? 's' : ''} in progress — this page refreshes itself.`
      : 'All caught up. Here is everything you have ordered.';

    if (live.length > 0) startPolling();
    else stopPolling();
  }

  /* ================================================================ */
  /* Loading                                                           */
  /* ================================================================ */

  async function load({ silent = false, append = false } = {}) {
    if (!silent && !append) el.ordersList.innerHTML = skeleton();

    try {
      const data = await api.orders({ limit: PAGE_SIZE, offset: append ? offset : 0 });

      orders = append ? [...orders, ...data.orders] : data.orders;
      offset = orders.length;
      hasMore = data.page.has_more;

      render();

      if (!silent && highlightId) {
        document.getElementById('highlighted')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      if (err.status === 401) {
        return renderGate('Sign in to see your orders', 'Your order history and live tracking live in your QuickBite account.');
      }
      if (!silent) {
        el.ordersList.innerHTML = `
          <div class="state">
            <p class="state-emoji">⚠️</p>
            <h3>We couldn't load your orders</h3>
            <p>${escapeHtml(err.message)}</p>
            <button class="btn btn--primary" id="retryOrders">Try again</button>
          </div>`;
      }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!document.hidden) load({ silent: true });
    }, 8000);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  el.loadMoreBtn?.addEventListener('click', () => load({ append: true }));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollTimer) load({ silent: true });
  });

  /* ================================================================ */
  /* Actions                                                           */
  /* ================================================================ */

  el.ordersList.addEventListener('click', async (e) => {
    if (e.target.id === 'retryOrders') return load();

    const rateBtn = e.target.closest('[data-rate]');
    if (rateBtn) return openReview(rateBtn);

    const cancelBtn = e.target.closest('[data-cancel]');
    const reorderBtn = e.target.closest('[data-reorder]');
    if (!cancelBtn && !reorderBtn) return;

    const btn = cancelBtn || reorderBtn;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    try {
      if (cancelBtn) {
        await api.cancelOrder(Number(cancelBtn.dataset.cancel));
        toast('Order cancelled — nothing will be charged.', 'success');
        await load({ silent: true });
      } else {
        const { skipped } = await api.reorder(Number(reorderBtn.dataset.reorder));
        toast(
          skipped.length
            ? `Added to cart — ${skipped.join(', ')} is unavailable today`
            : 'Items added back to your cart',
          skipped.length ? 'info' : 'success'
        );
        setTimeout(() => { location.href = 'index.html'; }, 900);
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  /* ================================================================ */
  /* Reviews                                                           */
  /* ================================================================ */

  function renderStars() {
    el.reviewStars.innerHTML = [1, 2, 3, 4, 5].map((n) => `
      <button type="button" class="star-btn${n <= reviewRating ? ' is-on' : ''}"
              data-star="${n}" role="radio" aria-checked="${n === reviewRating}"
              aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('');
  }

  function openReview(btn) {
    reviewTarget = Number(btn.dataset.rate);
    reviewRating = 0;

    el.reviewDish.textContent = btn.dataset.rateName;
    el.reviewImage.src = btn.dataset.rateImage;
    el.reviewImage.alt = btn.dataset.rateName;
    el.reviewForm.elements.comment.value = '';
    el.reviewError.hidden = true;

    renderStars();

    el.reviewModal.classList.add('is-open');
    el.reviewModal.setAttribute('aria-hidden', 'false');
    el.scrim.hidden = false;
    document.body.classList.add('no-scroll');
  }

  function closeReview() {
    el.reviewModal.classList.remove('is-open');
    el.reviewModal.setAttribute('aria-hidden', 'true');
    el.scrim.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  el.reviewStars.addEventListener('click', (e) => {
    const star = e.target.closest('[data-star]');
    if (!star) return;
    reviewRating = Number(star.dataset.star);
    renderStars();
  });

  el.reviewForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (reviewRating < 1) {
      el.reviewError.textContent = 'Please pick a rating from 1 to 5 stars.';
      el.reviewError.hidden = false;
      return;
    }

    el.reviewSubmit.disabled = true;
    el.reviewSubmit.textContent = 'Saving…';

    try {
      await api.review(reviewTarget, {
        rating: reviewRating,
        comment: el.reviewForm.elements.comment.value,
      });
      closeReview();
      toast('Thanks — your rating is live on the menu.', 'success');
    } catch (err) {
      el.reviewError.textContent = err.message;
      el.reviewError.hidden = false;
    } finally {
      el.reviewSubmit.disabled = false;
      el.reviewSubmit.textContent = 'Submit rating';
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) closeReview();
  });
  el.scrim.addEventListener('click', closeReview);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.reviewModal.classList.contains('is-open')) closeReview();
  });

  window.addEventListener('scroll', () => {
    el.siteHeader.classList.toggle('is-stuck', window.scrollY > 20);
  }, { passive: true });

  /* ================================================================ */
  /* Boot                                                              */
  /* ================================================================ */

  (async function init() {
    theme.init();
    installImageFallback();

    const user = await session.restore();
    document.querySelectorAll('.admin-link').forEach((a) => { a.hidden = user?.role !== 'admin'; });

    if (!user) {
      return renderGate('Sign in to see your orders', 'Your order history and live tracking live in your QuickBite account.');
    }
    load();
  })();
})();
