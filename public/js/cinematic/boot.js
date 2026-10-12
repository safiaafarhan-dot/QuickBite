/**
 * Gatekeeper for the cinematic layer.
 *
 * This file is deliberately tiny and dependency-free. It decides how much
 * of the cinematic act a visitor should get, and loads only that much.
 * There are two tiers, because they have very different costs:
 *
 *   motion.bundle.js  ~50 KB. GSAP scroll choreography for the Scene 2
 *                     and Scene 3 DOM. Needs no GPU, so anyone happy to
 *                     see motion at all gets it.
 *   scene.bundle.js   ~620 KB. The WebGL world — the Scene 1 burger and
 *                     the Scene 3 pizza. Only loaded when the device can
 *                     genuinely render it.
 *
 * Splitting the two matters: a laptop with WebGL disabled still gets the
 * full scroll choreography instead of a static page, and never downloads
 * Three.js to find that out.
 *
 * If anything here declines or throws, the page keeps the flat hero and
 * both scenes keep the content and interactions js/scenes.js already
 * gave them. Nothing below is load-bearing.
 */

const REDUCED = '(prefers-reduced-motion: reduce)';

let motion = null;
let scene = null;
let starting = false;

/** A throwaway context is the only honest way to ask "can you do WebGL?". */
function webglAvailable() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return false;
    // Release it straight away so we never hold two contexts at once.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function startMotion() {
  if (motion) return;
  try {
    const mod = await import('./motion.bundle.js');
    motion = mod.start();
    window.__qbMotion = motion;
  } catch (err) {
    console.warn('[qb-3d] scroll choreography unavailable:', err && err.message);
  }
}

async function startScene() {
  if (scene) return;
  if (!document.querySelector('.hero')) return;
  if (!webglAvailable()) return;

  try {
    const { start } = await import('./scene.bundle.js');

    const stage = document.createElement('div');
    stage.className = 'stage3d';
    stage.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    document.body.insertBefore(stage, document.body.firstChild);

    scene = start({ stage, canvas });
    window.__qbHero = scene;
  } catch (err) {
    // A missing bundle or an unsupported GPU must not break the page.
    console.warn('[qb-3d] cinematic hero unavailable:', err && err.message);
    document.documentElement.classList.remove('qb-3d', 'qb-hero-dark');
  }
}

async function boot() {
  if (starting) return;
  if (window.matchMedia(REDUCED).matches) return;

  starting = true;
  try {
    /*
     * The DOM choreography first and on its own await: it is a fraction
     * of the size, and a slow or failed Three.js download must not hold
     * up the part that works everywhere.
     */
    await startMotion();
    await startScene();
  } finally {
    starting = false;
  }
}

function teardown() {
  scene?.dispose();
  motion?.dispose();
  scene = null;
  motion = null;
  window.__qbHero = null;
  window.__qbMotion = null;
}

/* If the motion preference changes mid-visit, honour it immediately. */
const motionQuery = window.matchMedia(REDUCED);
motionQuery.addEventListener('change', (e) => (e.matches ? teardown() : boot()));

/*
 * Start after first paint so the menu request, the cart request and the
 * page copy all get the network and the main thread first. Scenes 2 and
 * 3 need the menu payload before they have anything to animate anyway.
 */
if ('requestIdleCallback' in window) {
  requestIdleCallback(boot, { timeout: 1500 });
} else {
  setTimeout(boot, 250);
}
