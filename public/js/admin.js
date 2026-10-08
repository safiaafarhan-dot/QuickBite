/* QuickBite — restaurant dashboard: live orders, stock, analytics, forecast. */
(() => {
  'use strict';

  const { api, session, money, escapeHtml, timeAgo, toast, theme } = window.QB;

  const el = {};
  for (const id of [
    'adminMain', 'adminGate', 'gateTitle', 'gateText', 'gateLink', 'whoami',
    'statGrid', 'adminOrders', 'orderFilter', 'topItems', 'lowStock', 'menuAdmin', 'refreshMenu',
    'viewOperations', 'viewAnalytics', 'hourChart', 'dailyChart', 'categoryMix',
    'peakHour', 'forecastPanel', 'trendsPanel', 'couponUsage', 'siteHeader',
  ]) el[id] = document.getElementById(id);

  const STATUSES = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
  const LABELS = {
    placed: 'Placed', confirmed: 'Confirmed', preparing: 'Preparing',
    out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled',
  };

  let analyticsLoaded = false;

  /* ================================================================ */
  /* Gate                                                              */
  /* ================================================================ */

  function showGate(title, text) {
    el.gateTitle.textContent = title;
    el.gateText.textContent = text;
    el.gateLink.hidden = false;
    el.adminMain.hidden = true;
    el.adminGate.hidden = false;
  }

  /* ================================================================ */
  /* Operations                                                        */
  /* ================================================================ */

  function renderStats({ stats, top_items, low_stock }) {
    el.statGrid.innerHTML = [
      ['Revenue', money(stats.revenue), `${money(stats.average_order)} average`],
      ['Orders', stats.orders, `${stats.cancelled} cancelled`],
      ['In progress', stats.live, 'right now'],
      ['Delivered', stats.delivered, 'all time'],
      ['Customers', stats.customers, 'registered'],
      ['Discounts given', money(stats.discounts_given), 'via coupons'],
    ].map(([label, value, note]) => `
      <div class="stat-card">
        <span>${label}</span>
        <strong>${value}</strong>
        <em>${note}</em>
      </div>`).join('');

    el.topItems.innerHTML = top_items.length === 0
      ? '<li><span>No sales yet.</span></li>'
      : top_items.map((i) => `
          <li><span>${escapeHtml(i.name)}</span><strong>${i.units} · ${money(i.revenue)}</strong></li>`).join('');

    el.lowStock.innerHTML = low_stock.length === 0
      ? '<li><span>Everything is well stocked.</span></li>'
      : low_stock.map((i) => `
          <li><span>${escapeHtml(i.name)}</span>
              <strong style="color:${i.stock === 0 ? 'var(--brand)' : 'var(--saffron)'}">${i.stock} left</strong></li>`).join('');
  }

  function renderOrders(orders) {
    if (orders.length === 0) {
      el.adminOrders.innerHTML = '<p class="state" style="padding:40px 0"><span class="state-emoji">🍽️</span><br />No orders in this view.</p>';
      return;
    }

    el.adminOrders.innerHTML = orders.map((o) => {
      // Only offer statuses the order may legally move to.
      const allowed = {
        placed: ['confirmed', 'preparing', 'cancelled'],
        confirmed: ['preparing', 'cancelled'],
        preparing: ['out_for_delivery', 'cancelled'],
        out_for_delivery: ['delivered', 'cancelled'],
        delivered: [], cancelled: [],
      }[o.status] || [];

      return `
      <div class="admin-order" data-order="${o.id}">
        <div class="admin-order-top">
          <div>
            <strong>${escapeHtml(o.code)}</strong>
            <span class="status-pill" data-status="${o.status}">${escapeHtml(o.status_label)}</span>
            <p class="admin-order-meta">
              ${escapeHtml(o.customer_name)} · ${escapeHtml(o.user_email)} · ${timeAgo(o.placed_at)}
            </p>
          </div>
          <div class="admin-order-right">
            <strong>${money(o.total)}</strong>
            ${allowed.length === 0
              ? '<span class="order-when">closed</span>'
              : `<select class="select" data-status-for="${o.id}" aria-label="Change status for ${escapeHtml(o.code)}">
                   <option value="">Move to…</option>
                   ${allowed.map((s) => `<option value="${s}">${LABELS[s]}</option>`).join('')}
                 </select>`}
          </div>
        </div>
        <p class="admin-order-items">${o.items.map((i) => `${i.quantity} × ${escapeHtml(i.name)}`).join(' · ')}</p>
        <p class="admin-order-meta">
          📍 ${escapeHtml(o.address)} · ${escapeHtml(o.phone)} ·
          ${escapeHtml(o.payment_method.toUpperCase())} (${escapeHtml(o.payment_status)})
          ${o.notes ? `<br />📝 ${escapeHtml(o.notes)}` : ''}
        </p>
      </div>`;
    }).join('');
  }

  function renderMenuAdmin(items) {
    el.menuAdmin.innerHTML = items.map((i) => `
      <div class="menu-admin-row" data-menu="${i.id}">
        <span title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        <input type="number" min="0" step="10" value="${i.price}" data-price-for="${i.id}"
               aria-label="Price for ${escapeHtml(i.name)}" />
        <input type="number" min="0" step="1" value="${i.stock}" data-stock-for="${i.id}"
               aria-label="Stock for ${escapeHtml(i.name)}" />
        <label class="switch">
          <input type="checkbox" data-available-for="${i.id}" ${i.is_available ? 'checked' : ''} />
          <span>On</span>
        </label>
      </div>`).join('');
  }

  async function refreshOperations() {
    try {
      const [{ orders }, stats] = await Promise.all([
        api.adminOrders(el.orderFilter.value),
        api.adminStats(),
      ]);
      renderStats(stats);
      renderOrders(orders);

      // The menu rows hold editable inputs, so they are drawn once and then
      // left alone — a ten-second refresh must not wipe out mid-edit typing.
      if (!el.menuAdmin.dataset.rendered) {
        const menu = await api.adminMenu();
        renderMenuAdmin(menu.items);
        el.menuAdmin.dataset.rendered = '1';
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return showGate('Admin access required', 'Sign in with the kitchen account to open this dashboard.');
      }
      toast(err.message, 'error');
    }
  }

  el.orderFilter.addEventListener('change', refreshOperations);

  el.refreshMenu.addEventListener('click', async () => {
    delete el.menuAdmin.dataset.rendered;
    await refreshOperations();
    toast('Menu reloaded');
  });

  el.adminOrders.addEventListener('change', async (e) => {
    const select = e.target.closest('[data-status-for]');
    if (!select || !select.value) return;

    const status = select.value;
    select.disabled = true;

    try {
      await api.adminSetStatus(Number(select.dataset.statusFor), status);
      toast(`Order moved to "${LABELS[status]}"`, 'success');
      refreshOperations();
    } catch (err) {
      toast(err.message, 'error');
      select.disabled = false;
      select.value = '';
    }
  });

  /** Menu edits save on change, so the dashboard stays keyboard-friendly. */
  el.menuAdmin.addEventListener('change', async (e) => {
    const row = e.target.closest('[data-menu]');
    if (!row) return;

    const id = Number(row.dataset.menu);
    const patch = {
      price: Number(row.querySelector('[data-price-for]').value),
      stock: Number(row.querySelector('[data-stock-for]').value),
      is_available: row.querySelector('[data-available-for]').checked,
    };

    try {
      await api.adminSetMenu(id, patch);
      toast('Menu updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ================================================================ */
  /* Charts (plain CSS bars — no chart library)                        */
  /* ================================================================ */

  function barChart(target, rows, { valueKey = 'orders', labelKey = 'label', max } = {}) {
    if (rows.length === 0) {
      target.innerHTML = '<p style="color:var(--text-3);font-size:.88rem">No data yet.</p>';
      return;
    }

    const peak = max ?? Math.max(...rows.map((r) => r[valueKey]), 1);

    target.innerHTML = `
      <div class="bars">
        ${rows.map((r) => `
          <div class="bar-col" title="${escapeHtml(String(r[labelKey]))}: ${r[valueKey]}">
            <div class="bar${r.muted ? ' bar--muted' : ''}" style="height:${Math.max((r[valueKey] / peak) * 100, 2)}%"></div>
            <span class="bar-label">${escapeHtml(String(r[labelKey]))}</span>
          </div>`).join('')}
      </div>`;
  }

  async function loadAnalytics() {
    try {
      const [data, forecast, trends] = await Promise.all([
        api.analytics(),
        api.forecast(7),
        api.trends(),
      ]);

      // Orders by hour — only the hours the kitchen actually sees traffic.
      const hours = data.by_hour.filter((h) => h.orders > 0);
      barChart(el.hourChart, hours.length ? hours : data.by_hour.slice(10, 23));
      el.peakHour.textContent = data.peak_hour
        ? `Busiest at ${data.peak_hour.label}`
        : '';

      // Daily orders — last 14 days, with the forecast appended in grey.
      const recent = data.daily.slice(-14).map((d) => ({
        label: d.day.slice(5),
        orders: d.orders,
      }));
      const projected = forecast.available
        ? forecast.days.map((d) => ({ label: d.day.slice(5), orders: d.orders, muted: true }))
        : [];

      barChart(el.dailyChart, [...recent, ...projected]);
      if (projected.length) {
        el.dailyChart.insertAdjacentHTML('beforeend', `
          <div class="chart-legend">
            <span><i style="background:var(--brand)"></i>Actual</span>
            <span><i style="background:var(--border-strong)"></i>Forecast</span>
          </div>`);
      }

      el.categoryMix.innerHTML = data.category_mix.length === 0
        ? '<li><span>No sales yet.</span></li>'
        : data.category_mix.map((c) => `
            <li><span>${escapeHtml(c.category)}</span><strong>${c.units} · ${money(c.revenue)}</strong></li>`).join('');

      el.couponUsage.innerHTML = data.coupons.length === 0
        ? '<li><span>No coupons redeemed yet.</span></li>'
        : data.coupons.map((c) => `
            <li><span>${escapeHtml(c.code)}</span><strong>${c.redemptions} × · ${money(c.discount_given)} given</strong></li>`).join('');

      renderForecast(forecast);
      renderTrends(trends);
    } catch (err) {
      if (err.status === 403 || err.status === 401) return;
      toast(err.message, 'error');
    }
  }

  function renderForecast(forecast) {
    if (!forecast.available) {
      el.forecastPanel.innerHTML = `
        <div class="notice">
          <strong>Not enough history to forecast yet</strong>
          ${escapeHtml(forecast.message)}
        </div>`;
      return;
    }

    const accuracy = forecast.accuracy
      ? `<p style="font-size:.8rem;color:var(--text-3);margin-top:10px">
           Measured on a held-out week: average error
           <strong>${forecast.accuracy.mae_orders}</strong> orders/day${
             forecast.accuracy.mape_percent !== null ? ` (${forecast.accuracy.mape_percent}%)` : ''}.
         </p>`
      : '<p style="font-size:.8rem;color:var(--text-3);margin-top:10px">Not enough history to measure accuracy yet.</p>';

    el.forecastPanel.innerHTML = `
      <p style="font-size:.84rem;color:var(--text-2);margin-bottom:12px">
        Method: ${escapeHtml(forecast.method)}, from ${forecast.days_of_history} days of orders.
      </p>
      <table class="forecast-table">
        <thead><tr><th>Day</th><th>Expected orders</th><th>Revenue</th></tr></thead>
        <tbody>
          ${forecast.days.map((d) => `
            <tr>
              <td>${escapeHtml(d.weekday.slice(0, 3))} ${escapeHtml(d.day.slice(5))}</td>
              <td>${d.orders}</td>
              <td>${money(d.revenue)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${accuracy}`;
  }

  function renderTrends(trends) {
    if (!trends.available) {
      el.trendsPanel.innerHTML = `<div class="notice">${escapeHtml(trends.message)}</div>`;
      return;
    }

    const list = (rows, colour) => rows.map((r) => `
      <li>
        <span>${escapeHtml(r.name)}</span>
        <strong style="color:${colour}">
          ${r.change_percent === null ? 'new' : `${r.change_percent > 0 ? '+' : ''}${r.change_percent}%`}
        </strong>
      </li>`).join('');

    el.trendsPanel.innerHTML = `
      ${trends.rising.length ? `<h4 style="font-size:.8rem;color:var(--text-3);margin-bottom:8px">RISING</h4>
        <ul class="top-items" style="margin-bottom:16px">${list(trends.rising, 'var(--leaf)')}</ul>` : ''}
      ${trends.falling.length ? `<h4 style="font-size:.8rem;color:var(--text-3);margin-bottom:8px">SLOWING</h4>
        <ul class="top-items">${list(trends.falling, 'var(--brand)')}</ul>` : ''}`;
  }

  /* ================================================================ */
  /* View switching                                                    */
  /* ================================================================ */

  document.querySelector('.admin-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-view]');
    if (!tab) return;

    document.querySelectorAll('[data-view]').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });

    const analytics = tab.dataset.view === 'analytics';
    el.viewOperations.hidden = analytics;
    el.viewAnalytics.hidden = !analytics;

    if (analytics && !analyticsLoaded) {
      analyticsLoaded = true;
      loadAnalytics();
    }
  });

  window.addEventListener('scroll', () => {
    el.siteHeader.classList.toggle('is-stuck', window.scrollY > 20);
  }, { passive: true });

  /* ================================================================ */
  /* Boot                                                              */
  /* ================================================================ */

  (async function init() {
    theme.init();
    const user = await session.restore();

    if (!user) {
      return showGate('Sign in required', 'Open the menu page, sign in with the kitchen account, then come back.');
    }
    if (user.role !== 'admin') {
      return showGate('Admin access required', `You are signed in as ${user.email}, which is a customer account.`);
    }

    el.whoami.textContent = `Signed in as ${user.email}`;
    el.adminGate.hidden = true;
    el.adminMain.hidden = false;

    await refreshOperations();
    setInterval(() => {
      if (!document.hidden && !el.viewOperations.hidden) refreshOperations();
    }, 10000);
  })();
})();
