/* QuickBite — home page: menu, recommendations, assistant, cart, checkout. */
(() => {
  'use strict';

  const {
    api, session, cart, money, escapeHtml, imgFallback, spiceLabel, stars,
    toast, theme, debounce, newIdempotencyKey,
  } = window.QB;

  const $ = (sel) => document.querySelector(sel);
  const el = {};
  for (const id of [
    'menuGrid', 'categoryChips', 'searchInput', 'heroSearch', 'heroSearchForm', 'sortSelect',
    'priceRange', 'priceOutput', 'spiceRange', 'spiceOutput', 'resultCount', 'resetFilters',
    'statDishes', 'statRating', 'couponStrip', 'quickChips',
    'picksRail', 'picksExplanation', 'picksStrategy',
    'cartBtn', 'cartCount', 'cartDrawer', 'cartBody', 'cartFoot', 'cartTotals',
    'closeCart', 'clearCartBtn', 'checkoutBtn', 'couponForm', 'couponInput', 'couponMsg', 'scrim',
    'authModal', 'authForm', 'authError', 'authSubmit', 'authTitle', 'signInBtn', 'signOutBtn',
    'accountMenu', 'accountTrigger', 'accountDropdown', 'accountName', 'accountFullName',
    'accountEmail', 'avatar', 'addressesBtn',
    'checkoutModal', 'checkoutForm', 'checkoutSummary', 'checkoutError', 'placeOrderBtn',
    'savedAddresses', 'addressList', 'useNewAddress', 'addressFields', 'saveAddress',
    'addressModal', 'addressManager', 'addressForm', 'addressError',
    'detailModal', 'detailContent', 'detailTitle',
    'successModal', 'successText', 'trackOrderLink',
    'assistant', 'assistantFab', 'assistantClose', 'assistantLog', 'assistantForm',
    'assistantInput', 'assistantChips', 'assistantMode',
    'siteHeader',
  ]) el[id] = document.getElementById(id);

  const dietChips = document.querySelectorAll('[data-diet]');

  /* ================================================================ */
  /* State                                                             */
  /* ================================================================ */

  const filters = { q: '', category: 'all', diet: '', sort: '', max_price: '', spice: '' };
  const DEFAULTS = { ...filters };

  let menuItems = [];
  let priceCeiling = 750;
  let authMode = 'login';
  let addresses = [];
  let selectedAddressId = null;
  let checkoutKey = null;

  /* ================================================================ */
  /* Menu rendering                                                    */
  /* ================================================================ */

  function skeletonGrid(count = 8) {
    return Array.from({ length: count }, () => `
      <div class="skeleton-card" aria-hidden="true">
        <div class="sk-img skeleton"></div>
        <div class="sk-body">
          <div class="sk-line w80 skeleton"></div>
          <div class="sk-line w100 skeleton"></div>
          <div class="sk-line w60 skeleton"></div>
          <div class="sk-line tall skeleton"></div>
        </div>
      </div>`).join('');
  }

  function dishCard(item) {
    const inCart = cart.quantityOf(item.id);
    const soldOut = !item.in_stock;

    return `
      <article class="dish${soldOut ? ' is-sold-out' : ''}" data-id="${item.id}" data-slug="${escapeHtml(item.slug)}">
        <div class="dish-media" data-open-detail="${escapeHtml(item.slug)}" role="button" tabindex="0"
             aria-label="See details for ${escapeHtml(item.name)}">
          <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="${imgFallback}" />
          <div class="dish-flags">
            ${item.is_popular ? '<span class="flag flag--popular">Popular</span>' : ''}
            ${item.spice_level >= 3 ? '<span class="flag flag--spicy">🌶 Hot</span>' : ''}
          </div>
          <span class="diet-dot diet-dot--${item.is_veg ? 'veg' : 'nonveg'}"
                title="${item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}"
                aria-label="${item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}"></span>
          <button class="fav-btn${item.is_favorite ? ' is-on' : ''}" data-fav="${item.id}"
                  aria-label="${item.is_favorite ? 'Remove from favourites' : 'Save to favourites'}"
                  aria-pressed="${item.is_favorite}">${item.is_favorite ? '♥' : '♡'}</button>
          ${soldOut ? '<div class="sold-out-veil">Sold out</div>' : ''}
        </div>

        <div class="dish-body">
          <div class="dish-top">
            <button class="dish-name-btn" data-open-detail="${escapeHtml(item.slug)}">${escapeHtml(item.name)}</button>
            <span class="rating" title="${item.rating} out of 5">★ ${item.rating.toFixed(1)}</span>
          </div>

          <p class="dish-desc">${escapeHtml(item.description)}</p>

          <div class="dish-meta">
            <span>⏱ ${item.prep_minutes} min</span>
            ${item.calories ? `<span>🔥 ${item.calories} kcal</span>` : ''}
            ${item.spice_level > 0 ? `<span>🌶 ${spiceLabel(item.spice_level)}</span>` : ''}
          </div>

          <div class="dish-foot">
            <span class="price">${money(item.price)}</span>
            ${soldOut ? '' : `
            <div class="qty" data-qty="${item.id}">
              <button class="qty-btn" data-step="-1" aria-label="Decrease quantity">−</button>
              <input class="qty-input" type="number" min="1" max="20" value="1"
                     aria-label="Quantity for ${escapeHtml(item.name)}" />
              <button class="qty-btn" data-step="1" aria-label="Increase quantity">+</button>
            </div>`}
          </div>

          <button class="btn btn--primary btn--block" data-add="${item.id}" ${soldOut ? 'disabled' : ''}>
            ${soldOut ? 'Sold out' : inCart ? `In cart (${inCart}) · Add more` : 'Add to cart'}
          </button>
        </div>
      </article>`;
  }

  function renderMenu() {
    if (menuItems.length === 0) {
      el.menuGrid.innerHTML = `
        <div class="state">
          <p class="state-emoji">🔍</p>
          <h3>Nothing matches those filters</h3>
          <p>Try widening the price range, clearing the search, or switching the diet filter.</p>
          <button class="btn btn--ghost" id="clearFromEmpty">Clear all filters</button>
        </div>`;
    } else {
      el.menuGrid.innerHTML = menuItems.map(dishCard).join('');
    }

    el.menuGrid.setAttribute('aria-busy', 'false');
    el.resultCount.textContent = menuItems.length
      ? `${menuItems.length} dish${menuItems.length === 1 ? '' : 'es'}`
      : '';

    const changed = Object.keys(DEFAULTS).some((k) => filters[k] !== DEFAULTS[k]);
    el.resetFilters.hidden = !changed;
  }

  function renderCategoryChips(categories) {
    if (el.categoryChips.dataset.ready === '1') return;

    const all = [{ category: 'all', label: 'Everything' }, { category: 'popular', label: '⭐ Popular' }, ...categories];
    el.categoryChips.innerHTML = all
      .map((c, i) => `
        <button class="chip${i === 0 ? ' is-active' : ''}" data-category="${escapeHtml(c.category)}">
          ${escapeHtml(c.label)}${c.count ? `<span class="count">${c.count}</span>` : ''}
        </button>`)
      .join('');
    el.categoryChips.dataset.ready = '1';
  }

  async function loadMenu({ showSkeleton = false } = {}) {
    if (showSkeleton) {
      el.menuGrid.innerHTML = skeletonGrid();
      el.menuGrid.setAttribute('aria-busy', 'true');
    }

    try {
      const data = await api.menu(filters);
      menuItems = data.items;
      renderCategoryChips(data.categories);
      renderMenu();

      if (data.price_range && el.priceRange.dataset.ready !== '1') {
        priceCeiling = data.price_range.max;
        el.priceRange.min = data.price_range.min;
        el.priceRange.max = data.price_range.max;
        el.priceRange.value = data.price_range.max;
        el.priceOutput.textContent = money(data.price_range.max);
        el.priceRange.dataset.ready = '1';
      }
    } catch (err) {
      el.menuGrid.setAttribute('aria-busy', 'false');
      el.menuGrid.innerHTML = `
        <div class="state">
          <p class="state-emoji">⚠️</p>
          <h3>We couldn't load the menu</h3>
          <p>${escapeHtml(err.message)}</p>
          <button class="btn btn--primary" id="retryMenu">Try again</button>
        </div>`;
    }
  }

  /* ---- Filter inputs ---------------------------------------------- */

  const searchMenu = debounce((value) => {
    filters.q = value.trim();
    loadMenu();
  }, 240);

  el.searchInput?.addEventListener('input', (e) => searchMenu(e.target.value));

  el.heroSearchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    filters.q = el.heroSearch.value.trim();
    el.searchInput.value = filters.q;
    loadMenu({ showSkeleton: true });
    document.getElementById('menu').scrollIntoView({ behavior: 'smooth' });
  });

  el.quickChips?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick]');
    if (!chip) return;

    const preset = chip.dataset.quick;
    Object.assign(filters, DEFAULTS);

    if (preset === 'veg') filters.diet = 'veg';
    else if (preset === 'under300') filters.max_price = '300';
    else if (preset === 'dessert') filters.category = 'desserts';
    else filters.q = preset;

    syncFilterControls();
    loadMenu({ showSkeleton: true });
    document.getElementById('menu').scrollIntoView({ behavior: 'smooth' });
  });

  el.sortSelect?.addEventListener('change', (e) => {
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

  dietChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      dietChips.forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      filters.diet = chip.dataset.diet;
      loadMenu();
    });
  });

  const applyPrice = debounce(() => loadMenu(), 260);
  el.priceRange?.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    el.priceOutput.textContent = money(value);
    filters.max_price = value >= priceCeiling ? '' : String(value);
    applyPrice();
  });

  el.spiceRange?.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    el.spiceOutput.textContent = value >= 3 ? 'Any' : spiceLabel(value);
    filters.spice = value >= 3 ? '' : String(value);
    loadMenu();
  });

  /** Puts every control back in step with `filters`. */
  function syncFilterControls() {
    el.searchInput.value = filters.q;
    el.heroSearch.value = filters.q;
    el.sortSelect.value = filters.sort;

    el.priceRange.value = filters.max_price || priceCeiling;
    el.priceOutput.textContent = money(el.priceRange.value);

    el.spiceRange.value = filters.spice === '' ? 3 : filters.spice;
    el.spiceOutput.textContent = filters.spice === '' ? 'Any' : spiceLabel(Number(filters.spice));

    dietChips.forEach((c) => c.classList.toggle('is-active', c.dataset.diet === filters.diet));
    el.categoryChips.querySelectorAll('.chip').forEach((c) =>
      c.classList.toggle('is-active', c.dataset.category === filters.category));
  }

  function resetFilters() {
    Object.assign(filters, DEFAULTS);
    syncFilterControls();
    loadMenu({ showSkeleton: true });
  }

  el.resetFilters?.addEventListener('click', resetFilters);

  /* ---- Menu interactions ------------------------------------------ */

  el.menuGrid?.addEventListener('click', async (e) => {
    if (e.target.id === 'clearFromEmpty') return resetFilters();
    if (e.target.id === 'retryMenu') return loadMenu({ showSkeleton: true });

    const stepBtn = e.target.closest('[data-step]');
    if (stepBtn) {
      const input = stepBtn.parentElement.querySelector('.qty-input');
      const next = Math.min(Math.max(Number(input.value || 1) + Number(stepBtn.dataset.step), 1), 20);
      input.value = String(next);
      return;
    }

    const detailTrigger = e.target.closest('[data-open-detail]');
    if (detailTrigger) return openDetail(detailTrigger.dataset.openDetail);

    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) return toggleFavourite(favBtn);

    const addBtn = e.target.closest('[data-add]');
    if (addBtn) return addToCart(addBtn);
  });

  // Keyboard support for the image "button".
  el.menuGrid?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const trigger = e.target.closest('[data-open-detail]');
    if (trigger) {
      e.preventDefault();
      openDetail(trigger.dataset.openDetail);
    }
  });

  async function toggleFavourite(btn) {
    if (!session.isLoggedIn) return openAuth('login', 'Sign in to save your favourites.');

    const id = Number(btn.dataset.fav);
    try {
      const { is_favorite } = await api.toggleFavorite(id);
      const item = menuItems.find((i) => i.id === id);
      if (item) item.is_favorite = is_favorite;
      btn.classList.toggle('is-on', is_favorite);
      btn.textContent = is_favorite ? '♥' : '♡';
      btn.setAttribute('aria-pressed', String(is_favorite));
      toast(is_favorite ? 'Saved to favourites' : 'Removed from favourites', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addToCart(btn, explicitQuantity) {
    const id = Number(btn.dataset.add);
    const input = document.querySelector(`[data-qty="${id}"] .qty-input`);
    const quantity = explicitQuantity || Math.min(Math.max(Number(input?.value || 1), 1), 20);

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      await cart.add(id, quantity);
      renderCart();
      renderMenu();
      const item = menuItems.find((i) => i.id === id);
      toast(`${item ? item.name : 'Item'} added to cart`, 'success');
      pulseCart();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function pulseCart() {
    el.cartBtn.classList.remove('pulse');
    void el.cartBtn.offsetWidth;
    el.cartBtn.classList.add('pulse');
  }

  /* ================================================================ */
  /* Recommendations                                                   */
  /* ================================================================ */

  async function loadRecommendations() {
    el.picksRail.innerHTML = Array.from({ length: 5 }, () => `
      <div class="skeleton-card" aria-hidden="true">
        <div class="sk-img skeleton"></div>
        <div class="sk-body"><div class="sk-line w80 skeleton"></div><div class="sk-line w40 skeleton"></div></div>
      </div>`).join('');

    try {
      const data = await api.recommendations({ limit: 8 });

      if (data.items.length === 0) {
        document.getElementById('picks').hidden = true;
        return;
      }

      el.picksExplanation.textContent = data.explanation;
      el.picksStrategy.textContent = {
        hybrid: 'Personalised', personalised: 'Personalised', popular: 'Most loved',
      }[data.strategy] || '';
      el.picksStrategy.hidden = !el.picksStrategy.textContent;

      el.picksRail.innerHTML = data.items.map((item) => `
        <article class="rail-card" data-open-detail="${escapeHtml(item.slug)}" role="button" tabindex="0">
          <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="${imgFallback}" />
          <div class="rail-card-body">
            ${data.strategy !== 'popular' ? `<span class="match-pill">${item.match}% match</span>` : ''}
            <h3>${escapeHtml(item.name)}</h3>
            <span class="price">${money(item.price)}</span>
          </div>
        </article>`).join('');
    } catch {
      document.getElementById('picks').hidden = true;
    }
  }

  el.picksRail?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-open-detail]');
    if (card) openDetail(card.dataset.openDetail);
  });
  el.picksRail?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-open-detail]');
    if (card) { e.preventDefault(); openDetail(card.dataset.openDetail); }
  });

  /* ================================================================ */
  /* Dish detail                                                       */
  /* ================================================================ */

  async function openDetail(slug) {
    el.detailContent.innerHTML = `
      <div class="detail-grid">
        <div class="sk-img skeleton" style="aspect-ratio:4/3;border-radius:var(--r-lg)"></div>
        <div style="display:grid;gap:10px;align-content:start">
          <div class="sk-line tall skeleton"></div>
          <div class="sk-line w100 skeleton"></div>
          <div class="sk-line w80 skeleton"></div>
        </div>
      </div>`;
    openModal(el.detailModal);

    try {
      const { item, reviews } = await api.dish(slug);
      el.detailTitle.textContent = item.name;

      if (session.isLoggedIn) api.trackEvent(item.id, 'view');

      const pairing = await api.similar(item.id, 4).catch(() => ({ items: [] }));

      el.detailContent.innerHTML = `
        <div class="detail-grid">
          <div class="detail-media">
            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" onerror="${imgFallback}" />
          </div>

          <div class="detail-body">
            <div class="detail-tags">
              <span class="badge badge--${item.is_veg ? 'veg' : 'nonveg'}">${item.is_veg ? '🟢 Veg' : '🔴 Non-veg'}</span>
              ${item.is_popular ? '<span class="badge badge--hot">Popular</span>' : ''}
              ${item.tags.slice(0, 4).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('')}
            </div>

            <p style="color:var(--text-2)">${escapeHtml(item.description)}</p>

            <div class="detail-facts">
              <div class="fact"><strong>${money(item.price)}</strong><span>price</span></div>
              <div class="fact"><strong>★ ${item.rating.toFixed(1)}</strong><span>${reviews.count} review${reviews.count === 1 ? '' : 's'}</span></div>
              <div class="fact"><strong>${item.prep_minutes}m</strong><span>to cook</span></div>
              ${item.calories ? `<div class="fact"><strong>${item.calories}</strong><span>kcal</span></div>` : ''}
              <div class="fact"><strong>${spiceLabel(item.spice_level)}</strong><span>spice</span></div>
            </div>

            ${item.in_stock
              ? `<div class="detail-actions">
                   <div class="qty" data-qty="detail">
                     <button class="qty-btn" data-detail-step="-1" aria-label="Decrease quantity">−</button>
                     <input class="qty-input" type="number" min="1" max="20" value="1" aria-label="Quantity" />
                     <button class="qty-btn" data-detail-step="1" aria-label="Increase quantity">+</button>
                   </div>
                   <button class="btn btn--primary" style="flex:1" data-detail-add="${item.id}">Add to cart</button>
                 </div>`
              : '<p class="form-error">This dish is sold out for today.</p>'}
          </div>
        </div>

        ${pairing.items.length > 0 ? `
        <div class="pairing">
          <h3>Goes well with</h3>
          <div class="pairing-grid">
            ${pairing.items.map((p) => `
              <button class="pairing-card" data-open-detail="${escapeHtml(p.slug)}">
                <img src="${escapeHtml(p.image)}" alt="" loading="lazy" onerror="${imgFallback}" />
                <div><strong>${escapeHtml(p.name)}</strong><span>${money(p.price)}</span></div>
              </button>`).join('')}
          </div>
        </div>` : ''}

        <div class="reviews">
          <h3>What people say</h3>
          ${reviews.items.length === 0
            ? '<p style="color:var(--text-3);font-size:.88rem">No reviews yet — order it and tell us what you think.</p>'
            : reviews.items.map((r) => `
                <div class="review">
                  <div class="review-head">
                    <strong>${escapeHtml(r.author)}</strong>
                    <span class="review-stars">${stars(r.rating)}</span>
                  </div>
                  ${r.comment ? `<p>${escapeHtml(r.comment)}</p>` : ''}
                </div>`).join('')}
        </div>`;
    } catch (err) {
      el.detailContent.innerHTML = `
        <div class="state"><p class="state-emoji">⚠️</p><h3>Could not load this dish</h3>
        <p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  el.detailContent?.addEventListener('click', async (e) => {
    const step = e.target.closest('[data-detail-step]');
    if (step) {
      const input = step.parentElement.querySelector('.qty-input');
      input.value = String(Math.min(Math.max(Number(input.value || 1) + Number(step.dataset.detailStep), 1), 20));
      return;
    }

    const nested = e.target.closest('[data-open-detail]');
    if (nested) return openDetail(nested.dataset.openDetail);

    const addBtn = e.target.closest('[data-detail-add]');
    if (!addBtn) return;

    const quantity = Number(el.detailContent.querySelector('.qty-input')?.value || 1);
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';

    try {
      await cart.add(Number(addBtn.dataset.detailAdd), quantity);
      renderCart();
      renderMenu();
      closeModal(el.detailModal);
      toast('Added to cart', 'success');
      pulseCart();
    } catch (err) {
      toast(err.message, 'error');
      addBtn.disabled = false;
      addBtn.textContent = 'Add to cart';
    }
  });

  /* ================================================================ */
  /* Cart drawer                                                       */
  /* ================================================================ */

  function renderCart() {
    const { items, count } = cart.state;

    el.cartCount.textContent = String(count);
    el.cartCount.classList.toggle('is-empty', count === 0);
    el.cartBtn.setAttribute('aria-label', count === 0 ? 'Open cart, empty' : `Open cart, ${count} items`);

    if (items.length === 0) {
      el.cartBody.innerHTML = `
        <div class="state">
          <p class="state-emoji">🍽️</p>
          <h3>Your cart is empty</h3>
          <p>Add a dish and it will show up here with the full price breakdown.</p>
          <button class="btn btn--ghost" id="browseFromCart">Browse the menu</button>
        </div>`;
      el.cartFoot.hidden = true;
      return;
    }

    el.cartBody.innerHTML = items.map((line) => `
      <div class="cart-line" data-line="${line.item_id}">
        <img src="${escapeHtml(line.image)}" alt="" onerror="${imgFallback}" />
        <div>
          <p class="cart-line-name">${escapeHtml(line.name)}</p>
          <p class="cart-line-price">${money(line.price)} each</p>
          <div class="qty qty--sm">
            <button class="qty-btn" data-line-step="-1" aria-label="Decrease quantity">−</button>
            <span class="qty-value">${line.quantity}</span>
            <button class="qty-btn" data-line-step="1" aria-label="Increase quantity"
                    ${line.quantity >= Math.min(line.stock ?? 20, 20) ? 'disabled' : ''}>+</button>
          </div>
          ${line.in_stock === false ? `<p class="stock-warning">Only ${line.stock} left — reduce the quantity</p>` : ''}
        </div>
        <div class="cart-line-end">
          <span class="cart-line-total">${money(line.line_total)}</span>
          <button class="link-btn" data-line-remove aria-label="Remove ${escapeHtml(line.name)}">Remove</button>
        </div>
      </div>`).join('');

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

    if (state.discount > 0) {
      rows.push([`Discount${state.coupon ? ` (${state.coupon.code})` : ''}`, `− ${money(state.discount)}`, 'is-discount']);
    }
    rows.push(['Delivery', state.delivery_fee === 0 ? 'Free' : money(state.delivery_fee)]);
    if (state.small_order_fee > 0) rows.push(['Small-order fee', money(state.small_order_fee)]);
    rows.push([`GST (${state.rules?.tax_percent ?? 5}%)`, money(state.tax)]);

    const toFree = (state.rules?.free_delivery_above ?? 500) - state.subtotal;
    const hint = state.delivery_fee > 0 && toFree > 0
      ? `<p class="totals-hint">Add ${money(toFree)} more for free delivery.</p>`
      : '';

    target.innerHTML =
      rows.map(([label, value, cls = '']) =>
        `<div class="totals-row ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`).join('')
      + `<div class="totals-row totals-row--grand"><dt>Total</dt><dd>${money(state.total)}</dd></div>`
      + hint;
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

  el.couponStrip?.addEventListener('click', async (e) => {
    const pill = e.target.closest('[data-coupon]');
    if (!pill) return;
    cart.coupon = pill.dataset.coupon;
    el.couponInput.value = pill.dataset.coupon;
    try {
      await cart.refresh();
      renderCart();
      openDrawer();
      toast(cart.state.coupon ? `${pill.dataset.coupon} applied` : cart.state.coupon_error, cart.state.coupon ? 'success' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function openDrawer() {
    el.cartDrawer.classList.add('is-open');
    el.cartDrawer.setAttribute('aria-hidden', 'false');
    showScrim();
    el.closeCart.focus();
  }

  function closeDrawer() {
    el.cartDrawer.classList.remove('is-open');
    el.cartDrawer.setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  el.cartBtn?.addEventListener('click', openDrawer);
  el.closeCart?.addEventListener('click', closeDrawer);

  /* ================================================================ */
  /* Modals and scrim                                                  */
  /* ================================================================ */

  function showScrim() {
    el.scrim.hidden = false;
    document.body.classList.add('no-scroll');
  }

  function maybeHideScrim() {
    const anyOpen = el.cartDrawer.classList.contains('is-open')
      || document.querySelector('.modal.is-open') !== null;
    if (!anyOpen) {
      el.scrim.hidden = true;
      document.body.classList.remove('no-scroll');
    }
  }

  function openModal(modal) {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    showScrim();
    setTimeout(() => modal.querySelector('input, button, select, textarea')?.focus(), 60);
  }

  function closeModal(modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    maybeHideScrim();
  }

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close-modal]');
    if (closer) closeModal(closer.closest('.modal'));
  });

  el.scrim?.addEventListener('click', () => {
    document.querySelectorAll('.modal.is-open').forEach(closeModal);
    closeDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openM = document.querySelector('.modal.is-open');
    if (openM) closeModal(openM);
    else if (el.cartDrawer.classList.contains('is-open')) closeDrawer();
    else if (el.assistant.classList.contains('is-open')) closeAssistant();
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
    el.authForm.elements.password.setAttribute(
      'autocomplete', mode === 'login' ? 'current-password' : 'new-password'
    );
    el.authForm.elements.password.setAttribute(
      'placeholder', mode === 'login' ? '' : 'At least 8 characters, with a number'
    );
    el.authError.hidden = true;
  }

  function openAuth(mode = 'login', message = '') {
    setAuthMode(mode);
    if (message) {
      el.authError.textContent = message;
      el.authError.classList.add('is-hint');
      el.authError.hidden = false;
    } else {
      el.authError.classList.remove('is-hint');
    }
    openModal(el.authModal);
  }

  document.querySelectorAll('[data-auth-tab]').forEach((tab) =>
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab)));

  el.signInBtn?.addEventListener('click', () => openAuth('login'));

  el.authForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(el.authForm).entries());

    el.authError.hidden = true;
    el.authSubmit.disabled = true;
    el.authSubmit.textContent = 'Please wait…';

    try {
      const result = authMode === 'login'
        ? await api.login({ email: data.email, password: data.password })
        : await api.register(data);

      session.save(result.token, result.user);
      await cart.adoptGuestCart();
      renderCart();
      await Promise.all([loadMenu(), loadRecommendations()]);

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
    await Promise.all([loadMenu(), loadRecommendations()]);
    el.accountDropdown.hidden = true;
    toast('Signed out');
  });

  el.accountTrigger?.addEventListener('click', () => {
    const willOpen = el.accountDropdown.hidden;
    el.accountDropdown.hidden = !willOpen;
    el.accountTrigger.setAttribute('aria-expanded', String(willOpen));
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
      el.accountFullName.textContent = user.name;
      el.accountEmail.textContent = user.email;
      el.avatar.textContent = user.name.charAt(0).toUpperCase();
    }

    document.querySelectorAll('.admin-link').forEach((link) => {
      link.hidden = user?.role !== 'admin';
    });
  });

  /* ================================================================ */
  /* Addresses                                                         */
  /* ================================================================ */

  async function loadAddresses() {
    if (!session.isLoggedIn) { addresses = []; return; }
    try {
      addresses = (await api.addresses()).addresses;
    } catch {
      addresses = [];
    }
  }

  function renderAddressPicker() {
    if (addresses.length === 0) {
      el.savedAddresses.hidden = true;
      el.addressFields.hidden = false;
      return;
    }

    el.savedAddresses.hidden = false;
    el.addressFields.hidden = true;

    const chosen = selectedAddressId ?? addresses.find((a) => a.is_default)?.id ?? addresses[0].id;
    selectedAddressId = chosen;

    el.addressList.innerHTML = addresses.map((a) => `
      <label class="address-option${a.id === chosen ? ' is-selected' : ''}">
        <input type="radio" name="saved_address" value="${a.id}" ${a.id === chosen ? 'checked' : ''} />
        <div>
          <strong>${escapeHtml(a.label)}${a.is_default ? ' · default' : ''}</strong>
          <span>${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)}<br />${escapeHtml(a.full)}</span>
        </div>
      </label>`).join('');
  }

  el.addressList?.addEventListener('change', (e) => {
    if (e.target.name !== 'saved_address') return;
    selectedAddressId = Number(e.target.value);
    renderAddressPicker();
  });

  el.useNewAddress?.addEventListener('click', () => {
    selectedAddressId = null;
    el.savedAddresses.hidden = true;
    el.addressFields.hidden = false;
  });

  el.addressesBtn?.addEventListener('click', async () => {
    el.accountDropdown.hidden = true;
    await loadAddresses();
    renderAddressManager();
    openModal(el.addressModal);
  });

  function renderAddressManager() {
    el.addressManager.innerHTML = addresses.length === 0
      ? '<p style="color:var(--text-3);font-size:.9rem">No saved addresses yet. Add one below.</p>'
      : `<div class="address-list">${addresses.map((a) => `
          <div class="address-option${a.is_default ? ' is-selected' : ''}">
            <div style="flex:1">
              <strong>${escapeHtml(a.label)}${a.is_default ? ' · default' : ''}</strong>
              <span>${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)}<br />${escapeHtml(a.full)}</span>
            </div>
            <div style="display:grid;gap:4px">
              ${a.is_default ? '' : `<button class="link-btn" data-make-default="${a.id}">Make default</button>`}
              <button class="link-btn" data-delete-address="${a.id}">Delete</button>
            </div>
          </div>`).join('')}</div>`;
  }

  el.addressManager?.addEventListener('click', async (e) => {
    const makeDefault = e.target.closest('[data-make-default]');
    const del = e.target.closest('[data-delete-address]');
    if (!makeDefault && !del) return;

    try {
      const result = makeDefault
        ? await api.defaultAddress(Number(makeDefault.dataset.makeDefault))
        : await api.deleteAddress(Number(del.dataset.deleteAddress));
      addresses = result.addresses;
      renderAddressManager();
      toast(makeDefault ? 'Default address updated' : 'Address removed', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.addressForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(el.addressForm).entries());
    el.addressError.hidden = true;

    try {
      await api.addAddress(data);
      await loadAddresses();
      renderAddressManager();
      el.addressForm.reset();
      toast('Address saved', 'success');
    } catch (err) {
      el.addressError.textContent = err.message;
      el.addressError.hidden = false;
    }
  });

  /* ================================================================ */
  /* Checkout                                                          */
  /* ================================================================ */

  el.checkoutBtn?.addEventListener('click', async () => {
    if (cart.state.items.length === 0) return toast('Your cart is empty.', 'error');

    const outOfStock = cart.state.items.filter((l) => l.in_stock === false);
    if (outOfStock.length > 0) {
      return toast(`Reduce the quantity of ${outOfStock[0].name} first.`, 'error');
    }

    if (!session.isLoggedIn) {
      closeDrawer();
      return openAuth('login', 'Sign in to place your order — your cart is saved.');
    }

    await loadAddresses();
    renderAddressPicker();

    el.checkoutForm.elements.name.value = session.user.name || '';
    el.checkoutForm.elements.phone.value = session.user.phone || '';
    el.checkoutForm.elements.address.value = session.user.address || '';

    renderTotals(el.checkoutSummary, cart.state);
    el.checkoutError.hidden = true;

    // One key per visit to the checkout screen, so a double-click or a retry
    // after a dropped connection cannot create a second order.
    checkoutKey = newIdempotencyKey();

    closeDrawer();
    openModal(el.checkoutModal);
  });

  el.checkoutForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = Object.fromEntries(new FormData(el.checkoutForm).entries());
    let payload;

    if (selectedAddressId && !el.savedAddresses.hidden) {
      const chosen = addresses.find((a) => a.id === selectedAddressId);
      payload = {
        name: chosen.recipient,
        phone: chosen.phone,
        address: chosen.full,
        notes: data.notes,
        payment_method: data.payment_method,
      };
    } else {
      payload = {
        name: data.name,
        phone: data.phone,
        address: data.address,
        notes: data.notes,
        payment_method: data.payment_method,
      };
    }
    payload.coupon = cart.coupon;

    el.checkoutError.hidden = true;
    el.placeOrderBtn.disabled = true;
    el.placeOrderBtn.textContent = 'Placing your order…';

    try {
      const { order } = await api.placeOrder(payload, checkoutKey);

      // Save the typed address only after the order actually succeeded.
      if (el.saveAddress?.checked && el.addressFields.hidden === false) {
        api.addAddress({
          label: 'Home', recipient: payload.name, phone: payload.phone, line1: payload.address,
        }).catch(() => {});
      }

      cart.coupon = '';
      await cart.refresh();
      renderCart();
      renderMenu();

      closeModal(el.checkoutModal);

      const method = order.payment_method === 'cod'
        ? 'on delivery'
        : `via ${order.payment_method.toUpperCase()}`;
      el.successText.innerHTML =
        `Order <strong>${escapeHtml(order.code)}</strong> is confirmed — ${money(order.total)} ${method}. `
        + `Arriving in about ${order.eta_minutes} minutes.`;
      el.trackOrderLink.href = `orders.html?order=${order.id}`;
      openModal(el.successModal);

      el.checkoutForm.elements.notes.value = '';
      checkoutKey = null;
    } catch (err) {
      el.checkoutError.textContent = err.message;
      el.checkoutError.hidden = false;

      // A stock clash means the cart changed under us — show the new reality.
      if (err.status === 409) {
        await cart.refresh();
        renderCart();
        renderTotals(el.checkoutSummary, cart.state);
      }
    } finally {
      el.placeOrderBtn.disabled = false;
      el.placeOrderBtn.textContent = 'Place order';
    }
  });

  /* ================================================================ */
  /* AI assistant                                                      */
  /* ================================================================ */

  let assistantGreeted = false;

  function openAssistant() {
    el.assistant.classList.add('is-open');
    el.assistant.setAttribute('aria-hidden', 'false');
    el.assistantFab.classList.add('is-hidden');

    if (!assistantGreeted) {
      addBubble('bot', 'Hello! Tell me what you fancy — a budget, a cuisine, how spicy, or just "surprise me".');
      assistantGreeted = true;
    }
    el.assistantInput.focus();
  }

  function closeAssistant() {
    el.assistant.classList.remove('is-open');
    el.assistant.setAttribute('aria-hidden', 'true');
    el.assistantFab.classList.remove('is-hidden');
  }

  el.assistantFab?.addEventListener('click', openAssistant);
  el.assistantClose?.addEventListener('click', closeAssistant);

  function addBubble(who, text) {
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble--${who}`;
    bubble.textContent = text;
    el.assistantLog.appendChild(bubble);
    el.assistantLog.scrollTop = el.assistantLog.scrollHeight;
    return bubble;
  }

  function addPicks(items) {
    if (items.length === 0) return;

    const wrap = document.createElement('div');
    wrap.className = 'assistant-picks';
    wrap.innerHTML = items.map((item) => `
      <div class="pick">
        <img src="${escapeHtml(item.image)}" alt="" onerror="${imgFallback}" />
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span>${money(item.price)}</span>
        </div>
        <button class="btn btn--primary btn--sm" data-assistant-add="${item.id}">Add</button>
      </div>`).join('');

    el.assistantLog.appendChild(wrap);
    el.assistantLog.scrollTop = el.assistantLog.scrollHeight;
  }

  async function askAssistant(question) {
    addBubble('user', question);

    const typing = document.createElement('div');
    typing.className = 'bubble bubble--bot bubble--typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    el.assistantLog.appendChild(typing);
    el.assistantLog.scrollTop = el.assistantLog.scrollHeight;

    try {
      const answer = await api.askAssistant(question);
      typing.remove();
      addBubble('bot', answer.reply);
      addPicks(answer.items);
    } catch (err) {
      typing.remove();
      addBubble('bot',
        err.status === 429
          ? 'One moment — give me a few seconds between questions.'
          : 'I could not look that up just now, but the full menu is still right here.');
    }
  }

  el.assistantForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = el.assistantInput.value.trim();
    if (!question) return;
    el.assistantInput.value = '';
    askAssistant(question);
  });

  el.assistantChips?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) askAssistant(btn.textContent.trim());
  });

  el.assistantLog?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-assistant-add]');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = '✓';
    try {
      await cart.add(Number(btn.dataset.assistantAdd), 1);
      renderCart();
      renderMenu();
      toast('Added to cart', 'success');
      pulseCart();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  });

  /* ================================================================ */
  /* Misc                                                              */
  /* ================================================================ */

  async function loadCoupons() {
    try {
      const { coupons } = await api.coupons();
      if (coupons.length === 0) { el.couponStrip.hidden = true; return; }

      el.couponStrip.innerHTML = coupons.map((c) => `
        <button class="coupon-pill" data-coupon="${escapeHtml(c.code)}" title="Tap to apply">
          <code>${escapeHtml(c.code)}</code>
          <span>${escapeHtml(c.description)}</span>
        </button>`).join('');
    } catch {
      el.couponStrip.hidden = true;
    }
  }

  async function loadAiStatus() {
    try {
      const status = await api.aiStatus();
      el.assistantMode.textContent = status.llm_configured
        ? 'AI-phrased · always from the real menu'
        : "Answers from today's menu";
    } catch { /* the default label is fine */ }
  }

  window.addEventListener('scroll', () => {
    el.siteHeader.classList.toggle('is-stuck', window.scrollY > 20);
  }, { passive: true });

  /* ================================================================ */
  /* Boot                                                              */
  /* ================================================================ */

  (async function init() {
    theme.init();
    el.menuGrid.innerHTML = skeletonGrid();

    await session.restore();

    try {
      await cart.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
    renderCart();

    await loadMenu();

    // Headline figures come from the real menu rather than being hard-coded.
    if (menuItems.length > 0) {
      el.statDishes.textContent = String(menuItems.length);
      const avg = menuItems.reduce((s, i) => s + i.rating, 0) / menuItems.length;
      el.statRating.textContent = `${avg.toFixed(1)}★`;
    }

    loadRecommendations();
    loadCoupons();
    loadAiStatus();
  })();
})();
