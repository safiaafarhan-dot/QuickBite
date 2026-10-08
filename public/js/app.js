/* QuickBite — home page: menu browsing, cart drawer, auth and checkout. */
(() => {
  'use strict';

  const { api, session, cart, money, escapeHtml, toast, theme } = window.QB;
  const $ = (sel) => document.querySelector(sel);

  const el = {
    menuGrid: $('#menuGrid'),
    menuEmpty: $('#menuEmpty'),
    categoryChips: $('#categoryChips'),
    dietChips: document.querySelectorAll('[data-diet]'),
    search: $('#searchInput'),
    sort: $('#sortSelect'),
    statItems: $('#statItems'),
    couponStrip: $('#couponStrip'),

    cartBtn: $('#cartBtn'),
    cartCount: $('#cartCount'),
    drawer: $('#cartDrawer'),
    cartBody: $('#cartBody'),
    cartFoot: $('#cartFoot'),
    cartTotals: $('#cartTotals'),
    closeCart: $('#closeCart'),
    clearCartBtn: $('#clearCartBtn'),
    checkoutBtn: $('#checkoutBtn'),
    couponForm: $('#couponForm'),
    couponInput: $('#couponInput'),
    couponMsg: $('#couponMsg'),
    scrim: $('#scrim'),

    authModal: $('#authModal'),
    authForm: $('#authForm'),
    authError: $('#authError'),
    authSubmit: $('#authSubmit'),
    authTitle: $('#authTitle'),
    signInBtn: $('#signInBtn'),
    signOutBtn: $('#signOutBtn'),
    accountMenu: $('#accountMenu'),
    accountTrigger: $('#accountTrigger'),
    accountDropdown: $('#accountDropdown'),
    accountName: $('#accountName'),
    accountEmail: $('#accountEmail'),
    avatar: $('#avatar'),

    checkoutModal: $('#checkoutModal'),
    checkoutForm: $('#checkoutForm'),
    checkoutSummary: $('#checkoutSummary'),
    checkoutError: $('#checkoutError'),
    placeOrderBtn: $('#placeOrderBtn'),

    successModal: $('#successModal'),
    successText: $('#successText'),
    trackOrderLink: $('#trackOrderLink'),
  };

  const filters = { q: '', category: 'all', diet: '', sort: '' };
  let menuItems = [];
  let authMode = 'login';

  /* ================================================================ */
  /* Menu                                                              */
  /* ================================================================ */

  const CATEGORY_LABELS = {
    all: 'All', popular: '⭐ Popular', pizza: 'Pizza', pasta: 'Pasta',
    burgers: 'Burgers', mains: 'Mains', desserts: 'Desserts',
  };

  function renderCategoryChips(categories) {
    if (el.categoryChips.dataset.ready === '1') return;
    const names = ['all', 'popular', ...categories.map((c) => c.category)];
    el.categoryChips.innerHTML = names
      .map(
        (name, i) =>
          `<button class="chip${i === 0 ? ' is-active' : ''}" data-category="${escapeHtml(name)}">${
            escapeHtml(CATEGORY_LABELS[name] || name)
          }</button>`
      )
      .join('');
    el.categoryChips.dataset.ready = '1';
  }

  function cardTemplate(item) {
    const inCart = cart.state.items.find((l) => l.item_id === item.id);
    return `
      <article class="dish" data-id="${item.id}">
        <div class="dish-media">
          <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy"
               onerror="this.onerror=null;this.src='images/placeholder.svg'" />
          ${item.is_popular ? '<span class="tag tag--popular">Popular</span>' : ''}
          <span class="tag tag--diet" title="${item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}">${item.is_veg ? '🟢' : '🔴'}</span>
          <button class="fav-btn${item.is_favorite ? ' is-on' : ''}" data-fav="${item.id}"
                  aria-label="${item.is_favorite ? 'Remove from favourites' : 'Save to favourites'}">${item.is_favorite ? '♥' : '♡'}</button>
        </div>
        <div class="dish-body">
          <div class="dish-top">
            <h3>${escapeHtml(item.name)}</h3>
            <span class="rating">★ ${item.rating.toFixed(1)}</span>
          </div>
          <p class="dish-desc">${escapeHtml(item.description)}</p>
          <p class="dish-meta">⏱ ${item.prep_minutes} min</p>
          <div class="dish-foot">
            <span class="price">${money(item.price)}</span>
            <div class="qty" data-qty="${item.id}">
              <button class="qty-btn" data-step="-1" aria-label="Decrease quantity">−</button>
              <input class="qty-input" type="number" min="1" max="20" value="1" aria-label="Quantity for ${escapeHtml(item.name)}" />
              <button class="qty-btn" data-step="1" aria-label="Increase quantity">+</button>
            </div>
          </div>
          <button class="btn btn--primary btn--block add-btn" data-add="${item.id}">
            ${inCart ? `In cart (${inCart.quantity}) · Add more` : 'Add to cart'}
          </button>
        </div>
      </article>`;
  }

  function renderMenu() {
    el.menuGrid.innerHTML = menuItems.map(cardTemplate).join('');
    el.menuEmpty.hidden = menuItems.length > 0;
  }

  async function loadMenu() {
    try {
      const { items, categories } = await api.menu(filters);
      menuItems = items;
      renderCategoryChips(categories);
      renderMenu();
      if (el.statItems) el.statItems.textContent = String(items.length || 6);
    } catch (err) {
      el.menuGrid.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  let searchTimer;
  el.search?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      filters.q = value.trim();
      loadMenu();
    }, 220);
  });

  el.sort?.addEventListener('change', (e) => {
    filters.sort = e.target.value;
    loadMenu();
  });

  el.categoryChips?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    el.categoryChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    filters.category = chip.dataset.category;
    loadMenu();
  });

  el.dietChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      el.dietChips.forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      filters.diet = chip.dataset.diet;
      loadMenu();
    });
  });

  /* Menu interactions: quantity steppers, add to cart, favourites. */
  el.menuGrid?.addEventListener('click', async (e) => {
    const stepBtn = e.target.closest('[data-step]');
    if (stepBtn) {
      const input = stepBtn.parentElement.querySelector('.qty-input');
      const next = Math.min(Math.max(Number(input.value || 1) + Number(stepBtn.dataset.step), 1), 20);
      input.value = String(next);
      return;
    }

    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      if (!session.isLoggedIn) return openAuth('login', 'Sign in to save your favourites.');
      try {
        const { is_favorite } = await api.toggleFavorite(Number(favBtn.dataset.fav));
        const item = menuItems.find((i) => i.id === Number(favBtn.dataset.fav));
        if (item) item.is_favorite = is_favorite;
        favBtn.classList.toggle('is-on', is_favorite);
        favBtn.textContent = is_favorite ? '♥' : '♡';
        toast(is_favorite ? 'Saved to favourites' : 'Removed from favourites', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const addBtn = e.target.closest('[data-add]');
    if (!addBtn) return;

    const id = Number(addBtn.dataset.add);
    const input = el.menuGrid.querySelector(`[data-qty="${id}"] .qty-input`);
    const quantity = Math.min(Math.max(Number(input?.value || 1), 1), 20);

    addBtn.disabled = true;
    try {
      await cart.add(id, quantity);
      renderCart();
      renderMenu();
      const item = menuItems.find((i) => i.id === id);
      toast(`${item ? item.name : 'Item'} added to cart`, 'success');
      pulseCartButton();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      addBtn.disabled = false;
    }
  });

  function pulseCartButton() {
    el.cartBtn.classList.remove('pulse');
    void el.cartBtn.offsetWidth;
    el.cartBtn.classList.add('pulse');
  }

  /* ================================================================ */
  /* Cart drawer                                                       */
  /* ================================================================ */

  function renderCart() {
    const { items, count } = cart.state;

    el.cartCount.textContent = String(count);
    el.cartCount.classList.toggle('is-empty', count === 0);

    if (items.length === 0) {
      el.cartBody.innerHTML = `
        <div class="cart-empty">
          <p class="cart-empty-emoji">🍽️</p>
          <p>Your cart is empty.</p>
          <button class="btn btn--ghost" id="browseFromCart">Browse the menu</button>
        </div>`;
      el.cartFoot.hidden = true;
      return;
    }

    el.cartBody.innerHTML = items
      .map(
        (line) => `
      <div class="cart-line" data-line="${line.item_id}">
        <img src="${escapeHtml(line.image)}" alt="" onerror="this.onerror=null;this.src='images/placeholder.svg'" />
        <div class="cart-line-main">
          <p class="cart-line-name">${escapeHtml(line.name)}</p>
          <p class="cart-line-price">${money(line.price)} each</p>
          <div class="qty qty--sm">
            <button class="qty-btn" data-line-step="-1" aria-label="Decrease quantity">−</button>
            <span class="qty-value">${line.quantity}</span>
            <button class="qty-btn" data-line-step="1" aria-label="Increase quantity">+</button>
          </div>
        </div>
        <div class="cart-line-end">
          <span class="cart-line-total">${money(line.line_total)}</span>
          <button class="link-btn" data-line-remove aria-label="Remove ${escapeHtml(line.name)}">Remove</button>
        </div>
      </div>`
      )
      .join('');

    el.cartFoot.hidden = false;
    renderTotals(el.cartTotals, cart.state);

    el.couponInput.value = cart.coupon;
    if (cart.state.coupon_error) {
      el.couponMsg.textContent = cart.state.coupon_error;
      el.couponMsg.className = 'coupon-msg is-error';
      el.couponMsg.hidden = false;
    } else if (cart.state.coupon) {
      el.couponMsg.textContent = `${cart.state.coupon.code} applied — ${cart.state.coupon.description}`;
      el.couponMsg.className = 'coupon-msg is-ok';
      el.couponMsg.hidden = false;
    } else {
      el.couponMsg.hidden = true;
    }
  }

  function renderTotals(target, state) {
    const rows = [['Subtotal', money(state.subtotal)]];
    if (state.discount > 0) rows.push([`Discount${state.coupon ? ` (${state.coupon.code})` : ''}`, `− ${money(state.discount)}`, 'is-discount']);
    rows.push(['Delivery', state.delivery_fee === 0 ? 'Free' : money(state.delivery_fee)]);
    rows.push([`GST (${state.rules?.tax_percent ?? 5}%)`, money(state.tax)]);

    const toGo = (state.rules?.free_delivery_above ?? 500) - state.subtotal;
    const hint =
      state.delivery_fee > 0 && toGo > 0
        ? `<p class="totals-hint">Add ${money(toGo)} more for free delivery.</p>`
        : '';

    target.innerHTML =
      rows
        .map(([label, value, cls = '']) => `<div class="totals-row ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`)
        .join('') +
      `<div class="totals-row totals-row--grand"><dt>Total</dt><dd>${money(state.total)}</dd></div>` +
      hint;
  }

  el.cartBody?.addEventListener('click', async (e) => {
    if (e.target.id === 'browseFromCart') {
      closeDrawer();
      document.getElementById('menu')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const lineEl = e.target.closest('[data-line]');
    if (!lineEl) return;
    const itemId = Number(lineEl.dataset.line);
    const line = cart.state.items.find((l) => l.item_id === itemId);
    if (!line) return;

    const stepBtn = e.target.closest('[data-line-step]');
    const removeBtn = e.target.closest('[data-line-remove]');
    if (!stepBtn && !removeBtn) return;

    const quantity = removeBtn ? 0 : line.quantity + Number(stepBtn.dataset.lineStep);
    try {
      await cart.setQuantity(itemId, Math.max(quantity, 0));
      renderCart();
      renderMenu();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.clearCartBtn?.addEventListener('click', async () => {
    try {
      await cart.clear();
      renderCart();
      renderMenu();
      toast('Cart cleared');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.couponForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    cart.coupon = el.couponInput.value.trim();
    try {
      await cart.refresh();
      renderCart();
      if (cart.state.coupon) toast(`Coupon ${cart.state.coupon.code} applied`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function openDrawer() {
    el.drawer.classList.add('is-open');
    el.drawer.setAttribute('aria-hidden', 'false');
    showScrim();
  }
  function closeDrawer() {
    el.drawer.classList.remove('is-open');
    el.drawer.setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  el.cartBtn?.addEventListener('click', openDrawer);
  el.closeCart?.addEventListener('click', closeDrawer);

  /* ================================================================ */
  /* Modals & scrim                                                    */
  /* ================================================================ */

  function showScrim() {
    el.scrim.hidden = false;
    document.body.classList.add('no-scroll');
  }
  function maybeHideScrim() {
    const anyOpen =
      el.drawer.classList.contains('is-open') ||
      document.querySelector('.modal.is-open') !== null;
    if (!anyOpen) {
      el.scrim.hidden = true;
      document.body.classList.remove('no-scroll');
    }
  }

  function openModal(modal) {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    showScrim();
    modal.querySelector('input, button')?.focus();
  }
  function closeModal(modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) {
      closeModal(e.target.closest('.modal'));
    }
  });

  el.scrim?.addEventListener('click', () => {
    document.querySelectorAll('.modal.is-open').forEach(closeModal);
    closeDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openM = document.querySelector('.modal.is-open');
    if (openM) closeModal(openM);
    else if (el.drawer.classList.contains('is-open')) closeDrawer();
  });

  /* ================================================================ */
  /* Auth                                                              */
  /* ================================================================ */

  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
      const on = tab.dataset.authTab === mode;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('[data-auth-only]').forEach((node) => {
      node.hidden = node.dataset.authOnly !== mode;
    });
    el.authTitle.textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
    el.authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    el.authForm.elements.password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    el.authError.hidden = true;
  }

  function openAuth(mode = 'login', message = '') {
    setAuthMode(mode);
    if (message) {
      el.authError.textContent = message;
      el.authError.hidden = false;
      el.authError.classList.add('is-hint');
    } else {
      el.authError.classList.remove('is-hint');
    }
    openModal(el.authModal);
  }

  document.querySelectorAll('[data-auth-tab]').forEach((tab) =>
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab))
  );

  el.signInBtn?.addEventListener('click', () => openAuth('login'));

  el.authForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(el.authForm).entries());
    el.authError.hidden = true;
    el.authSubmit.disabled = true;
    el.authSubmit.textContent = 'Please wait…';

    try {
      const result =
        authMode === 'login'
          ? await api.login({ email: data.email, password: data.password })
          : await api.register(data);

      session.save(result.token, result.user);
      await cart.adoptGuestCart();
      renderCart();
      await loadMenu();
      closeModal(el.authModal);
      el.authForm.reset();
      toast(`Signed in as ${result.user.name}`, 'success');
    } catch (err) {
      el.authError.textContent = err.message;
      el.authError.classList.remove('is-hint');
      el.authError.hidden = false;
    } finally {
      el.authSubmit.disabled = false;
      el.authSubmit.textContent = authMode === 'login' ? 'Sign in' : 'Create account';
    }
  });

  el.signOutBtn?.addEventListener('click', async () => {
    session.clear();
    await cart.refresh();
    renderCart();
    await loadMenu();
    el.accountDropdown.hidden = true;
    toast('Signed out');
  });

  el.accountTrigger?.addEventListener('click', () => {
    const open = el.accountDropdown.hidden;
    el.accountDropdown.hidden = !open;
    el.accountTrigger.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#accountMenu') && el.accountDropdown) {
      el.accountDropdown.hidden = true;
      el.accountTrigger?.setAttribute('aria-expanded', 'false');
    }
  });

  session.onChange((user) => {
    const signedIn = Boolean(user);
    el.signInBtn.hidden = signedIn;
    el.accountMenu.hidden = !signedIn;
    if (signedIn) {
      el.accountName.textContent = user.name.split(' ')[0];
      el.accountEmail.textContent = user.email;
      el.avatar.textContent = user.name.charAt(0).toUpperCase();
    }
    document.querySelectorAll('.admin-link').forEach((link) => {
      link.hidden = user?.role !== 'admin';
    });
  });

  /* ================================================================ */
  /* Checkout                                                          */
  /* ================================================================ */

  el.checkoutBtn?.addEventListener('click', () => {
    if (cart.state.items.length === 0) return toast('Your cart is empty.', 'error');
    if (!session.isLoggedIn) {
      closeDrawer();
      return openAuth('login', 'Sign in to place your order — your cart is saved.');
    }

    el.checkoutForm.elements.name.value = session.user.name || '';
    el.checkoutForm.elements.phone.value = session.user.phone || '';
    el.checkoutForm.elements.address.value = session.user.address || '';
    renderTotals(el.checkoutSummary, cart.state);
    el.checkoutError.hidden = true;

    closeDrawer();
    openModal(el.checkoutModal);
  });

  el.checkoutForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(el.checkoutForm).entries());
    el.checkoutError.hidden = true;
    el.placeOrderBtn.disabled = true;
    el.placeOrderBtn.textContent = 'Placing your order…';

    try {
      const { order } = await api.placeOrder({ ...data, coupon: cart.coupon });
      cart.coupon = '';
      await cart.refresh();
      renderCart();
      renderMenu();

      closeModal(el.checkoutModal);
      el.successText.innerHTML = `Order <strong>${escapeHtml(order.code)}</strong> is confirmed —
        ${money(order.total)} ${order.payment_method === 'cod' ? 'on delivery' : `via ${order.payment_method.toUpperCase()}`}.
        Arriving in about ${order.eta_minutes} minutes.`;
      el.trackOrderLink.href = `orders.html?order=${order.id}`;
      openModal(el.successModal);
      el.checkoutForm.elements.notes.value = '';
    } catch (err) {
      el.checkoutError.textContent = err.message;
      el.checkoutError.hidden = false;
    } finally {
      el.placeOrderBtn.disabled = false;
      el.placeOrderBtn.textContent = 'Place order';
    }
  });

  /* ================================================================ */
  /* Misc                                                              */
  /* ================================================================ */

  async function loadCoupons() {
    try {
      const { coupons } = await api.coupons();
      el.couponStrip.innerHTML = coupons
        .map(
          (c) => `<div class="coupon-pill"><code>${escapeHtml(c.code)}</code><span>${escapeHtml(c.description)}</span></div>`
        )
        .join('');
    } catch {
      el.couponStrip.hidden = true;
    }
  }

  window.addEventListener('scroll', () => {
    document.getElementById('siteHeader').classList.toggle('is-stuck', window.scrollY > 24);
  });

  /* ================================================================ */
  /* Boot                                                              */
  /* ================================================================ */

  (async function init() {
    theme.init();
    document.body.classList.add('is-ready');

    await session.restore();
    try {
      await cart.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
    renderCart();
    await loadMenu();
    loadCoupons();
  })();
})();
