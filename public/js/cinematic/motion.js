/**
 * QuickBite — scroll choreography for Scene 2 and Scene 3.
 *
 * This is the DOM half of the cinematic act: the flavour cards rising
 * into place and the featured dish arriving with parallax. It needs GSAP
 * but *not* Three.js, so it is a separate entry point. esbuild splits the
 * shared GSAP code into one chunk, which matters for more than bytes:
 * two independent GSAP copies would each install their own scroll
 * listener, run their own ticker, and keep their own ScrollTrigger
 * registry, so a `refresh()` from one would not reach the other's
 * triggers.
 *
 * Everything here is an enhancement. js/scenes.js has already rendered
 * and wired both sections; if this file never loads they are simply
 * static. Nothing below is allowed to be the only thing that makes
 * content visible — the animations start from the resting state and
 * animate *from* an offset, never *to* visibility.
 */

import gsap from 'gsap';
import ScrollTrigger from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);


/**
 * A staggered scroll entrance that is staged before it is ever seen.
 *
 * GSAP writes a target's starting values only when that target's own
 * slot in the stagger opens. With function-based values — a per-card
 * depth, an alternating tilt — that left every target after the first
 * standing at its finished position until the scrub reached it, and
 * then snapping *backwards* into the distance: the opposite of
 * arriving. The first target had the mirror-image fault and stuck at
 * its start pose for good, because `from()` had recorded its end state
 * before the section's real layout existed.
 *
 * So the pose is applied up front with `set`, and the tween states both
 * ends explicitly instead of inferring one. Every card is in the
 * distance before its section scrolls into view, and the scrub stays
 * honest in both directions.
 */
function staged(targets, from, to) {
  gsap.set(targets, from);
  return gsap.fromTo(targets, from, { ...to, immediateRender: true });
}

/* ================================================================== */
/* Scene 2 — flavour cards                                             */
/* ================================================================== */

/**
 * The cards rise, un-tilt and settle as the section crosses the
 * viewport. `scrub` ties it to scroll offset rather than firing once, so
 * scrolling back up puts them back where they came from.
 */
