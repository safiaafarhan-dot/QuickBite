/* QuickBite — order history and live tracking. */
(() => {
  'use strict';

  const { api, session, money, escapeHtml, formatDateTime, timeAgo, toast, theme } = window.QB;

  const list = document.getElementById('ordersList');
  const subtitle = document.getElementById('ordersSubtitle');

  const STEPS = [
    ['placed', 'Placed'],
    ['confirmed', 'Confirmed'],
    ['preparing', 'Cooking'],
    ['out_for_delivery', 'On the way'],
    ['delivered', 'Delivered'],
  ];

  const highlightId = Number(new URLSearchParams(location.search).get('order')) || null;
  let pollTimer = null;

  function tracker(order) {
    if (order.status === 'cancelled') {
      return '<p class="tracker-eta">This order was cancelled.</p>';
    }

    const index = STEPS.findIndex(([key]) => key === order.status);
    const progress = ((index + 1) / STEPS.length) * 100;

    const eta =
      order.status === 'delivered'
        ? `Delivered ${timeAgo(order.updated_at)}`
        : order.minutes_remaining > 0
          ? `Arriving in about <strong>${order.minutes_remaining} min</strong>`
          : '<strong>Arriving any moment now</strong>';

    return `
      <div class="tracker">
        <div class="tracker-bar"><div class="tracker-fill" style="width:${progress}%"></div></div>
        <div class="tracker-steps">
          ${STEPS.map(([key, label], i) => `<span class="tracker-step${i <= index ? ' is-done' : ''}">${label}</span>`).join('')}
        </div>
        <p class="tracker-eta">${eta}</p>
      </div>`;
  }

  function card(order) {
    const live = !['delivered', 'cancelled'].includes(order.status);
    const canCancel = ['placed', 'confirmed'].includes(order.status);

    return `
      <article class="order-card${live ? ' order-card--live' : ''}" data-order="${order.id}"
               ${order.id === highlightId ? 'id="highlighted"' : ''}>
        <header class="order-head">
          <div>
            <p class="order-code">${escapeHtml(order.code)}</p>
            <p class="order-when">${formatDateTime(order.placed_at)} · ${order.items.reduce((n, i) => n + i.quantity, 0)} item(s)</p>
          </div>
          <span class="status-pill" data-status="${order.status}">${escapeHtml(order.status_label)}</span>
        </header>

        <div class="order-body">
          ${tracker(order)}

          <div class="order-items">
            ${order.items
              .map(
                (i) => `
              <div class="order-item">
                <img src="${escapeHtml(i.image)}" alt="" onerror="this.onerror=null;this.src='images/placeholder.svg'" />
                <div>
                  <p class="order-item-name">${escapeHtml(i.name)}</p>
                  <p class="order-item-qty">${i.quantity} × ${money(i.price)}</p>
                </div>
                <span>${money(i.price * i.quantity)}</span>
              </div>`
              )
              .join('')}
          </div>

          <p class="order-address">📍 ${escapeHtml(order.address)} · ${escapeHtml(order.phone)}
            ${order.notes ? `<br />📝 ${escapeHtml(order.notes)}` : ''}
            ${order.coupon_code ? `<br />🎟 ${escapeHtml(order.coupon_code)} saved you ${money(order.discount)}` : ''}
          </p>

          <div class="order-foot">
            <div>
              <span class="order-total">${money(order.total)}</span>
              <span class="order-when"> · ${order.payment_method === 'cod' ? 'Cash on delivery' : order.payment_method.toUpperCase()}</span>
            </div>
            <div class="order-actions">
              ${canCancel ? `<button class="btn btn--ghost btn--sm" data-cancel="${order.id}">Cancel order</button>` : ''}
              <button class="btn btn--primary btn--sm" data-reorder="${order.id}">Reorder</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderGate() {
    list.innerHTML = `
      <div class="gate">
        <h2>Sign in to see your orders</h2>
        <p>Your order history and live tracking live in your QuickBite account.</p>
        <a class="btn btn--primary" href="index.html">Go to the menu and sign in</a>
      </div>`;
    subtitle.textContent = '';
  }

  async function load({ silent = false } = {}) {
    try {
      const { orders } = await api.orders(30);

      if (orders.length === 0) {
        list.innerHTML = `
          <div class="gate">
            <h2>No orders yet</h2>
            <p>Once you place your first order it will show up here with live tracking.</p>
            <a class="btn btn--primary" href="index.html#menu">Browse the menu</a>
          </div>`;
        subtitle.textContent = '';
        stopPolling();
        return;
      }

      list.innerHTML = orders.map(card).join('');

      const live = orders.filter((o) => !['delivered', 'cancelled'].includes(o.status));
      subtitle.textContent = live.length
        ? `${live.length} order${live.length > 1 ? 's' : ''} in progress — this page refreshes itself.`
        : 'All caught up. Here is everything you have ordered.';

      if (live.length > 0) startPolling();
      else stopPolling();

      if (!silent && highlightId) {
        document.getElementById('highlighted')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      if (err.status === 401) return renderGate();
      if (!silent) list.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
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

  list.addEventListener('click', async (e) => {
    const cancelBtn = e.target.closest('[data-cancel]');
    const reorderBtn = e.target.closest('[data-reorder]');
    if (!cancelBtn && !reorderBtn) return;

    const btn = cancelBtn || reorderBtn;
    btn.disabled = true;

    try {
      if (cancelBtn) {
        await api.cancelOrder(Number(cancelBtn.dataset.cancel));
        toast('Order cancelled', 'success');
        await load({ silent: true });
      } else {
        const { skipped } = await api.reorder(Number(reorderBtn.dataset.reorder));
        toast(
          skipped.length
            ? `Added to cart — ${skipped.join(', ')} is unavailable`
            : 'Items added back to your cart',
          skipped.length ? 'info' : 'success'
        );
        setTimeout(() => { location.href = 'index.html'; }, 900);
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollTimer) load({ silent: true });
  });

  (async function init() {
    theme.init();
    const user = await session.restore();
    document.querySelectorAll('.admin-link').forEach((a) => { a.hidden = user?.role !== 'admin'; });
    if (!user) return renderGate();
    load();
  })();
})();
