/* QuickBite — Scene 2 (flavour categories) and Scene 3 (featured dish).
 *
 * This file carries the *content and behaviour* of both scenes and has no
 * dependencies at all. The GSAP scroll choreography and the WebGL pizza
 * are added on top of it, lazily, by js/cinematic/. If neither ever
 * loads — no WebGL, reduced motion, a blocked bundle — both sections are
 * still fully rendered, readable and clickable. Motion is the
 * enhancement; the sections are not.
 *
 * Every figure shown here comes from the real menu payload that app.js
 * already fetched. Nothing is hard-coded: no invented prices, ratings,
 * counts, restaurant names or availability.
 */
(() => {
  'use strict';

  const { money, escapeHtml } = window.QB;

  const grid = document.getElementById('flavourGrid');
  const featured = document.getElementById('featured');
  if (!grid || !featured) return;

  /* ---------------------------------------------------------------- */
  /* Category presentation                                             */
  /* ---------------------------------------------------------------- */

  /*
   * Artwork and a one-line description per category.
   *
   * The categories themselves are whatever the API reports — this map
   * only decorates them. A category the server adds later still appears,
   * with a photo borrowed from its own first dish and no blurb, rather
   * than being silently dropped.
   *
   * Note on naming: the brief asked for "Indian" and "Chinese" cards.
   * Those are *cuisines* in this data model, not categories, and there is
   * no Chinese cuisine on the menu at all. Inventing either would mean
   * shipping a control that filters to nothing, so the cards follow the
   * real `category` column — the same values the menu's own filter chips
   * use. Indian and Asian dishes live under "Mains" and "Asian".
   */
  const DECOR = {
    starters:  { emoji: '🥟', blurb: 'Small plates to open with' },
    pizza:     { emoji: '🍕', blurb: 'Wood-fired, blistered, generous' },
    pasta:     { emoji: '🍝', blurb: 'Hand-rolled and finished to order' },
    burgers:   { emoji: '🍔', blurb: 'Stacked, messy, worth the napkins' },
    mains:     { emoji: '🍛', blurb: 'Dum biryani, curries and big plates' },
    asian:     { emoji: '🍜', blurb: 'Wok-tossed noodles and rice' },
    desserts:  { emoji: '🍰', blurb: 'The reason to save room' },
    beverages: { emoji: '🥤', blurb: 'Cold brews, lassis and juice' },
  };

  /** Groups the menu by category and keeps only what the data supports. */
  function summarise(data) {
    const items = data.items || [];
    const byCategory = new Map();

    for (const item of items) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }

    // Lead with the API's own category order and labels where it gives them.
    const ordered = (data.categories || [])
      .map((c) => c.category)
      .filter((c) => byCategory.has(c));

    for (const c of byCategory.keys()) if (!ordered.includes(c)) ordered.push(c);

    return ordered.map((category) => {
      const dishes = byCategory.get(category);
      const meta = (data.categories || []).find((c) => c.category === category);

      // The photo is the best-rated dish in the category — a real image
      // of a real dish, never a stock picture of the idea of a category.
      const hero = dishes.reduce((best, d) => (d.rating > best.rating ? d : best), dishes[0]);

      return {
        category,
        label: (meta && meta.label) || dishes[0].category_label || category,
        count: (meta && meta.count) || dishes.length,
        from: Math.min(...dishes.map((d) => d.price)),
        image: hero.image,
        alt: hero.name,
        decor: DECOR[category] || { emoji: '🍽', blurb: '' },
      };
    });
  }

  /*
   * How far back each card starts, and how hard it drifts afterwards.
   *
   * Deliberately not a ramp: a monotonic sequence makes the row look
   * like it is being read left to right, which is the flat-grid feel
   * the composition is trying to avoid. These eight values are shuffled
   * so neighbours always differ, and they repeat for any ninth card a
   * future menu might add.
   */
  const DEPTHS = [0.92, 0.34, 0.70, 0.12, 0.58, 1.0, 0.26, 0.78];

  function flavourCard(c, index) {
    const { emoji, blurb } = c.decor;
    const depth = DEPTHS[index % DEPTHS.length];

    return `
      <button class="flavour" data-flavour="${escapeHtml(c.category)}"
              style="--i:${index}; --depth:${depth}"
              aria-label="Show ${escapeHtml(c.label)} — ${c.count} dishes from ${money(c.from)}">
        <span class="flavour-depth">
        <span class="flavour-tilt">
          <span class="flavour-media">
            <img src="${escapeHtml(c.image)}" alt="" loading="lazy" decoding="async" width="320" height="220" />
            <span class="flavour-emoji" aria-hidden="true">${emoji}</span>
          </span>
          <span class="flavour-body">
            <span class="flavour-name">${escapeHtml(c.label)}</span>
            ${blurb ? `<span class="flavour-blurb">${escapeHtml(blurb)}</span>` : ''}
            <span class="flavour-foot">
              <span class="flavour-count">${c.count} ${c.count === 1 ? 'dish' : 'dishes'}</span>
              <span class="flavour-from">from ${money(c.from)}</span>
            </span>
          </span>
          <span class="flavour-sheen" aria-hidden="true"></span>
        </span>
        </span>
      </button>`;
  }

  function renderFlavours(data) {
    const cards = summarise(data);
    if (cards.length === 0) return;

    grid.innerHTML = cards.map(flavourCard).join('');
    grid.setAttribute('aria-busy', 'false');
    grid.dataset.ready = '1';

    window.dispatchEvent(new CustomEvent('qb:flavours-ready'));
  }

  /*
   * A flavour card drives the menu's own category chip rather than
   * keeping a second copy of the filter state. If the chip is not there
   * — the menu failed to load — the card scrolls to the menu instead of
   * pretending to have filtered something.
   */
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('[data-flavour]');
    if (!card) return;

    const chip = document.querySelector(`#categoryChips [data-category="${CSS.escape(card.dataset.flavour)}"]`);
    if (chip) chip.click();

    window.QB.scrollToSection('#menu');
  });

  /* ---------------------------------------------------------------- */
  /* Scene 3 — the featured dish                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Picks the dish to showcase: the best-rated available pizza, since
   * Scene 3 is built around a pizza handing over from the Scene 1
   * burger. If the menu has no pizza at all, the best-rated available
   * dish of any kind stands in rather than the section inventing one.
   */
  function pickFeatured(items) {
    const available = items.filter((i) => i.in_stock !== false);
    const pool = available.filter((i) => i.category === 'pizza');
    const from = pool.length ? pool : available;

    if (from.length === 0) return null;
    return from.reduce((best, d) => (d.rating > best.rating ? d : best), from[0]);
  }

  function renderFeatured(data) {
    const dish = pickFeatured(data.items || []);
    if (!dish) return;

    document.getElementById('featuredHeading').textContent = dish.name;

    document.getElementById('featuredBody').innerHTML = `
      <div class="featured-lead">
        <span class="featured-plate featured-plate--chip">
          <img src="${escapeHtml(dish.image)}" alt="${escapeHtml(dish.name)}"
               width="150" height="150" decoding="async" />
        </span>
        <p class="featured-desc">${escapeHtml(dish.description)}</p>
      </div>

      <ul class="featured-facts">
        <li><strong>${money(dish.price)}</strong><span>on the menu today</span></li>
        <li><strong>★ ${dish.rating.toFixed(1)}</strong><span>average rating</span></li>
        <li><strong>${dish.prep_minutes} min</strong><span>cooked to order</span></li>
      </ul>

      <div class="featured-actions">
        <div class="qty" data-qty="${dish.id}">
          <button class="qty-btn" data-step="-1" aria-label="Decrease quantity">−</button>
          <input class="qty-input" type="number" min="1" max="20" value="1"
                 aria-label="Quantity for ${escapeHtml(dish.name)}" />
          <button class="qty-btn" data-step="1" aria-label="Increase quantity">+</button>
        </div>
        <button class="btn btn--primary btn--lg" data-add="${dish.id}">Add to cart</button>
        <button class="btn btn--ghost btn--lg" data-open-detail="${escapeHtml(dish.slug)}">See the detail</button>
      </div>`;

    document.getElementById('featuredArt').innerHTML = `
      <span class="featured-plate featured-plate--full">
        <img src="${escapeHtml(dish.image)}" alt="${escapeHtml(dish.name)}"
             width="560" height="560" decoding="async" />
        <span class="featured-badge">
          <strong>${escapeHtml(dish.category_label || dish.category)}</strong>
          <span>${dish.is_veg ? 'Vegetarian' : 'Contains meat'}</span>
        </span>
      </span>`;

    featured.hidden = false;
    featured.dataset.slug = dish.slug;

    window.dispatchEvent(new CustomEvent('qb:featured-ready'));
  }

  /* ---------------------------------------------------------------- */
  /* Scene 4 — the delivery journey                                    */
  /* ---------------------------------------------------------------- */

  /*
   * The five stages are the real ones from `server/orderState.js`, in
   * the real order an order moves through them. The copy is held here
   * rather than fetched because it is presentation, and because the
   * orders page already keeps its own short labels for the same
   * statuses — this follows that existing pattern rather than inventing
   * a second one. If the server's FLOW changes, this list has to change
   * with it.
   */
  const JOURNEY = [
    { status: 'placed', label: 'Order placed', icon: '🧾',
      copy: 'Your basket is priced on our server and the kitchen is notified.' },
    { status: 'confirmed', label: 'Kitchen confirms', icon: '✅',
      copy: 'Stock is reserved against your order. Cancel free up to this point.' },
    { status: 'preparing', label: 'Being prepared', icon: '🔥',
      copy: 'Cooked to order — nothing is sitting under a heat lamp waiting.' },
    { status: 'out_for_delivery', label: 'Out for delivery', icon: '🛵',
      copy: 'It leaves the building and your order page starts tracking it.' },
    { status: 'delivered', label: 'Delivered', icon: '🏠',
      copy: 'Rate the dish once it arrives — that is what the ratings here are.' },
  ];

  function renderJourney(data) {
    const track = document.getElementById('journeyTrack');
    if (!track || track.dataset.ready === '1') return;

    // The one figure here that is a fact rather than copy.
    const preps = (data.items || []).map((i) => i.prep_minutes).filter(Boolean);
    const quickest = preps.length ? Math.min(...preps) : null;

    track.innerHTML = JOURNEY.map((stage, i) => `
      <li class="leg" style="--i:${i}" data-status="${escapeHtml(stage.status)}">
        <span class="leg-rail" aria-hidden="true"></span>
        <span class="leg-dot" aria-hidden="true">${stage.icon}</span>
        <span class="leg-body">
          <span class="leg-step">Step ${i + 1}</span>
          <strong class="leg-label">${escapeHtml(stage.label)}</strong>
          <span class="leg-copy">${escapeHtml(stage.copy)}</span>
          ${stage.status === 'preparing' && quickest
            ? `<span class="leg-fact">Quickest dish on the menu: ${quickest} min</span>` : ''}
        </span>
      </li>`).join('');

    track.dataset.ready = '1';
    window.dispatchEvent(new CustomEvent('qb:journey'));
  }

  /* ---------------------------------------------------------------- */
  /* Scene 6 — reviews                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Prefers a different author for each card.
   *
   * A seeded database gives a handful of demo customers a lot of
   * reviews each, so the newest dozen can easily be the same two names
   * over and over. This takes each author's most recent review first,
   * then backfills if that is not enough to fill the rail.
   */
  function spreadAuthors(reviews, want, perAuthor = 2) {
    const byAuthor = new Map();

    for (const r of reviews) {
      if (!byAuthor.has(r.author)) byAuthor.set(r.author, []);
      byAuthor.get(r.author).push(r);
    }

    /*
     * Round-robin, taking one review from each author in turn. A
     * seeded database has only a handful of demo customers with a lot
     * of reviews each, and taking the newest dozen straight off the
     * endpoint produced a rail reading "Aisha Khan" four times in a
     * row. This way the same name is never adjacent, and no author
     * contributes more than `perAuthor` cards however thin the data is.
     */
    const queues = [...byAuthor.values()];
    const out = [];

    for (let round = 0; round < perAuthor && out.length < want; round++) {
      for (const queue of queues) {
        if (out.length >= want) break;
        if (queue[round]) out.push(queue[round]);
      }
    }

    return out;
  }

  async function renderReviews() {
    const section = document.getElementById('reviews');
    const rail = document.getElementById('reviewRail');
    if (!section || !rail || rail.dataset.ready === '1') return;

    let reviews = [];
    try {
      const res = await fetch('/api/menu/reviews/recent?limit=24', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      ({ reviews } = await res.json());
    } catch {
      return;   // No reviews section at all rather than an empty shell.
    }

    const picked = spreadAuthors(reviews || [], 8);
    if (picked.length === 0) return;

    rail.innerHTML = picked.map((r, i) => `
      <article class="review" style="--i:${i}">
        <span class="review-stars" aria-label="${r.rating} out of 5">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
        <blockquote class="review-text">${escapeHtml(r.comment)}</blockquote>
        <footer class="review-foot">
          <img class="review-dish" src="${escapeHtml(r.item_image)}" alt="" width="44" height="44" loading="lazy" />
          <span>
            <strong>${escapeHtml(r.author)}</strong>
            <span class="review-item">on ${escapeHtml(r.item_name)}</span>
          </span>
        </footer>
      </article>`).join('');

    rail.dataset.ready = '1';
    section.hidden = false;
    window.dispatchEvent(new CustomEvent('qb:reviews'));
  }

  /* ---------------------------------------------------------------- */
  /* Scene 7 — the kitchens                                            */
  /* ---------------------------------------------------------------- */

  /*
   * Food, not flags.
   *
   * Regional-indicator pairs were the obvious choice and they are the
   * wrong one: Windows ships no flag glyphs at all, so every one of
   * them fell back to its bare letter pair and the cards read "IT
   * Italian", "IN Indian", "US American". That is not a headless
   * rendering artefact — it is what every Windows visitor would see.
   */
  const CUISINES = {
    italian:     { label: 'Italian', icon: '🍝', note: 'Wood-fired bases and hand-rolled pasta' },
    indian:      { label: 'Indian', icon: '🍛', note: 'Dum biryani, slow curries, tandoor' },
    american:    { label: 'American', icon: '🍔', note: 'Stacked burgers and smoky grills' },
    asian:       { label: 'Asian', icon: '🍜', note: 'Wok-tossed noodles and fried rice' },
    thai:        { label: 'Thai', icon: '🌶', note: 'Sweet, sour and chilli in balance' },
    continental: { label: 'Continental', icon: '☕', note: 'Cafe plates, bakes and cold brews' },
  };

  function renderKitchens(data) {
    const grid = document.getElementById('kitchenGrid');
    if (!grid || grid.dataset.ready === '1') return;

    const byCuisine = new Map();
    for (const item of data.items || []) {
      if (!item.cuisine) continue;
      if (!byCuisine.has(item.cuisine)) byCuisine.set(item.cuisine, []);
      byCuisine.get(item.cuisine).push(item);
    }
    if (byCuisine.size === 0) return;

    const kitchens = [...byCuisine.entries()]
      .map(([cuisine, dishes]) => {
        const hero = dishes.reduce((best, d) => (d.rating > best.rating ? d : best), dishes[0]);
        const avg = dishes.reduce((sum, d) => sum + d.rating, 0) / dishes.length;
        return {
          cuisine,
          dishes: dishes.length,
          rating: avg,
          hero,
          decor: CUISINES[cuisine] || { label: cuisine, icon: '🍽', note: '' },
        };
      })
      .sort((a, b) => b.dishes - a.dishes);

    grid.innerHTML = kitchens.map((k, i) => `
      <article class="kitchen" style="--i:${i}; --depth:${(i % 3) * 0.4 + 0.2}">
        <div class="kitchen-tilt">
          <span class="kitchen-photo">
            <img src="${escapeHtml(k.hero.image)}" alt="${escapeHtml(k.hero.name)}"
                 width="300" height="200" loading="lazy" decoding="async" />
          </span>
          <div class="kitchen-body">
            <h3><span class="kitchen-icon" aria-hidden="true">${k.decor.icon}</span> ${escapeHtml(k.decor.label)}</h3>
            ${k.decor.note ? `<p>${escapeHtml(k.decor.note)}</p>` : ''}
            <dl class="kitchen-facts">
              <div><dt>Dishes</dt><dd>${k.dishes}</dd></div>
              <div><dt>Avg rating</dt><dd>★ ${k.rating.toFixed(1)}</dd></div>
            </dl>
          </div>
        </div>
      </article>`).join('');

    grid.setAttribute('aria-busy', 'false');
    grid.dataset.ready = '1';
    window.dispatchEvent(new CustomEvent('qb:kitchens'));
  }

  /* ---------------------------------------------------------------- */
  /* Scene 8 — the finale                                              */
  /* ---------------------------------------------------------------- */

  function renderFinale(data) {
    const list = document.getElementById('finaleStats');
    if (!list || list.dataset.ready === '1') return;

    const items = data.items || [];
    if (items.length === 0) return;

    const avg = items.reduce((sum, i) => sum + i.rating, 0) / items.length;
    const cuisines = new Set(items.map((i) => i.cuisine).filter(Boolean)).size;
    const quickest = Math.min(...items.map((i) => i.prep_minutes).filter(Boolean));

    // Every figure is counted from the menu the page actually loaded.
    const stats = [
      { value: String(items.length), label: 'dishes, cooked to order' },
      { value: `★ ${avg.toFixed(1)}`, label: 'average rating' },
      { value: String(cuisines), label: 'kitchens under one roof' },
      { value: `${quickest} min`, label: 'quickest dish' },
    ];

    list.innerHTML = stats.map((s, i) => `
      <li style="--i:${i}"><strong>${escapeHtml(s.value)}</strong><span>${escapeHtml(s.label)}</span></li>`).join('');

    list.dataset.ready = '1';
    window.dispatchEvent(new CustomEvent('qb:finale'));
  }

  /* The finale's primary action goes to the menu the pinned way. */
  document.querySelector('[data-finale-order]')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.QB.scrollToSection('#menu');
  });

  /* ---------------------------------------------------------------- */
  /* Pointer tilt                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Pointer-driven 3D tilt, applied as CSS custom properties so the
   * stylesheet keeps control of how the tilt actually looks.
   *
   * Guarded by `(hover: hover) and (pointer: fine)`. On a touch screen
   * there is no hover state to leave, so a tilt would simply stick at
   * whatever angle the last tap left it — the touch experience is the
   * press-down scale in CSS instead, and the cards stay plain buttons.
   */
  function installTilt(root, selector, strength = 7, { wholeArea = false } = {}) {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!fine.matches || reduced.matches) return;

    let frame = 0;

    const apply = (el, rx, ry) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
        el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      });
    };

    /*
     * `wholeArea` exists for the round plate. Hit-testing a circular
     * image means the tilt only responds where the pointer is literally
     * over the circle — move into the corner of its box and the tilt
     * stops dead, because the topmost element there is the wrapper and
     * `closest()` finds nothing. The plate should answer to the whole
     * area it occupies, so the lookup goes downward instead of up.
     */
    /*
     * The fallback has to skip anything that is not actually on screen.
     * Scene 3 carries two photographs of the same dish — a full plate
     * for the non-WebGL page and a small chip for the cinematic one —
     * and only ever shows one. Tilting the hidden one would look like
     * the tilt had silently stopped working.
     */
    const visible = () =>
      [...root.querySelectorAll(selector)].find((el) => el.offsetParent !== null) || null;

    const resolve = (e) => e.target.closest(selector) || (wholeArea ? visible() : null);

    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = resolve(e);
      if (!el) return;

      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;

      el.classList.add('is-tilting');
      el.style.setProperty('--mx', `${((px + 0.5) * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${((py + 0.5) * 100).toFixed(1)}%`);
      apply(el, -py * strength * 2, px * strength * 2);
    });

    root.addEventListener('pointerleave', (e) => {
      const el = e.target.closest ? e.target.closest(selector) : null;
      for (const card of root.querySelectorAll(`${selector}.is-tilting`)) {
        if (card === el) continue;
        card.classList.remove('is-tilting');
        card.style.removeProperty('--rx');
        card.style.removeProperty('--ry');
      }
    }, true);

    // Keyboard users get the lift without the tilt, which needs a pointer.
    root.addEventListener('focusout', (e) => {
      const el = e.target.closest && e.target.closest(selector);
      if (!el) return;
      el.classList.remove('is-tilting');
      el.style.removeProperty('--rx');
      el.style.removeProperty('--ry');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  function build(data) {
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return;
    if (grid.dataset.ready !== '1') renderFlavours(data);
    if (featured.hidden) renderFeatured(data);

    renderJourney(data);
    renderKitchens(data);
    renderFinale(data);
  }

  // The menu may already have arrived before this script ran.
  if (window.__qbMenu) build(window.__qbMenu);
  window.addEventListener('qb:menu', (e) => build(e.detail));

  installTilt(grid, '.flavour', 7);
  installTilt(featured, '.featured-plate', 5, { wholeArea: true });

  const kitchenGrid = document.getElementById('kitchenGrid');
  if (kitchenGrid) installTilt(kitchenGrid, '.kitchen', 5);

  /*
   * Reviews need their own request, so they are fetched once the rest
   * of the page has settled rather than competing with the menu for the
   * connection. A failure here simply leaves the section hidden.
   */
  if ('requestIdleCallback' in window) requestIdleCallback(() => renderReviews(), { timeout: 2500 });
  else setTimeout(renderReviews, 900);
})();
