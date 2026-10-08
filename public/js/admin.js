/* QuickBite — restaurant-side dashboard (admin role only). */
(() => {
  'use strict';

  const { api, session, money, escapeHtml, timeAgo, toast, theme } = window.QB;

  const el = {
    main: document.getElementById('adminMain'),
    gate: document.getElementById('adminGate'),
    gateTitle: document.getElementById('gateTitle'),
    gateText: document.getElementById('gateText'),
    gateLink: document.getElementById('gateLink'),
    whoami: document.getElementById('whoami'),
    statGrid: document.getElementById('statGrid'),
    orders: document.getElementById('adminOrders'),
    filter: document.getElementById('orderFilter'),
    topItems: document.getElementById('topItems'),
    menuAdmin: document.getElementById('menuAdmin'),
  };

  const STATUSES = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
  const LABELS = {
    placed: 'Placed', confirmed: 'Confirmed', preparing: 'Preparing',
    out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled',
  };

  function showGate(title, text) {
    el.gateTitle.textContent = title;
    el.gateText.textContent = text;
    el.gateLink.hidden = false;
    el.main.hidden = true;
    el.gate.hidden = false;
  }

  function renderStats({ stats, top_items }) {
    el.statGrid.innerHTML = [
      ['Revenue', money(stats.revenue)],
      ['Orders', stats.orders],
      ['In progress', stats.live],
      ['Delivered', stats.delivered],
      ['Customers', stats.customers],
    ]
      .map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`)
      .join('');

    el.topItems.innerHTML =
      top_items.length === 0
        ? '<li><span>No sales yet.</span></li>'
        : top_items
            .map(
              (i) =>
                `<li><span>${escapeHtml(i.name)}</span><strong>${i.units} · ${money(i.revenue)}</strong></li>`
            )
            .join('');
  }

  function renderOrders(orders) {
    if (orders.length === 0) {
      el.orders.innerHTML = '<p class="empty-state">No orders in this view.</p>';
      return;
    }

    el.orders.innerHTML = orders
      .map(
        (o) => `
      <div class="admin-order" data-order="${o.id}">
        <div class="admin-order-top">
          <div>
            <strong>${escapeHtml(o.code)}</strong>
            <span class="status-pill" data-status="${o.status}">${escapeHtml(o.status_label)}</span>
            <p class="admin-order-meta">${escapeHtml(o.customer_name)} · ${escapeHtml(o.user_email)} · ${timeAgo(o.placed_at)}</p>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <strong>${money(o.total)}</strong>
            <select class="status-select" data-status-for="${o.id}">
              ${STATUSES.map(
                (s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${LABELS[s]}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <p class="admin-order-items">${o.items
          .map((i) => `${i.quantity} × ${escapeHtml(i.name)}`)
          .join(' · ')}</p>
        <p class="admin-order-meta">📍 ${escapeHtml(o.address)} · ${escapeHtml(o.phone)} · ${o.payment_method.toUpperCase()}
          ${o.notes ? `<br />📝 ${escapeHtml(o.notes)}` : ''}</p>
      </div>`
      )
      .join('');
  }

  function renderMenu(items) {
    el.menuAdmin.innerHTML = items
      .map(
        (i) => `
      <div class="menu-admin-row" data-menu="${i.id}">
        <span>${escapeHtml(i.name)}</span>
        <input type="number" min="0" step="10" value="${i.price}" data-price-for="${i.id}" aria-label="Price for ${escapeHtml(i.name)}" />
        <label class="switch">
          <input type="checkbox" data-available-for="${i.id}" ${i.is_available ? 'checked' : ''} />
          <span>Available</span>
        </label>
      </div>`
      )
      .join('');
  }

  async function refresh() {
    try {
      const [{ orders }, stats, menu] = await Promise.all([
        api.adminOrders(el.filter.value),
        api.adminStats(),
        api.menu(),
      ]);
      renderStats(stats);
      renderOrders(orders);
      // The menu rows hold editable inputs, so they are drawn once and then
      // left alone — a ten-second refresh must not wipe out mid-edit typing.
      if (!el.menuAdmin.dataset.rendered) {
        renderMenu(menu.items);
        el.menuAdmin.dataset.rendered = '1';
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return showGate('Admin access required', 'Sign in with the admin account to open the kitchen dashboard.');
      }
      toast(err.message, 'error');
    }
  }

  el.filter.addEventListener('change', refresh);

  el.orders.addEventListener('change', async (e) => {
    const select = e.target.closest('[data-status-for]');
    if (!select) return;
    try {
      await api.adminSetStatus(Number(select.dataset.statusFor), select.value);
      toast(`Order moved to “${LABELS[select.value]}”`, 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* Menu edits save on blur / toggle so the dashboard stays keyboard-friendly. */
  el.menuAdmin.addEventListener('change', async (e) => {
    const priceInput = e.target.closest('[data-price-for]');
    const availableInput = e.target.closest('[data-available-for]');
    if (!priceInput && !availableInput) return;

    const id = Number((priceInput || availableInput).dataset.priceFor || availableInput.dataset.availableFor);
    const row = el.menuAdmin.querySelector(`[data-menu="${id}"]`);
    const patch = {
      price: Number(row.querySelector('[data-price-for]').value),
      is_available: row.querySelector('[data-available-for]').checked,
    };

    try {
      await api.adminSetMenu(id, patch);
      toast('Menu updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  (async function init() {
    theme.init();
    const user = await session.restore();

    if (!user) {
      return showGate('Sign in required', 'Open the menu page, sign in with the admin account, then come back.');
    }
    if (user.role !== 'admin') {
      return showGate('Admin access required', `You are signed in as ${user.email}, which is a customer account.`);
    }

    el.whoami.textContent = `Signed in as ${user.email}`;
    el.gate.hidden = true;
    el.main.hidden = false;

    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  })();
})();