function flavours(created) {
  const grid = document.getElementById('flavourGrid');
  const cards = grid ? [...grid.querySelectorAll('.flavour')] : [];
  if (cards.length === 0) return;

  /*
   * Per-column delay, not per-card. A flat stagger across a 4-column
   * grid makes the last card in row one arrive after the first card in
   * row two, which reads as a stutter rather than a sweep.
   */
  const columns = Math.max(1, Math.round(grid.offsetWidth / cards[0].offsetWidth));

  /* Each card's own depth, set on the element by scenes.js. */
  const depthOf = (card) => {
    const v = parseFloat(card.style.getPropertyValue('--depth'));
    return Number.isFinite(v) ? v : 0.5;
  };

  /*
   * The entrance. Cards rise from below *and from different distances*:
   * `z` is a real translateZ inside the grid's shared perspective, so a
   * deep card is genuinely further away and arrives smaller and later,
   * rather than merely being scaled down to look like it.
   *
   * The entrance is carried by movement, not by fading in. At an opacity
   * floor of 0.25 a card was transparent enough for the 3D pizza behind
   * it to read straight through the artwork, which looked like a
   * rendering fault rather than an entrance.
   */
  const tween = staged(cards,
    {
      y: (i, card) => 60 + depthOf(card) * 120,
      z: (i, card) => -140 - depthOf(card) * 300,
      rotateX: (i, card) => 10 + depthOf(card) * 18,
      rotateY: (i, card) => (i % 2 ? -1 : 1) * (5 + depthOf(card) * 11),
      opacity: 0.6,
      transformOrigin: '50% 100%',
    },
    {
      y: 0,
      z: 0,
      rotateX: 0,
      rotateY: 0,
      opacity: 1,
      transformOrigin: '50% 100%',
      ease: 'none',
      stagger: {
        each: 0.06,
        from: 'start',
        grid: [Math.ceil(cards.length / columns), columns],
        axis: 'x',
      },
      scrollTrigger: {
        trigger: grid,
        start: 'top 94%',
        end: 'top 36%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    });

  created.push(tween);

  /*
   * And once they have arrived they keep moving, at rates set by the
   * same depth: near cards climb fastest, far cards hang back and sink,
   * and each one travels toward or away from the camera. That is what
   * keeps the section feeling like a space rather than a wall of cards.
   *
   * This drives `.flavour-depth`, never `.flavour` — the entrance above
   * already owns that element's transform.
   */
  const depths = cards.map((c) => c.querySelector('.flavour-depth')).filter(Boolean);

  if (depths.length) {
    created.push(gsap.fromTo(depths,
      {
        yPercent: (i, el) => 5 + depthOf(el.parentElement) * 9,
        z: (i, el) => -30 * depthOf(el.parentElement),
      },
      {
        yPercent: (i, el) => -14 + depthOf(el.parentElement) * 10,
        z: (i, el) => 40 - 70 * depthOf(el.parentElement),
        rotateY: (i, el) => (i % 2 ? 2.5 : -2.5) * depthOf(el.parentElement),
        ease: 'none',
        scrollTrigger: {
          trigger: grid,
          start: 'top bottom',
          end: 'bottom top',
          scrub: 1,
          invalidateOnRefresh: true,
        },
      }
    ));
  }
}

/* ================================================================== */
/* Scene 3 — featured dish                                             */
/* ================================================================== */

/**
 * The plate and the copy arrive on different curves and drift at
 * different rates, which is what sells the depth.
 *
 * GSAP drives `.featured-art`, never `.featured-plate`. The plate's
 * transform is owned by the pointer tilt in scenes.js, which composes
 * `--rx`/`--ry` in CSS; writing a GSAP transform onto the same element
 * would overwrite that on every frame and the tilt would die silently.
 */
function featured(created) {
  const section = document.getElementById('featured');
  if (!section || section.hidden) return;

  const art = section.querySelector('.featured-art');
  const copy = section.querySelector('.featured-copy');
  const facts = section.querySelectorAll('.featured-facts li');

  if (art) {
    created.push(gsap.from(art, {
      y: 90,
      rotateY: -16,
      scale: 0.86,
      opacity: 0.55,
      ease: 'none',
      scrollTrigger: {
        trigger: section,
        start: 'top 88%',
        end: 'center 58%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    }));

    // Parallax: the plate keeps climbing after it has arrived.
    created.push(gsap.fromTo(art,
      { yPercent: 7 },
      {
        yPercent: -9,
        ease: 'none',
        scrollTrigger: { trigger: section, start: 'top bottom', end: 'bottom top', scrub: 1 },
      }
    ));
  }

  if (copy) {
    created.push(gsap.from(copy, {
      y: 48,
      opacity: 0.55,
      ease: 'none',
      scrollTrigger: {
        trigger: section,
        start: 'top 82%',
        end: 'center 62%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    }));
  }

  if (facts.length) {
    created.push(gsap.from(facts, {
      y: 22,
      opacity: 0,
      ease: 'none',
      stagger: 0.08,
      scrollTrigger: {
        trigger: section,
        start: 'top 72%',
        end: 'center 60%',
        scrub: 0.5,
      },
    }));
  }
}

/* ================================================================== */
/* The rest of the page                                                */
/* ================================================================== */

/*
 * Beyond Scene 3 the page returns to being a place to order food, and
 * the motion is dialled down to match. Two sections get something; the
 * menu grid deliberately gets nothing.
 *
 * The menu is thirty cards on a utility surface people scan and filter.
 * Animating it would cost thirty scroll-linked transforms for no
 * benefit and would make the one screen that needs to feel instant feel
 * staged instead. Restraint here is the design decision, not an
 * omission.
 */

/**
 * "Picked for you" — a gentle lift, because it is a personal shelf
 * rather than a spectacle. No translateZ: the rail is an
 * `overflow-x: auto` scroller, and depth inside a clipping container is
 * asking for trouble at the edges for a gain nobody would notice.
 */
function picks(created) {
  const rail = document.getElementById('picksRail');
  const cards = rail ? [...rail.querySelectorAll('.rail-card')] : [];
  if (cards.length === 0) return false;

  created.push(staged(cards,
    {
      y: 52,
      rotateY: (i) => (i % 2 ? -6 : 6),
      scale: 0.94,
      opacity: 0.55,
    },
    {
      y: 0,
      rotateY: 0,
      scale: 1,
      opacity: 1,
      ease: 'none',
      stagger: 0.05,
      scrollTrigger: {
        trigger: rail,
        start: 'top 94%',
        end: 'top 52%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    }));

  return true;
}


/**
 * Scene 4 — the delivery journey.
 *
 * Replaces the flat three-step list that used to live here. The five
 * stages climb in sequence, each from further back than the last, so
 * the section reads as a route rather than a row.
 */
function journey(created) {
  const track = document.getElementById('journeyTrack');
  const legs = track ? [...track.querySelectorAll('.leg')] : [];
  if (legs.length === 0) return false;

  created.push(staged(legs,
    {
      y: (i) => 80 + i * 22,
      z: (i) => -220 - i * 110,
      rotateX: 16,
      opacity: 0.35,
      transformOrigin: '50% 100%',
    },
    {
      y: 0,
      z: 0,
      rotateX: 0,
      opacity: 1,
      transformOrigin: '50% 100%',
      ease: 'none',
      stagger: 0.08,
      scrollTrigger: {
        trigger: track,
        start: 'top 92%',
        end: 'center 58%',
        scrub: 0.6,
        invalidateOnRefresh: true,
      },
    }));

  return true;
}

/**
 * Scene 5 — offers. Each card tips up from its own depth; they are
 * coupons, so they flutter rather than march.
 */
function offers(created) {
  const grid = document.getElementById('couponStrip');
  const cards = grid ? [...grid.querySelectorAll('.offer')] : [];
  if (cards.length === 0) return false;

  created.push(staged(cards,
    {
      y: 70,
      z: (i) => -150 - (i % 3) * 140,
      rotateX: (i) => 14 + (i % 2) * 8,
      rotateZ: (i) => (i % 2 ? -4 : 4),
      opacity: 0.4,
      transformOrigin: '50% 100%',
    },
    {
      y: 0,
      z: 0,
      rotateX: 0,
      rotateZ: 0,
      opacity: 1,
      transformOrigin: '50% 100%',
      ease: 'none',
      stagger: 0.07,
      scrollTrigger: {
        trigger: grid,
        start: 'top 92%',
        end: 'top 48%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    }));

  return true;
}

/**
 * Scene 6 — reviews.
 *
 * The rail is an `overflow-x: auto` scroller, so depth stays out of it
 * for the same reason the recommendations rail has none: translateZ
 * inside a clipping container misbehaves at the edges. The cards rise
 * and settle instead, and the rail drifts against the scroll.
 */
function reviews(created) {
  const rail = document.getElementById('reviewRail');
  const cards = rail ? [...rail.querySelectorAll('.review')] : [];
  if (cards.length === 0) return false;

  created.push(staged(cards,
    {
      y: 64,
      rotateY: (i) => (i % 2 ? -8 : 8),
      scale: 0.93,
      opacity: 0.4,
    },
    {
      y: 0,
      rotateY: 0,
      scale: 1,
      opacity: 1,
      ease: 'none',
      stagger: 0.06,
      scrollTrigger: {
        trigger: rail,
        start: 'top 94%',
        end: 'top 52%',
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    }));

  created.push(gsap.fromTo(rail,
    { yPercent: 4 },
    {
      yPercent: -5,
      ease: 'none',
      scrollTrigger: { trigger: rail, start: 'top bottom', end: 'bottom top', scrub: 1 },
    }
  ));

  return true;
}

/**
 * Scene 7 — the kitchens. Deeper and slower than Scene 2's flavour
 * cards, so the two card sections do not read as the same beat twice.
 */
function kitchens(created) {
  const grid = document.getElementById('kitchenGrid');
  const cards = grid ? [...grid.querySelectorAll('.kitchen')] : [];
  if (cards.length === 0) return false;

  created.push(staged(cards,
    {
      y: 96,
      z: (i) => -260 - (i % 3) * 150,
      rotateX: 12,
      rotateY: (i) => (i % 2 ? -10 : 10),
      opacity: 0.35,
      transformOrigin: '50% 100%',
    },
    {
      y: 0,
      z: 0,
      rotateX: 0,
      rotateY: 0,
      opacity: 1,
      transformOrigin: '50% 100%',
      ease: 'none',
      stagger: 0.09,
      scrollTrigger: {
        trigger: grid,
        start: 'top 92%',
        end: 'center 56%',
        scrub: 0.6,
        invalidateOnRefresh: true,
      },
    }));

  return true;
}

/**
 * Scene 8 — the finale. The copy settles as the burger rises behind
 * it, and the figures arrive last so the eye lands on them.
 */
function finale(created) {
  const section = document.getElementById('finale');
  if (!section) return false;

  const shell = section.querySelector('.finale-shell');
  const stats = [...section.querySelectorAll('.finale-stats li')];

  if (shell) {
    created.push(gsap.from(shell, {
      y: 70,
      z: -240,
      rotateX: 10,
      opacity: 0.3,
      transformOrigin: '50% 100%',
      ease: 'none',
      scrollTrigger: {
        trigger: section,
        start: 'top 88%',
        end: 'center 62%',
        scrub: 0.6,
        invalidateOnRefresh: true,
      },
    }));
  }

  if (stats.length) {
    created.push(gsap.from(stats, {
      y: 34,
      opacity: 0,
      ease: 'none',
      stagger: 0.07,
      scrollTrigger: {
        trigger: section,
        start: 'top 68%',
        end: 'center 56%',
        scrub: 0.5,
      },
    }));
  }

  return stats.length > 0;
}

/* ================================================================== */
/* Entry point                                                         */
/* ================================================================== */

export function start() {
  const created = [];
  let disposed = false;

  flavours(created);
  featured(created);

  /*
   * Most of the page below Scene 3 is filled by requests that may not
   * have landed yet. Each section is built now if its content is
   * already there, and on its own event if it is not — then the
   * triggers are recalculated, because adding content to the page
   * changes every scroll offset below it.
   */
  const deferred = [
    ['qb:picks', picks],
    ['qb:journey', journey],
    ['qb:coupons', offers],
    ['qb:reviews', reviews],
    ['qb:kitchens', kitchens],
    ['qb:finale', finale],
  ];

  const pending = new Map();

  for (const [event, build] of deferred) {
    if (build(created)) continue;

    const handler = () => {
      if (disposed || !pending.has(event)) return;
      if (!build(created)) return;
      pending.delete(event);
      window.removeEventListener(event, handler);
      ScrollTrigger.refresh();
    };

    pending.set(event, handler);
    window.addEventListener(event, handler);
  }

  /*
   * Events alone are not enough.
   *
   * scenes.js runs at parse time and fires its ready events as soon as
   * the menu lands; this bundle is lazy-loaded on an idle callback and
   * can easily attach its listeners after those events have already
   * been and gone. The journey was the proof: its content was on the
   * page and its choreography was never built, so five legs that
   * should have climbed from different depths just sat there.
   *
   * A few retries close the window without polling forever.
   */
  const retries = [0, 250, 800, 1800, 3500];
  const timers = retries.map((delay) => setTimeout(() => {
    if (disposed || pending.size === 0) return;

    let built = false;
    for (const [event, handler] of [...pending]) {
      const before = pending.size;
      handler();
      if (pending.size < before) built = true;
    }
    if (built) ScrollTrigger.refresh();
  }, delay));

  /*
   * Both sections are populated from an API response, so their height is
   * not final when the triggers are first calculated. Without a refresh
   * every start/end offset below stays pinned to a shorter page.
   */
  const refresh = () => { if (!disposed) ScrollTrigger.refresh(); };

  window.addEventListener('qb:flavours-ready', refresh);
  window.addEventListener('qb:featured-ready', refresh);

  let observer = null;
  if (typeof ResizeObserver === 'function') {
    let pending = 0;
    observer = new ResizeObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(refresh, 220);
    });
    observer.observe(document.body);
  }

  refresh();

  return {
    count: () => created.length,
    /** The resolved scroll progress of each trigger, for the tests. */
    progress: () => created
      .map((t) => t.scrollTrigger && +t.scrollTrigger.progress.toFixed(4))
      .filter((p) => typeof p === 'number'),

    dispose() {
      if (disposed) return;
      disposed = true;

      for (const tween of created) {
        tween.scrollTrigger && tween.scrollTrigger.kill();
        tween.kill();
      }
      created.length = 0;

      window.removeEventListener('qb:flavours-ready', refresh);
      window.removeEventListener('qb:featured-ready', refresh);
      for (const [event, handler] of pending) window.removeEventListener(event, handler);
      pending.clear();
      timers.forEach(clearTimeout);
      observer && observer.disconnect();

      // Put everything back exactly as the stylesheet left it.
      gsap.set(
        [
          '.flavour', '.flavour-depth', '#flavourGrid',
          '.featured-art', '.featured-copy', '.featured-facts li',
          '.rail-card', '.leg', '.offer', '.review', '#reviewRail',
          '.kitchen', '.finale-shell', '.finale-stats li',
        ],
        { clearProps: 'all' }
      );
    },
  };
}
