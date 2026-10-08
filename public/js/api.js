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
    constructor(message, status, payload) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload || {};
    }
  }

  async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

    const token = localStorage.getItem(TOKEN_KEY);
    if (auth && token) requestHeaders.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Cannot reach the QuickBite server. Is it running?', 0);
    }

    const payload = res.status === 204 ? {} : await res.json().catch(() => ({}));

    if (!res.ok) {
      // An expired or revoked token should quietly sign the user out rather
      // than leaving the page in a half-authenticated state.
      if (res.status === 401 && token) session.clear();
      throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload);
    }
    return payload;
  }

  /** Builds a query string, dropping empty values. */
  const qs = (params) => {
    const search = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false)
    ).toString();
    return search ? `?${search}` : '';
  };

  const api = {
    ApiError,
    health: () => request('/health', { auth: false }),

    // Auth
    register: (data) => request('/auth/register', { method: 'POST', body: data, auth: false }),
    login: (data) => request('/auth/login', { method: 'POST', body: data, auth: false }),
    me: () => request('/auth/me'),
    updateProfile: (data) => request('/auth/me', { method: 'PATCH', body: data }),

    // Menu
    menu: (params = {}) => request(`/menu${qs(params)}`),
    dish: (idOrSlug) => request(`/menu/${encodeURIComponent(idOrSlug)}`),
    coupons: () => request('/menu/coupons', { auth: false }),
    quote: (items, coupon) => request('/menu/quote', { method: 'POST', body: { items, coupon } }),
    toggleFavorite: (id) => request(`/menu/${id}/favorite`, { method: 'POST' }),
    review: (id, data) => request(`/menu/${id}/reviews`, { method: 'POST', body: data }),

    // Cart
    getCart: (coupon) => request(`/cart${qs({ coupon })}`),
    addToCart: (item_id, quantity, coupon) =>
      request('/cart/items', { method: 'POST', body: { item_id, quantity, coupon } }),
    setCartQty: (item_id, quantity, coupon) =>
      request(`/cart/items/${item_id}`, { method: 'PATCH', body: { quantity, coupon } }),
    clearCart: () => request('/cart', { method: 'DELETE' }),
    mergeCart: (items, coupon) => request('/cart/merge', { method: 'POST', body: { items, coupon } }),

    // Orders
    placeOrder: (data, idempotencyKey) =>
      request('/orders', {
        method: 'POST',
        body: data,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      }),
    orders: (params = {}) => request(`/orders${qs(params)}`),
    order: (id) => request(`/orders/${id}`),
    cancelOrder: (id) => request(`/orders/${id}/cancel`, { method: 'POST' }),
    reorder: (id) => request(`/orders/${id}/reorder`, { method: 'POST' }),

    // Addresses
    addresses: () => request('/addresses'),
    addAddress: (data) => request('/addresses', { method: 'POST', body: data }),
    updateAddress: (id, data) => request(`/addresses/${id}`, { method: 'PATCH', body: data }),
    defaultAddress: (id) => request(`/addresses/${id}/default`, { method: 'POST' }),
    deleteAddress: (id) => request(`/addresses/${id}`, { method: 'DELETE' }),

    // AI
    recommendations: (params = {}) => request(`/ai/recommendations${qs(params)}`),
    similar: (id, limit = 4) => request(`/ai/similar/${id}${qs({ limit })}`),
    askAssistant: (question) => request('/ai/assistant', { method: 'POST', body: { question } }),
    trackEvent: (item_id, action = 'view') =>
      request('/ai/events', { method: 'POST', body: { item_id, action } }).catch(() => {}),
    aiStatus: () => request('/ai/status', { auth: false }),
    analytics: () => request('/ai/analytics'),
    forecast: (horizon = 7) => request(`/ai/forecast${qs({ horizon })}`),
    trends: () => request('/ai/trends'),

    // Payments
    paymentIntent: (order_id) => request('/payments/intent', { method: 'POST', body: { order_id } }),
    paymentStatus: (orderId) => request(`/payments/status/${orderId}`),

    // Admin
    adminOrders: (status = 'all') => request(`/admin/orders${qs({ status })}`),
    adminStats: () => request('/admin/stats'),
    adminMenu: () => request('/admin/menu'),
    adminSetStatus: (id, status) => request(`/admin/orders/${id}`, { method: 'PATCH', body: { status } }),
    adminSetMenu: (id, patch) => request(`/admin/menu/${id}`, { method: 'PATCH', body: patch }),
    adminCoupons: () => request('/admin/coupons'),
    adminSetCoupon: (code, patch) => request(`/admin/coupons/${code}`, { method: 'PATCH', body: patch }),
  };

  /* ---------------------------------------------------------------- */
  /* Session                                                           */
  /* ---------------------------------------------------------------- */

  const listeners = new Set();

  const session = {
    user: null,

    get token() { return localStorage.getItem(TOKEN_KEY); },
    get isLoggedIn() { return Boolean(this.user); },
    get isAdmin() { return this.user?.role === 'admin'; },

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
      if (!this.token) { this.emit(); return null; }
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

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { listeners.forEach((fn) => fn(this.user)); },
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
    write(lines) { localStorage.setItem(CART_KEY, JSON.stringify(lines)); },
    clear() { localStorage.removeItem(CART_KEY); },
  };

  const EMPTY_CART = {
    items: [], count: 0, subtotal: 0, discount: 0,
    delivery_fee: 0, small_order_fee: 0, tax: 0, total: 0, coupon: null,
  };

  const cart = {
    /** Latest server-priced snapshot. Never computed on the client. */
    state: { ...EMPTY_CART },

    get coupon() { return localStorage.getItem(COUPON_KEY) || ''; },
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

    /** How many of one dish are currently in the basket. */
    quantityOf(itemId) {
      return this.state.items.find((l) => l.item_id === itemId)?.quantity || 0;
    },
  };

  /* ---------------------------------------------------------------- */
  /* Formatting and small shared helpers                               */
  /* ---------------------------------------------------------------- */

  const money = (rupees) => `₹${Number(rupees || 0).toLocaleString('en-IN')}`;

  const escapeHtml = (str) =>
    String(str ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  const PLACEHOLDER = 'images/placeholder.svg';

  /**
   * Swaps in the placeholder for any image that fails to load.
   *
   * This is a single delegated listener rather than an inline `onerror`
   * attribute, because the Content-Security-Policy (`script-src 'self'`) blocks
   * inline event handlers — an inline fallback would silently never run.
   * `error` does not bubble, so the listener is registered in the capture phase.
   */
  function installImageFallback() {
    document.addEventListener('error', (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.fallbackApplied === '1') return;   // avoid a loop
      img.dataset.fallbackApplied = '1';
      img.src = PLACEHOLDER;
    }, true);
  }

  function timeAgo(sqliteUtc) {
    const then = Date.parse(`${String(sqliteUtc).replace(' ', 'T')}Z`);
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    return new Date(then).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function formatDateTime(sqliteUtc) {
    const t = Date.parse(`${String(sqliteUtc).replace(' ', 'T')}Z`);
    if (Number.isNaN(t)) return '';
    return new Date(t).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  }

  const spiceLabel = (level) => ['Mild', 'Gentle heat', 'Spicy', 'Very spicy'][level] || 'Mild';
  const stars = (rating) => '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));

  /** Bottom-centre toast. `type` is 'info' | 'success' | 'error'. */
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
      setTimeout(() => el.remove(), 600);
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

  /** Debounces `fn` so typing does not fire a request per keystroke. */
  function debounce(fn, wait = 220) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** A random key so a double-submitted checkout cannot create two orders. */
  const newIdempotencyKey = () =>
    (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  window.QB = {
    api, session, cart, guestCart: guest,
    money, escapeHtml, timeAgo, formatDateTime, spiceLabel, stars,
    toast, theme, debounce, newIdempotencyKey, installImageFallback, PLACEHOLDER,
  };
})();
