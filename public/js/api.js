/* QuickBite — shared API client, session store and guest cart.
   Loaded by every page before its own script.                           */
(() => {
  'use strict';

  const TOKEN_KEY = 'qb_token';
  const CART_KEY = 'qb_guest_cart';
  const COUPON_KEY = 'qb_coupon';
  const THEME_KEY = 'qb_theme';

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const token = localStorage.getItem(TOKEN_KEY);
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Cannot reach the QuickBite server. Is it running?', 0);
    }

    const payload = res.status === 204 ? {} : await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 && token) session.clear();
      throw new ApiError(payload.error || `Request failed (${res.status})`, res.status);
    }
    return payload;
  }

  const api = {
    ApiError,
    health: () => request('/health', { auth: false }),

    register: (data) => request('/auth/register', { method: 'POST', body: data, auth: false }),
    login: (data) => request('/auth/login', { method: 'POST', body: data, auth: false }),
    me: () => request('/auth/me'),
    updateProfile: (data) => request('/auth/me', { method: 'PATCH', body: data }),

    menu: (params = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== '' && v != null)
      ).toString();
      return request(`/menu${qs ? `?${qs}` : ''}`);
    },
    coupons: () => request('/menu/coupons', { auth: false }),
    quote: (items, coupon) => request('/menu/quote', { method: 'POST', body: { items, coupon } }),
    toggleFavorite: (id) => request(`/menu/${id}/favorite`, { method: 'POST' }),

    getCart: (coupon) => request(`/cart${coupon ? `?coupon=${encodeURIComponent(coupon)}` : ''}`),
    addToCart: (item_id, quantity, coupon) =>
      request('/cart/items', { method: 'POST', body: { item_id, quantity, coupon } }),
    setCartQty: (item_id, quantity, coupon) =>
      request(`/cart/items/${item_id}`, { method: 'PATCH', body: { quantity, coupon } }),
    clearCart: () => request('/cart', { method: 'DELETE' }),
    mergeCart: (items, coupon) => request('/cart/merge', { method: 'POST', body: { items, coupon } }),

    placeOrder: (data) => request('/orders', { method: 'POST', body: data }),
    orders: (limit = 20) => request(`/orders?limit=${limit}`),
    order: (id) => request(`/orders/${id}`),
    cancelOrder: (id) => request(`/orders/${id}/cancel`, { method: 'POST' }),
    reorder: (id) => request(`/orders/${id}/reorder`, { method: 'POST' }),

    adminOrders: (status = 'all') => request(`/admin/orders?status=${status}`),
    adminStats: () => request('/admin/stats'),
    adminSetStatus: (id, status) => request(`/admin/orders/${id}`, { method: 'PATCH', body: { status } }),
    adminSetMenu: (id, patch) => request(`/admin/menu/${id}`, { method: 'PATCH', body: patch }),
  };

  /* ---------------------------------------------------------------- */
  /* Session                                                           */
  /* ---------------------------------------------------------------- */

  const listeners = new Set();

  const session = {
    user: null,

    get token() {
      return localStorage.getItem(TOKEN_KEY);
    },
    get isLoggedIn() {
      return Boolean(this.user);
    },
    get isAdmin() {
      return this.user?.role === 'admin';
    },

    save(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      this.user = user;
      this.emit();
    },

    clear() {
      localStorage.removeItem(TOKEN_KEY);
      this.user = null;
      this.emit();
    },

    /** Restores the signed-in user on page load; resolves to the user or null. */
    async restore() {
      if (!this.token) return null;
      try {
        const { user } = await api.me();
        this.user = user;
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        this.user = null;
      }
      this.emit();
      return this.user;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      listeners.forEach((fn) => fn(this.user));
    },
  };

  /* ---------------------------------------------------------------- */
  /* Cart — server-backed when signed in, localStorage when not        */
  /* ---------------------------------------------------------------- */

  const guest = {
    read() {
      try {
        const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter((l) => l && l.item_id && l.quantity > 0) : [];
      } catch {
        return [];
      }
    },
    write(lines) {
      localStorage.setItem(CART_KEY, JSON.stringify(lines));
    },
    clear() {
      localStorage.removeItem(CART_KEY);
    },
  };

  const cart = {
    /** Latest server-priced snapshot: { items, count, subtotal, total, ... } */
    state: { items: [], count: 0, subtotal: 0, discount: 0, delivery_fee: 0, tax: 0, total: 0, coupon: null },

    get coupon() {
      return localStorage.getItem(COUPON_KEY) || '';
    },
    set coupon(code) {
      if (code) localStorage.setItem(COUPON_KEY, code.toUpperCase());
      else localStorage.removeItem(COUPON_KEY);
    },

    async refresh() {
      this.state = session.isLoggedIn
        ? await api.getCart(this.coupon)
        : await api.quote(guest.read(), this.coupon);
      return this.state;
    },

    async add(itemId, quantity = 1) {
      if (session.isLoggedIn) {
        this.state = await api.addToCart(itemId, quantity, this.coupon);
      } else {
        const lines = guest.read();
        const line = lines.find((l) => l.item_id === itemId);
        if (line) line.quantity = Math.min(line.quantity + quantity, 20);
        else lines.push({ item_id: itemId, quantity: Math.min(quantity, 20) });
        guest.write(lines);
        this.state = await api.quote(lines, this.coupon);
      }
      return this.state;
    },

    async setQuantity(itemId, quantity) {
      if (session.isLoggedIn) {
        this.state = await api.setCartQty(itemId, quantity, this.coupon);
      } else {
        let lines = guest.read();
        if (quantity <= 0) lines = lines.filter((l) => l.item_id !== itemId);
        else {
          const line = lines.find((l) => l.item_id === itemId);
          if (line) line.quantity = Math.min(quantity, 20);
          else lines.push({ item_id: itemId, quantity: Math.min(quantity, 20) });
        }
        guest.write(lines);
        this.state = await api.quote(lines, this.coupon);
      }
      return this.state;
    },

    async clear() {
      if (session.isLoggedIn) this.state = await api.clearCart();
      else {
        guest.clear();
        this.state = await api.quote([], '');
      }
      this.coupon = '';
      return this.state;
    },

    /** Called right after sign-in: folds the guest basket into the account. */
    async adoptGuestCart() {
      const lines = guest.read();
      if (lines.length > 0) {
        this.state = await api.mergeCart(lines, this.coupon);
        guest.clear();
      } else {
        this.state = await api.getCart(this.coupon);
      }
      return this.state;
    },
  };

  /* ---------------------------------------------------------------- */
  /* Small shared helpers                                              */
  /* ---------------------------------------------------------------- */

  const money = (rupees) => `₹${Number(rupees || 0).toLocaleString('en-IN')}`;

  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  function timeAgo(sqliteUtc) {
    const then = Date.parse(`${String(sqliteUtc).replace(' ', 'T')}Z`);
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    return new Date(then).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function formatDateTime(sqliteUtc) {
    const t = Date.parse(`${String(sqliteUtc).replace(' ', 'T')}Z`);
    if (Number.isNaN(t)) return '';
    return new Date(t).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  }

  /** Bottom-right toast. `type` is 'info' | 'success' | 'error'. */
  function toast(message, type = 'info') {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast--out');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, 3200);
  }

  const theme = {
    apply(name) {
      document.documentElement.dataset.theme = name;
      localStorage.setItem(THEME_KEY, name);
      document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
        btn.textContent = name === 'dark' ? '☀️' : '🌙';
        btn.setAttribute('aria-label', name === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      });
    },
    toggle() {
      this.apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    },
    init() {
      const saved = localStorage.getItem(THEME_KEY);
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      this.apply(saved || (prefersDark ? 'dark' : 'light'));
      document.addEventListener('click', (e) => {
        if (e.target.closest('[data-theme-toggle]')) this.toggle();
      });
    },
  };

  window.QB = { api, session, cart, guestCart: guest, money, escapeHtml, timeAgo, formatDateTime, toast, theme };
})();
