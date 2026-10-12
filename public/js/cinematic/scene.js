/**
 * QuickBite — cinematic hero scene.
 *
 * A single fixed WebGL stage holds one 3D world. Scroll position drives a
 * GSAP ScrollTrigger timeline that writes into a plain `scroll` object;
 * the render loop reads it every frame and applies it to the burger rig,
 * composing idle float, the opening rise and pointer parallax on top.
 * Nothing here is a "trigger once when visible" fade — every transform is
 * a continuous function of scroll offset, which is why it scrubs
 * backwards as faithfully as forwards.
 *
 * Two deliberate structural choices:
 *
 *   · The timeline animates *offsets from a rest pose*, never absolute
 *     positions. The rest pose comes from the viewport tier, so the same
 *     choreography holds from 320px to 1440px with no per-width keyframes
 *     and no function-based tween values to re-evaluate on refresh.
 *
 *   · The opening rise is a separate scalar (`intro.k`) that the frame
 *     interpolates towards the scroll pose. An intro tween and a scrubbed
 *     timeline writing the same properties would otherwise overwrite each
 *     other frame by frame.
 *
 * The burger is modelled procedurally from lathes, tori and spheres. That
 * is deliberate too: a downloaded GLTF burger would add megabytes and a
 * licence to audit, and a lathe profile under a warm physical material
 * reads better at hero scale than a cheap low-poly model would.
 *
 * This module is bundled and minified by `scripts/build-cinematic.js`
 * into `scene.bundle.js`, which is what the page actually loads.
 */

import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  WebGLRenderer,
} from 'three';

import gsap from 'gsap';
import ScrollTrigger from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/* ================================================================== */
/* Small maths helpers                                                 */
/* ================================================================== */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => t * t * (3 - 2 * t);
const mix = (a, b, k) => a + (b - a) * k;

/** A deterministic hash in [0,1) — no Math.random, so every load matches. */
function rand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/* ================================================================== */
/* Geometry builders                                                   */
/* ================================================================== */

/**
 * A disc with softly rounded top and bottom edges, revolved from a 2D
 * profile. Food has no hard 90-degree edges, and a plain cylinder
 * immediately looks like CAD rather than lunch.
 */
function roundedDisc(radius, height, corner, radialSegments = 64, cornerSteps = 6) {
  const h = height / 2;
  const c = Math.min(corner, h * 0.98, radius * 0.98);
  const pts = [new Vector2(0, -h), new Vector2(radius - c, -h)];

  for (let i = 1; i <= cornerSteps; i++) {
    const a = (i / cornerSteps) * (Math.PI / 2);
    pts.push(new Vector2(radius - c + Math.sin(a) * c, -h + c - Math.cos(a) * c));
  }
  for (let i = 1; i <= cornerSteps; i++) {
    const a = (i / cornerSteps) * (Math.PI / 2);
    pts.push(new Vector2(radius - c + Math.cos(a) * c, h - c + Math.sin(a) * c));
  }
  pts.push(new Vector2(0, h));

  return new LatheGeometry(pts, radialSegments);
}

/* How sharply the bun's shoulder flares. Shared so the seeds agree. */
const BUN_FLARE = 0.62;

/**
 * A bun: a rounded skirt with a dome on top. The `cos^0.62` term widens
 * the shoulder so it looks baked rather than spherical.
 */
function bunGeometry(radius, skirt, dome, radialSegments = 64, steps = 16) {
  const c = radius * 0.22;
  const pts = [new Vector2(0, 0), new Vector2(radius - c, 0)];

  for (let i = 1; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    pts.push(new Vector2(radius - c + Math.sin(a) * c, c - Math.cos(a) * c));
  }
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new Vector2(radius * Math.pow(Math.cos(a), BUN_FLARE), c + skirt + Math.sin(a) * dome));
  }

  const geo = new LatheGeometry(pts, radialSegments);
  geo.translate(0, -(c + skirt + dome) / 2, 0);
  return geo;
}

/**
 * The height of that same dome at a given radius, in the geometry's own
 * (already-translated) coordinates — the inverse of the profile above.
 *
 * This exists because the first version placed the sesame seeds on a
 * hemisphere approximation instead. The bun is not a hemisphere, so the
 * seeds hovered a visible gap above it, looking like floating debris
 * rather than part of the bread.
 */
function bunSurfaceY(radius, skirt, dome, r) {
  const c = radius * 0.22;
  const ratio = clamp(Math.pow(clamp(r / radius, 0, 1), 1 / BUN_FLARE), 0, 1);
  const a = Math.acos(ratio);
  return c + skirt + Math.sin(a) * dome - (c + skirt + dome) / 2;
}

/** The surface slope there, so a seed can lie flat against the crust. */
function bunSlope(radius, skirt, dome, r) {
  const d = radius * 0.004;
  return Math.atan2(
    bunSurfaceY(radius, skirt, dome, r) - bunSurfaceY(radius, skirt, dome, r + d),
    d
  );
}

/** Nudges vertices along their own normals so a surface stops looking moulded. */
function roughen(geometry, amount, seed = 1) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = (rand(seed + i * 0.37) - 0.5) * 2;
    const wave = Math.sin(x * 7.3 + z * 5.1 + seed) * 0.5 + Math.sin(y * 11.2 - x * 3.7) * 0.5;
    const d = (n * 0.55 + wave * 0.45) * amount;

    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }

  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A crinkled lettuce skirt: a flat annulus whose outer edge is displaced
 * by several sine harmonics, so the ruffle grows towards the rim exactly
 * as a leaf's does.
 *
 * The first attempt waved a torus instead. A torus has a round tube
 * section, so however thin it was made it still read as a green rubber
 * hose looped round the patty. An annulus has an edge, and the edge is
 * the whole reason lettuce looks like lettuce.
 */
function lettuceGeometry(rings = 6, segments = 120) {
  const inner = 0.56;
  const outer = 1.1;

  const positions = [];
  const indices = [];

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;                     // 0 at the centre, 1 at the rim
    const r = inner + (outer - inner) * t;
    const ruffle = t * t;                    // the rim crinkles, the middle does not

    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * TAU;
      const wave =
        Math.sin(a * 9) * 0.06 +
        Math.sin(a * 15 + 1.1) * 0.032 +
        Math.sin(a * 23 + 2.4) * 0.016;

      positions.push(
        Math.cos(a) * r,
        wave * ruffle - 0.05 * ruffle,       // and droops a little over the edge
        Math.sin(a) * r
      );
    }
  }

  const stride = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A radial-gradient sprite used as the contact shadow under the burger. */
function shadowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(26,10,2,0.85)');
  g.addColorStop(0.45, 'rgba(26,10,2,0.38)');
  g.addColorStop(1, 'rgba(26,10,2,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/* ================================================================== */
/* Materials                                                           */
/* ================================================================== */

function makeMaterials() {
  return {
    bun: new MeshPhysicalMaterial({
      color: new Color('#d89a4f'), roughness: 0.74, metalness: 0,
      clearcoat: 0.22, clearcoatRoughness: 0.55,
      sheen: 0.25, sheenColor: new Color('#ffd9a0'),
    }),
    patty: new MeshPhysicalMaterial({
      color: new Color('#53301c'), roughness: 0.92, metalness: 0,
      clearcoat: 0.12, clearcoatRoughness: 0.8,
    }),
    cheese: new MeshPhysicalMaterial({
      color: new Color('#f0a521'), roughness: 0.32, metalness: 0,
      clearcoat: 0.6, clearcoatRoughness: 0.3,
    }),
    /* Matte and slightly desaturated — a glossy clearcoat read as plastic. */
    lettuce: new MeshPhysicalMaterial({
      color: new Color('#6aa847'), roughness: 0.78, metalness: 0, clearcoat: 0.08,
      sheen: 0.9, sheenRoughness: 0.75, sheenColor: new Color('#cdeba8'),
      side: DoubleSide,
    }),
    tomato: new MeshPhysicalMaterial({
      color: new Color('#d4342a'), roughness: 0.26, metalness: 0,
      clearcoat: 0.75, clearcoatRoughness: 0.18,
    }),
    /*
     * No `transmission` here, however tempting a translucent onion is:
     * any non-zero transmission makes Three.js render the entire scene
     * into a second render target every frame. A bright, low-roughness
     * clearcoat reads as thin onion for a fraction of the cost.
     */
    onion: new MeshPhysicalMaterial({
      color: new Color('#f6ecf7'), roughness: 0.34, metalness: 0,
      clearcoat: 0.55, clearcoatRoughness: 0.2,
    }),
    sesame: new MeshPhysicalMaterial({
      color: new Color('#f2dcae'), roughness: 0.46, metalness: 0, clearcoat: 0.3,
    }),

    /* --- Scene 3 ---------------------------------------------------- */

    crust: new MeshPhysicalMaterial({
      color: new Color('#d79c53'), roughness: 0.84, metalness: 0,
      clearcoat: 0.1, clearcoatRoughness: 0.7,
    }),
    sauce: new MeshPhysicalMaterial({
      color: new Color('#b8301f'), roughness: 0.58, metalness: 0,
      clearcoat: 0.3, clearcoatRoughness: 0.45,
    }),
    mozzarella: new MeshPhysicalMaterial({
      color: new Color('#f7efd8'), roughness: 0.42, metalness: 0,
      clearcoat: 0.45, clearcoatRoughness: 0.3,
    }),
    basil: new MeshPhysicalMaterial({
      color: new Color('#3f7f36'), roughness: 0.72, metalness: 0,
      sheen: 0.8, sheenColor: new Color('#9fd98a'), side: DoubleSide,
    }),

    /* --- Scene 4 ---------------------------------------------------- */

    card: new MeshPhysicalMaterial({
      color: new Color('#c08a52'), roughness: 0.95, metalness: 0,
    }),
    cardLid: new MeshPhysicalMaterial({
      color: new Color('#cf9a60'), roughness: 0.92, metalness: 0,
    }),
    ribbon: new MeshPhysicalMaterial({
      color: new Color('#e4432d'), roughness: 0.46, metalness: 0,
      clearcoat: 0.5, clearcoatRoughness: 0.35,
    }),
  };
}

/* ================================================================== */
/* The burger                                                          */
/* ================================================================== */

/**
 * Builds the burger as a stack of independent layer groups. Each layer
 * carries its own explode vector, so "the ingredients separate and
 * reassemble" is driven by one scalar rather than a pile of hand-written
 * tweens.
 */
function buildBurger(mats, low) {
  const burger = new Group();
  const seg = low ? 36 : 64;
  const layers = [];

  const add = (child, baseY, meta) => {
    const holder = new Group();
    holder.position.y = baseY;
    holder.add(child);
    burger.add(holder);
    layers.push(Object.assign({ holder, baseY, ey: 0, ex: 0, ez: 0, er: 0 }, meta));
  };

  /* Bottom bun -------------------------------------------------------- */
  const bottomGeo = bunGeometry(1.0, 0.1, 0.16, seg, low ? 8 : 14);
  bottomGeo.rotateX(Math.PI);
  add(new Mesh(low ? bottomGeo : roughen(bottomGeo, 0.012, 3), mats.bun), -0.5,
    { ey: -0.2, er: -0.15 });

  /* Patty ------------------------------------------------------------- */
  const pattyGeo = roundedDisc(0.95, 0.3, 0.1, seg, low ? 3 : 6);
  add(new Mesh(low ? pattyGeo : roughen(pattyGeo, 0.02, 7), mats.patty), -0.21,
    { ey: 0.14, ex: 0.1, er: 0.35 });

  /* Cheese — a square slice, so four corners drape over the patty ----- */
  const cheese = new Group();
  cheese.add(new Mesh(roundedDisc(1.16, 0.055, 0.022, 4, 2), mats.cheese));
  cheese.rotation.y = Math.PI / 4;
  for (let i = 0; i < 4; i++) {
    const drip = new Mesh(new SphereGeometry(0.11, low ? 8 : 14, low ? 6 : 10), mats.cheese);
    drip.scale.set(1, 1.5, 0.45);
    drip.position.set(Math.cos((i / 4) * TAU + 0.78), -0.1, Math.sin((i / 4) * TAU + 0.78));
    cheese.add(drip);
  }
  add(cheese, -0.03, { ey: 0.46, ex: -0.14, er: 0.6 });

  /* Lettuce ----------------------------------------------------------- */
  add(new Mesh(lettuceGeometry(low ? 4 : 6, low ? 72 : 120), mats.lettuce), 0.1,
    { ey: 0.82, ex: 0.3, ez: 0.12, er: -0.7 });

  /* Tomato, onion, tomato --------------------------------------------- */
  const tomatoGeo = roundedDisc(0.74, 0.11, 0.035, seg, 3);
  add(new Mesh(tomatoGeo, mats.tomato), 0.23, { ey: 1.08, ex: -0.42, er: 0.5 });
  // TorusGeometry is built standing up in the XY plane. Without this the
  // onion ring sat on its edge like a bicycle wheel, which only became
  // obvious once the ingredients separated far enough to see it.
  const onionGeo = new TorusGeometry(0.66, 0.055, low ? 6 : 10, low ? 32 : 56);
  onionGeo.rotateX(Math.PI / 2);
  add(new Mesh(onionGeo, mats.onion), 0.33, { ey: 1.38, ex: 0.26, ez: -0.14, er: -0.35 });
  add(new Mesh(tomatoGeo.clone(), mats.tomato), 0.43, { ey: 1.66, ex: -0.2, er: 0.8 });

  /* Top bun, with sesame seeds sitting on the dome -------------------- */
  const top = new Group();
  const topGeo = bunGeometry(1.0, 0.14, 0.52, seg, low ? 10 : 18);
  top.add(new Mesh(low ? topGeo : roughen(topGeo, 0.01, 11), mats.bun));

  const seedCount = low ? 22 : 46;
  const seeds = new InstancedMesh(new SphereGeometry(1, 8, 6), mats.sesame, seedCount);
  const dummy = new Object3D();
  for (let i = 0; i < seedCount; i++) {
    // A Fibonacci spiral over the cap keeps the spacing even without clumps.
    const t = (i + 0.5) / seedCount;
    const a = i * 2.39996;
    const rr = Math.sqrt(t) * 0.84;

    // Pressed very slightly into the crust, and tilted to lie along it.
    dummy.position.set(
      Math.cos(a) * rr,
      bunSurfaceY(1.0, 0.14, 0.52, rr) - 0.006,
      Math.sin(a) * rr
    );
    dummy.rotation.set(0, -a, bunSlope(1.0, 0.14, 0.52, rr) + (rand(i + 5) - 0.5) * 0.18);
    dummy.scale.set(0.072, 0.022, 0.048);
    dummy.updateMatrix();
    seeds.setMatrixAt(i, dummy.matrix);
  }
  seeds.instanceMatrix.needsUpdate = true;
  top.add(seeds);

  add(top, 0.72, { ey: 2.14, ex: 0.08, er: 0.25 });

  return { burger, layers };
}

/* ================================================================== */
/* The pizza — Scene 3                                                 */
/* ================================================================== */

/**
 * A margherita, modelled rather than photographed, in four separable
 * layers: crust, sauce, mozzarella, basil.
 *
 * The menu's own pizza photograph is used in Scene 3 too — but in the
 * DOM, where a photograph belongs. It is the wrong source for the 3D
 * object: it is shot at an angle on a wooden board, so a circular UV
 * crop drags the board in at the edges, and its baked-in highlights and
 * shadows fight the scene's own lighting the moment the object turns.
 * A modelled pizza takes the same lights as the burger, which is what
 * makes the two read as one continuous world — and, unlike a
 * photograph, it can come apart.
 *
 * The model is a generic margherita. It is not a render of whichever
 * dish the showcase happens to name: that dish's real name, price,
 * rating and photograph are all in the panel beside it.
 */
function buildPizza(mats, low) {
  const pizza = new Group();
  const seg = low ? 40 : 72;
  const layers = [];
  const dummy = new Object3D();

  /*
   * Each layer gets its own holder, exactly as the burger's do, so the
   * whole exploded sequence is driven by one scalar rather than a pile
   * of hand-written tweens. `ey` is how far the layer travels when the
   * pizza comes apart; the crust sinks slightly while everything above
   * it climbs, which is what makes the separation read as layers rather
   * than as one object stretching.
   */
  const add = (child, baseY, meta) => {
    const holder = new Group();
    holder.position.y = baseY;
    holder.add(child);
    pizza.add(holder);
    layers.push(Object.assign({ holder, baseY, ey: 0, ex: 0, ez: 0, er: 0 }, meta));
    return holder;
  };

  /* --- 1. Crust: the base disc and its proved rim, as one layer ---- */
  const crust = new Group();
  crust.add(new Mesh(roundedDisc(1.5, 0.11, 0.05, seg, low ? 3 : 5), mats.crust));

  const rimGeo = new TorusGeometry(1.44, 0.14, low ? 8 : 14, low ? 48 : 96);
  rimGeo.rotateX(Math.PI / 2);
  rimGeo.scale(1, 0.72, 1);
  crust.add(new Mesh(low ? rimGeo : roughen(rimGeo, 0.022, 23), mats.crust));

  add(crust, 0, { ey: -0.30, er: -0.1 });

  /* --- 2. Sauce ---------------------------------------------------- */
  add(new Mesh(roundedDisc(1.37, 0.05, 0.02, seg, 2), mats.sauce), 0.07,
    { ey: 0.55, ex: 0.10, er: 0.22 });

  /* --- 3. Mozzarella ----------------------------------------------- */
  /*
   * Irregular molten pools, not discs. Deterministic placement on a
   * Fibonacci spiral keeps them from clumping, and the per-blob scale
   * jitter stops the repetition from reading.
   */
  const blobCount = low ? 9 : 14;
  const blobs = new InstancedMesh(new SphereGeometry(1, low ? 10 : 16, low ? 7 : 11), mats.mozzarella, blobCount);

  for (let i = 0; i < blobCount; i++) {
    const t = (i + 0.5) / blobCount;
    const a = i * 2.39996;
    const r = Math.sqrt(t) * 1.12;
    const w = 0.2 + rand(i * 7 + 1) * 0.15;

    dummy.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    dummy.rotation.set(0, rand(i + 3) * TAU, 0);
    dummy.scale.set(w, 0.05 + rand(i + 9) * 0.02, w * (0.75 + rand(i + 5) * 0.5));
    dummy.updateMatrix();
    blobs.setMatrixAt(i, dummy.matrix);
  }
  blobs.instanceMatrix.needsUpdate = true;
  add(blobs, 0.1, { ey: 1.50, ex: -0.14, ez: 0.08, er: -0.3 });

  /* --- 4. Basil ----------------------------------------------------- */
  const leafCount = low ? 5 : 8;
  const leafGeo = new SphereGeometry(1, low ? 9 : 14, low ? 6 : 9);
  leafGeo.scale(1, 0.09, 0.6);
  const leaves = new InstancedMesh(leafGeo, mats.basil, leafCount);

  for (let i = 0; i < leafCount; i++) {
    const a = i * 2.39996 + 0.7;
    const r = 0.3 + rand(i * 11) * 0.85;

    dummy.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    dummy.rotation.set((rand(i + 2) - 0.5) * 0.4, a * 1.7, (rand(i + 6) - 0.5) * 0.4);
    dummy.scale.setScalar(0.17 + rand(i + 4) * 0.07);
    dummy.updateMatrix();
    leaves.setMatrixAt(i, dummy.matrix);
  }
  leaves.instanceMatrix.needsUpdate = true;
  add(leaves, 0.14, { ey: 2.40, ex: 0.18, ez: -0.14, er: 0.5 });

  return { pizza, layers };
}

/* ================================================================== */
/* The parcel — Scene 4                                                */
/* ================================================================== */

/**
 * A tied delivery box.
 *
 * Scene 4 is about something travelling, which is the one thing a flat
 * card genuinely cannot do: the parcel crosses the section in three
 * dimensions, passing behind some stages and in front of others. It is
 * built from five boxes, which is as cheap as geometry gets.
 */
function buildParcel(mats, low) {
  const parcel = new Group();

  const body = new Mesh(new BoxGeometry(1, 0.74, 1), mats.card);
  parcel.add(body);

  // A shallow lid, slightly proud of the body, so the box has a seam.
  const lid = new Mesh(new BoxGeometry(1.06, 0.12, 1.06), mats.cardLid);
  lid.position.y = 0.4;
  parcel.add(lid);

  // Ribbon: two straps over the top, crossing at the centre.
  for (const turn of [0, Math.PI / 2]) {
    const strap = new Mesh(new BoxGeometry(0.17, 0.78, 1.04), mats.ribbon);
    strap.rotation.y = turn;
    parcel.add(strap);

    const over = new Mesh(new BoxGeometry(0.17, 1.03, 0.13), mats.ribbon);
    over.rotation.y = turn;
    over.position.y = 0.2;
    parcel.add(over);
  }

  if (!low) {
    // A small knot where the straps meet.
    const knot = new Mesh(new SphereGeometry(0.1, 12, 9), mats.ribbon);
    knot.position.y = 0.47;
    knot.scale.set(1, 0.7, 1);
    parcel.add(knot);
  }

  return parcel;
}

/* ================================================================== */
/* Floating ingredients                                                */
/* ================================================================== */

/**
 * Three instanced clouds at different depths: sesame, basil, diced
 * tomato. Depth drives both the parallax rate and the scroll response,
 * which is what gives the hero its sense of layered space.
 */
function buildFloaters(mats, low) {
  const group = new Group();
  const clouds = [];

  const specs = [
    { geo: new SphereGeometry(1, 8, 6),   mat: mats.sesame,  count: low ? 10 : 20, scale: [0.055, 0.026, 0.085], spread: 1.00 },
    { geo: new IcosahedronGeometry(1, 0), mat: mats.lettuce, count: low ? 6 : 13,  scale: [0.17, 0.045, 0.12],   spread: 1.15 },
    { geo: new BoxGeometry(1, 1, 1),      mat: mats.tomato,  count: low ? 6 : 12,  scale: [0.1, 0.1, 0.1],       spread: 0.90 },
  ];

  specs.forEach((spec, s) => {
    const mesh = new InstancedMesh(spec.geo, spec.mat, spec.count);
    const items = [];

    for (let i = 0; i < spec.count; i++) {
      const seed = s * 97 + i * 13;
      items.push({
        // Positions are fractions of the visible frame, resolved per frame.
        fx: (rand(seed) - 0.5) * 2.1 * spec.spread,
        fy: (rand(seed + 1) - 0.5) * 2.0 * spec.spread,
        z: -3.4 + rand(seed + 2) * 5.2,
        phase: rand(seed + 3) * TAU,
        speed: 0.22 + rand(seed + 4) * 0.5,
        spin: (rand(seed + 5) - 0.5) * 0.7,
        rise: 0.5 + rand(seed + 6) * 1.6,
        scale: spec.scale,
      });
    }

    mesh.frustumCulled = false;
    group.add(mesh);
    clouds.push({ mesh, items });
  });

  return { group, clouds };
}

/* ================================================================== */
/* Lighting                                                            */
/* ================================================================== */

function buildLights(scene) {
  const hemi = new HemisphereLight(0xfff1dd, 0x24150c, 0.55);

  const key = new DirectionalLight(0xfff0dc, 2.3);
  key.position.set(3.2, 5.4, 4.2);

  const rim = new PointLight(0xff7532, 26, 16, 2);
  rim.position.set(-3.6, 1.6, -2.4);

  const fill = new PointLight(0xffb259, 14, 14, 2);
  fill.position.set(3.6, -1.4, 2.6);

  const kick = new PointLight(0xffe2b0, 9, 12, 2);
  kick.position.set(0, 3.4, -3.2);

  scene.add(hemi, key, rim, fill, kick);
  return [hemi, key, rim, fill, kick];
}

/* ================================================================== */
/* Viewport tiers                                                      */
/* ================================================================== */

/**
 * Where the burger rests and how big it is, per breakpoint. `restFx` and
 * `restFy` are fractions of the visible frame at the burger's own depth,
 * so the choreography below never needs a per-width keyframe.
 *
 * The widths match the stylesheet's own breakpoints (1000 / 760) rather
 * than inventing new ones, so the burger and the layout always change
 * character on the same pixel. Above 1000 the burger sits beside the
 * copy; below it, above the copy.
 *
 * `fitW` and `fitH` are the share of the frame the burger may occupy in
 * each axis. Sizing by height alone was the first attempt and it was
 * plainly wrong on screen: a burger is far wider than it is tall, so a
 * height-derived scale pushed it off both sides of the viewport.
 */
function tierFor(width) {
  if (width <= 760) {
    return {
      id: 'mobile', low: true, parallax: 0,
      restFx: 0.00, restFy: 0.52, fitW: 0.84, fitH: 0.34,
      pizzaFx: 0.00, pizzaFy: 0.00, pizzaFitW: 0.74,
      showFx: 0.00, showFy: 0.62,
      parcelFitW: 0.24, finaleFitW: 0.58,
    };
  }
  if (width <= 1000) {
    return {
      id: 'tablet', low: false, parallax: 0,
      restFx: 0.00, restFy: 0.52, fitW: 0.54, fitH: 0.34,
      pizzaFx: 0.00, pizzaFy: 0.00, pizzaFitW: 0.56,
      showFx: 0.00, showFy: 0.50,
      parcelFitW: 0.16, finaleFitW: 0.44,
    };
  }
  return {
    id: 'desktop', low: false, parallax: 0.30,
    restFx: 0.54, restFy: 0.02, fitW: 0.45, fitH: 0.62,
    /*
     * Centre, and anchored to the viewport rather than to either column
     * of Scene 3. The pizza's route is up the middle of the stage: it
     * enters from the lower right as the burger leaves to the lower
     * left, crosses behind the flavour cards, and climbs out through the
     * top. It deliberately never parks over the featured copy, which an
     * earlier version did — the headline and description were painted
     * straight over by a pizza and became unreadable.
     */
    pizzaFx: 0.00, pizzaFy: 0.00, pizzaFitW: 0.36,

    /*
     * Where the pizza parks once Scene 3 is pinned, as an offset from
     * its fly-through anchor. These two numbers are the difference
     * between a showcase and a mess: centred, half the pizza sat behind
     * the glass panel (measured: pizza 463–977px, panel 140–715px).
     * Above 1000px the panel takes the left half so the pizza moves
     * right; stacked, the panel takes the lower half so it moves up.
     */
    showFx: 0.50, showFy: 0.00,
    parcelFitW: 0.10, finaleFitW: 0.34,
  };
}

/* Each model's own bounding box at scale 1, measured from the geometry. */
const NATURAL_W = 2.32;
const NATURAL_H = 1.90;
const PIZZA_W = 3.16;
const PIZZA_H = 0.42;

/*
 * How far the ingredients travel when fully separated, as a multiple of
 * each layer's explode vector. The top bun's vector is 2.14 and the
 * bottom bun's is -0.2, so the stack grows by 2.34 * EXPLODE_SPAN — at
 * 0.62 that was taller than the viewport.
 */
const EXPLODE_SPAN = 0.42;

/*
 * The same idea for the pizza, but larger: a pizza is almost flat, so
 * the layers have to travel much further than the burger's before the
 * separation is legible at all.
 *
 * The per-layer distances are deliberately uneven and front-loaded
 * toward the top. An even spread left the crust and sauce clearly
 * apart while the cheese and basil stayed bunched together on the
 * sauce — about 45px between them on screen, and foreshortened by the
 * pizza's own tilt on top of that. Each gap is now roughly equal in
 * *rendered* pixels rather than in world units.
 */
const PIZZA_SPAN = 0.60;

/* The parcel's own bounding box at scale 1. */
const PARCEL_W = 1.06;

/* ================================================================== */
/* Entry point                                                         */
/* ================================================================== */

export function start({ stage, canvas }) {
  let tier = tierFor(window.innerWidth);
  let disposed = false;

  /* ---------------------------------------------------------------- */
  /* Renderer                                                          */
  /* ---------------------------------------------------------------- */

  const renderer = new WebGLRenderer({
    canvas,
    antialias: !tier.low,
    alpha: true,
    powerPreference: 'high-performance',
  });

  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 60);
  camera.position.set(0, 0, 8.6);

  const lights = buildLights(scene);
  const mats = makeMaterials();

  /* ---------------------------------------------------------------- */
  /* Rig: position and scale on the rig, rotation on the burger, so    */
  /* the contact shadow follows the burger without tumbling with it.   */
  /* ---------------------------------------------------------------- */

  const rig = new Group();
  const { burger, layers } = buildBurger(mats, tier.low);
  rig.add(burger);

  const shadowMat = new MeshBasicMaterial({
    map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.55,
  });
  const shadow = new Mesh(new PlaneGeometry(3.4, 3.4), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.98;
  rig.add(shadow);
  scene.add(rig);

  /* --- Scene 3's pizza, in the same world and the same lighting --- */
  const pizzaRig = new Group();
  const { pizza, layers: pizzaLayers } = buildPizza(mats, tier.low);
  pizzaRig.add(pizza);
  pizzaRig.visible = false;
  scene.add(pizzaRig);

  /* --- Scene 4's parcel ------------------------------------------- */
  const parcelRig = new Group();
  const parcel = buildParcel(mats, tier.low);
  parcelRig.add(parcel);
  parcelRig.visible = false;
  scene.add(parcelRig);

  const { group: floaterGroup, clouds } = buildFloaters(mats, tier.low);
  scene.add(floaterGroup);

  const dummy = new Object3D();

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  /*
   * What the scrubbed timeline writes. `ox`/`oy` are offsets from the
   * tier's rest position, never absolute coordinates — that is what keeps
   * one set of keyframes valid at every viewport width.
   */
  const scroll = {
    ox: 0, oy: 0, z: 0,
    rx: 0.12, ry: 0, rz: -0.03, s: 1,
    explode: 0, drift: 0,
  };

  /*
   * The dark backdrop and the canvas opacity are deliberately NOT
   * tweened. They are measured from the hero's own rectangle every
   * frame, because the first attempt — fading them on scroll progress —
   * had no way to know where the hero actually ends. It darkened the
   * "Picked for you" section, whose headings are styled for a light
   * page, and left them unreadable.
   */
  const heroEl = document.querySelector('.hero');

  /*
   * The cinematic act is the hero plus Scenes 2 and 3. The backdrop has
   * to end at the bottom of the last of them — measuring only the hero
   * would drop the lights halfway through the flavour cards, and the
   * sections below are styled for a light page.
   */
  const actEl = document.querySelector('#featured') || document.querySelector('#flavours') || heroEl;

  /*
   * The page has two dark acts, not one: the hero through Scene 3, and
   * Scene 4 through the finale, with the recommendations and the menu
   * on a light page in between. The first act is painted by the stage's
   * own pseudo-elements, masked from the top. The second cannot reuse
   * that mask — it does not start at the top of the viewport — so it
   * gets a real element whose top and height are set from the act's
   * measured rectangle each frame.
   */
  const act2Start = document.querySelector('#how');
  const act2End = document.querySelector('#finale');

  const band = document.createElement('div');
  band.className = 'stage-band';
  stage.insertBefore(band, canvas);   // behind the canvas, above the page colour

  let act2Vis = 0;
  let lastBandTop = -1;
  let lastBandHeight = -1;

  let cut = 0;      // px down the viewport where the dark backdrop stops
  let actVis = 1;   // 1 = the whole act fills the viewport, 0 = scrolled past
  let heroVis = 1;  // the same, for the hero alone

  /* Where the burger starts before the opening rise. */
  const opening = { ox: 0, oy: -1.95, z: -3.4, rx: 0.34, ry: -0.65, rz: -0.12, s: 0.48 };

  /*
   * The pizza's own scrubbed state. Same shape as the burger's, same
   * offset-from-rest convention, so one set of keyframes holds at every
   * viewport width.
   */
  const slice = {
    ox: 0.62, oy: -1.55, z: -2.2,
    rx: 1.12, ry: -0.5, rz: 0.1, s: 0.72,
    explode: 0,
    /* 0 while crossing the page, 1 once parked in the showcase. */
    home: 0,
  };

  /* 0 = fully in the opening pose, 1 = fully handed over to the scroll. */
  const intro = { k: 0 };

  /*
   * Scene 4's parcel: a route across the section rather than a pose,
   * so it reads as one object travelling rather than several appearing.
   */
  /*
   * The route stays in the lower half of the frame throughout. An
   * earlier one arced up to +0.3 and parked a large parcel across
   * "From our pan to your door" — the heading stayed legible, but the
   * section read as cluttered rather than cinematic.
   */
  const trip = { fx: -1.05, fy: -0.85, z: -2.4, rx: 0.3, ry: -0.6, rz: 0.1, s: 0.8, on: 0 };

  /*
   * Scene 8 brings the burger back for the closing shot. `k` blends
   * between wherever Scene 1 left it and the finale pose, so the two
   * timelines never write the same values at the same time.
   */
  const fin = { k: 0, fx: 0.1, fy: -1.5, z: -1.6, rx: 0.42, ry: 5.2, rz: 0, s: 0.86 };

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  let frames = 0;
  let progress = 0;
  let pizzaProgress = 0;
  let showcaseProgress = 0;
  let tripProgress = 0;
  let finaleProgress = 0;
  let running = false;
  let rafId = 0;
  let lastCut = -1;

  /* ---------------------------------------------------------------- */
  /* Sizing                                                            */
  /* ---------------------------------------------------------------- */

  /** Visible half-height of the frame at a given depth. */
  const halfH = (z) => Math.tan((camera.fov * Math.PI) / 360) * (camera.position.z - z);
  const halfW = (z) => halfH(z) * camera.aspect;

  function resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);

    tier = tierFor(w);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.low ? 1.25 : 1.75));
    renderer.setSize(w, h, false);
  }

  /* ---------------------------------------------------------------- */
  /* Scroll choreography                                               */
  /* ---------------------------------------------------------------- */

  /*
   * One scrubbed timeline from the top of the page until the menu reaches
   * the middle of the viewport — the hero plus the "Picked for you" rail.
   * `scrub` is what makes every value a continuous function of scroll
   * offset in both directions.
   */
  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      // The burger's act now ends where Scene 2 begins, not at the menu:
      // Scenes 2 and 3 sit between them, and stretching the burger
      // across all three would leave it loitering over the pizza.
      endTrigger: '#flavours',
      end: 'top center',
      scrub: 0.6,
      onUpdate: (self) => { progress = self.progress; },
    },
  });

  /*
   * The scale values matter more than they look. Screen footprint is
   * `tier.fitW * s` across and roughly `(1.9 + 2.34 * EXPLODE_SPAN) * s`
   * tall, so the exploded stack has to shed scale or it simply does not
   * fit the viewport — which is exactly what the first cut did, filling
   * the screen with a burger seen from the inside.
   */
  tl
    /* 0 → .24   move toward the camera and turn into the light. */
    .to(scroll, { duration: 0.24, ox: -0.05, oy: 0.12, z: 1.2, ry: 0.9, rx: 0.02, rz: 0.03, s: 1.1 })
    /* .24 → .42 the ingredients separate and float apart. */
    .to(scroll, { duration: 0.18, ox: -0.30, oy: 0.04, z: -0.6, ry: 1.8, rx: 0.14, s: 0.80, explode: 1 })
    /* .42 → .68 and come back together, still turning. */
    .to(scroll, { duration: 0.26, ox: -0.52, oy: -0.34, z: -0.4, ry: 2.9, rx: 0.08, explode: 0, s: 0.88 })
    /*
     * .68 → 1   descend and leave to the lower left, clearing the frame
     * entirely so the pizza arriving from the lower right has the stage
     * to itself. The earlier exit stopped at -1.25 and left a corner of
     * the bun parked on screen through all of Scene 2.
     */
    .to(scroll, { duration: 0.32, ox: -2.05, oy: -1.55, z: -2.6, ry: 4.1, rx: 0.3, rz: -0.14, s: 0.60 })
    /* Floaters keep drifting the whole way through. */
    .to(scroll, { duration: 1.0, drift: 1 }, 0);

  /*
   * The handoff.
   *
   * This timeline starts the moment Scene 2 appears at the bottom of the
   * viewport — while the burger is still completing its exit — so the
   * two overlap in time and in space. The burger leaves low and to the
   * left; the pizza rises from low and to the right, crosses behind the
   * flavour cards, and settles beside the featured copy. One continuous
   * world handing the eye from one object to the next, rather than two
   * animations that happen to be adjacent.
   */
  /*
   * The approach. The pizza rises from the lower right as the burger
   * leaves to the lower left, crosses behind the flavour cards, and
   * arrives at the edge of Scene 3.
   */
  const pizzaTl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#flavours',
      start: 'top bottom',
      endTrigger: '#featured',
      end: 'top top',
      scrub: 0.6,
      onUpdate: (self) => { pizzaProgress = self.progress; },
    },
  });

  pizzaTl
    /* 0 → .34   rise in from the lower right, still almost edge-on. */
    .to(slice, { duration: 0.34, ox: 0.34, oy: -0.62, z: -1.1, rx: 0.92, ry: 0.30, s: 0.88 })
    /* .34 → .68 tip toward the viewer, centre stage behind the cards. */
    .to(slice, { duration: 0.34, ox: 0.06, oy: 0.10, z: -0.2, rx: 0.60, ry: 1.05, rz: 0.04, s: 1.0 })
    /* .68 → 1   slide across to Scene 3's half of the stage. */
    .to(slice, { duration: 0.32, ox: 0, oy: 0, z: 0, rx: 0.48, ry: 1.5, rz: 0, s: 1.0 });

  /*
   * Scene 3 itself, pinned.
   *
   * The explode only reads if the object holds still while it comes
   * apart — unpinned, the pizza drifts up the screen at the same time
   * and the two motions cancel each other out visually. The pin is
   * short on purpose (a little over one viewport) so it never feels
   * like the page has stopped responding.
   */
  const showcaseTl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#featured',
      start: 'top top',
      end: '+=115%',
      pin: true,
      pinSpacing: true,
      /*
       * This pin adds a little over a viewport of scroll distance, which
       * moves every section below it further down the page. ScrollTrigger
       * only accounts for that in triggers it refreshes *after* this one,
       * and the DOM choreography in motion.js is a separate lazy bundle
       * that usually registers its triggers first. Without a priority the
       * journey, offers, reviews and finale all resolved their start and
       * end about 1035px too early, so their entrances played out below
       * the fold and the sections were already flat on arrival.
       */
      refreshPriority: 10,
      /*
       * No `anticipatePin`: it works by nudging the scroll position just
       * before the pin engages, and that nudge is one of the things that
       * cancelled in-page navigation across this section.
       */
      scrub: 0.5,
      invalidateOnRefresh: true,
      onUpdate: (self) => { showcaseProgress = self.progress; },
    },
  });

  showcaseTl
    /* 0 → .34   slide into the showcase half, turning slowly. */
    .to(slice, { duration: 0.34, rx: 0.30, ry: 2.0, s: 1.08, home: 1 })
    /* .34 → .62 the layers lift apart: crust sinks, basil rises highest. */
    .to(slice, { duration: 0.28, rx: 0.52, ry: 2.6, s: 0.84, explode: 1 })
    /* .62 → .86 and come back together, still turning. */
    .to(slice, { duration: 0.24, rx: 0.34, ry: 3.3, s: 1.04, explode: 0 })
    /* .86 → 1   lift away as the pin releases. */
    .to(slice, { duration: 0.14, oy: 0.45, z: -0.8, rx: 0.5, ry: 3.7, s: 0.9 });

  /* Nudge the whole act back into step whenever the pin recalculates. */
  ScrollTrigger.addEventListener('refreshInit', () => { lastCut = -1; });

  /*
   * Scene 4 — the parcel's trip.
   *
   * It climbs in from the lower left, crosses the section turning as it
   * goes, and drops away to the lower right, which is the direction the
   * journey itself reads in.
   */
  const tripTl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      /*
       * Centred on the journey, not ahead of it. Starting at
       * `top bottom` meant the parcel had already finished two thirds
       * of its route before the section was even centred, so the one
       * thing travelling across Scene 4 was mostly over by the time
       * anyone read Scene 4.
       */
      trigger: '#how',
      start: 'top 78%',
      endTrigger: '#offers',
      end: 'top 55%',
      scrub: 0.6,
      invalidateOnRefresh: true,
      onUpdate: (self) => { tripProgress = self.progress; },
    },
  });

  tripTl
    .to(trip, { duration: 0.12, on: 1 }, 0)
    .to(trip, { duration: 0.34, fx: -0.45, fy: -0.32, z: -1.3, ry: 0.5, rx: 0.16, s: 0.95 })
    .to(trip, { duration: 0.34, fx: 0.34, fy: -0.16, z: -0.5, ry: 1.9, rx: 0.3, rz: -0.08, s: 1.04 })
    .to(trip, { duration: 0.32, fx: 1.12, fy: -0.82, z: -2.0, ry: 3.1, rx: 0.5, s: 0.82 })
    .to(trip, { duration: 0.1, on: 0 }, 0.9);

  /*
   * Scene 8 — the burger returns.
   *
   * A bookend rather than a new object: the same model that opened the
   * page rises one more time behind the closing call to action. It
   * costs no extra geometry, and nothing else on the page could end it
   * as well.
   */
  const finaleTl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#finale',
      start: 'top bottom',
      end: 'bottom bottom',
      scrub: 0.6,
      invalidateOnRefresh: true,
      onUpdate: (self) => { finaleProgress = self.progress; },
    },
  });

  /*
   * It rises from under the closing copy rather than behind it. Dead
   * centre, the bun sat straight across the headline and the stats
   * row, and everything above the buttons lost its contrast floor.
   */
  finaleTl
    .to(fin, { duration: 0.45, k: 1, fx: 0.16, fy: -0.52, z: 0.1, ry: 6.0, rx: 0.26, s: 0.96 })
    .to(fin, { duration: 0.55, fx: 0.1, fy: -0.16, z: -0.5, ry: 6.9, rx: 0.36, s: 0.88 });

  /* The opening rise: one scalar, so it can never fight the timeline. */
  const introTween = gsap.to(intro, { k: 1, duration: 2.1, ease: 'power3.out', delay: 0.12 });

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  const t0 = performance.now();

  function frame() {
    if (disposed) return;
    rafId = requestAnimationFrame(frame);

    const t = (performance.now() - t0) / 1000;
    const k = intro.k;

    /* ---------------------------------------------------------------
     * Measure first, write second: one layout read per frame, taken
     * before any style is written, so nothing thrashes.
     * ------------------------------------------------------------- */
    const vh = window.innerHeight;
    // `#featured` starts hidden and is revealed once its data arrives, so
    // fall back to the hero while it still has no box to measure.
    const actBox = actEl.getBoundingClientRect();
    const heroBottom = heroEl.getBoundingClientRect().bottom;
    const bottom = actBox.height > 0 ? actBox.bottom : heroBottom;

    cut = clamp(bottom, 0, vh);
    actVis = clamp(bottom / vh, 0, 1);
    heroVis = clamp(heroBottom / vh, 0, 1);

    /* --- the closing act's band ----------------------------------- */
    if (act2Start && act2End) {
      const top = act2Start.getBoundingClientRect().top;
      const end = act2End.getBoundingClientRect().bottom;

      const visibleTop = clamp(top, 0, vh);
      const visibleEnd = clamp(end, 0, vh);
      const height = Math.max(0, visibleEnd - visibleTop);

      act2Vis = clamp(height / vh, 0, 1);

      if (Math.abs(visibleTop - lastBandTop) > 0.5 || Math.abs(height - lastBandHeight) > 0.5) {
        lastBandTop = visibleTop;
        lastBandHeight = height;
        band.style.top = `${visibleTop.toFixed(1)}px`;
        band.style.height = `${height.toFixed(1)}px`;
        band.style.opacity = height > 1 ? '1' : '0';
      }

      // The header has to read as dark over this act too.
      document.documentElement.classList.toggle(
        'qb-hero-dark',
        cut > 120 || (top < 120 && end > 120)
      );
    }

    /* The dark backdrop stops exactly where the hero stops. */
    if (Math.abs(cut - lastCut) > 0.5) {
      lastCut = cut;
      stage.style.setProperty('--stage-cut', cut.toFixed(1) + 'px');
    }

    // The scroll cue has done its job the moment anyone scrolls.
    document.documentElement.classList.toggle('qb-scrolled', window.scrollY > 40);

    /*
     * How loud the 3D is allowed to be, in three stages.
     *
     *   hero on screen   1.00  the burger is the subject
     *   Scenes 2 and 3   0.55  atmosphere behind DOM-led sections
     *   past the act     0.00  gone
     *
     * The middle stage matters most: at full strength the pizza
     * crossing behind the flavour grid burned straight through the
     * half-faded cards and through the section's own subtitle. The 3D
     * is the subject in Scene 1 and the backdrop in Scenes 2 and 3, and
     * the opacity says so.
     *
     * The last stage used to keep a 0.22 echo over the menu. On a light
     * background the floating ingredients stopped reading as food and
     * started reading as dust on the screen, and the renderer kept
     * working for them. Retiring to zero both tidies the page below the
     * act and stops all WebGL work there — the frame loop bails out
     * below 0.02 without drawing anything.
     */
    const alpha = Math.max(
      0.55 * smoothstep(actVis) + 0.45 * smoothstep(heroVis),
      0.55 * smoothstep(act2Vis)
    );
    canvas.style.opacity = alpha.toFixed(3);

    /*
     * An invisible canvas is not worth any work at all.
     *
     * This guard existed, then was lost in an edit, and nothing noticed
     * because an invisible scene looks exactly the same whether or not
     * it is being rendered. The frame counter gave it away: 145 frames
     * drawn in 1.2 seconds while parked over the menu, every one of
     * them a full scene render at opacity 0. Measure the thing, not the
     * appearance.
     */
    if (alpha < 0.02) return;

    /* --- compose the opening rise with the scroll pose ------------- */
    /*
     * Three poses can claim the burger, in order: the opening rise, the
     * Scene 1 scroll timeline, and — right at the end of the page — the
     * finale. `fin.k` is a blend rather than a takeover, so the two
     * timelines never write the same property in the same frame.
     */
    const fk = smoothstep(clamp(fin.k, 0, 1));

    const ox = mix(mix(opening.ox, scroll.ox, k), fin.fx, fk);
    const oy = mix(mix(opening.oy, scroll.oy, k), fin.fy, fk);
    const z  = mix(mix(opening.z,  scroll.z,  k), fin.z,  fk);
    const s  = mix(mix(opening.s,  scroll.s,  k), fin.s,  fk);

    // The finale centres the burger, wherever the tier normally rests it.
    const restFx = mix(tier.restFx, 0, fk);
    const restFy = mix(tier.restFy, 0, fk);
    const fitW = mix(tier.fitW, tier.finaleFitW, fk);

    /*
     * Fit against the frustum at the burger's NEAR face, not at its
     * centre. The model is ~2.3 world units deep once scaled, and under
     * perspective its near face is measured against a visibly smaller
     * frustum — sizing at the centre let the bun spill past the right
     * edge of the screen even though the arithmetic said it fitted.
     *
     * One refinement pass is enough: the first estimate gives the radius,
     * the radius gives the near plane, the near plane gives the size.
     */
    const rough = Math.min((halfW(z) * 2 * fitW) / NATURAL_W, (halfH(z) * 2 * tier.fitH) / NATURAL_H);
    const zNear = z + (NATURAL_W / 2) * rough;

    const hh = halfH(zNear);
    const hw = halfW(zNear);
    // Whichever axis runs out of room first decides the size.
    const fit = Math.min((hw * 2 * fitW) / NATURAL_W, (hh * 2 * tier.fitH) / NATURAL_H);

    rig.position.set(
      (restFx + ox) * hw,
      (restFy + oy) * hh + Math.sin(t * 0.55) * 0.085,
      z
    );
    rig.scale.setScalar(fit * s);

    burger.rotation.set(
      mix(mix(opening.rx, scroll.rx, k), fin.rx, fk) + Math.sin(t * 0.42) * 0.025,
      mix(mix(opening.ry, scroll.ry, k), fin.ry, fk) + t * 0.028,
      mix(mix(opening.rz, scroll.rz, k), fin.rz, fk) + Math.cos(t * 0.37) * 0.02
    );

    /* --- ingredient separation, staggered bottom to top ------------ */
    const explode = scroll.explode * k;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const e = smoothstep(clamp(explode * 1.4 - i * 0.05, 0, 1));
      const wob = Math.sin(t * 0.9 + i * 1.1) * 0.03 * e;

      L.holder.position.set(
        L.ex * e * EXPLODE_SPAN,
        L.baseY + L.ey * e * EXPLODE_SPAN + wob,
        L.ez * e * EXPLODE_SPAN
      );
      L.holder.rotation.y = L.er * e;
      L.holder.rotation.z = L.er * e * 0.25;
    }

    shadowMat.opacity = 0.55 * (1 - explode * 0.7) * clamp(1 - Math.abs(tier.restFy + oy) * 0.5, 0, 1);

    /*
     * Anything fully outside the frame stops being drawn. The burger
     * spends the whole of Scenes 2 and 3 off to the left, and there is
     * no reason to keep shading it there.
     */
    const burgerReach = (NATURAL_W / 2) * rig.scale.x;
    rig.visible =
      Math.abs(rig.position.x) - burgerReach < hw &&
      Math.abs(rig.position.y) - burgerReach < hh;

    /* --- the pizza ------------------------------------------------ */
    // On stage from its approach right through the pinned showcase.
    if (pizzaProgress > 0.0005 && showcaseProgress < 0.9995) {
      const pz = slice.z;
      const pRough = (halfW(pz) * 2 * tier.pizzaFitW) / PIZZA_W;
      const pNear = pz + (PIZZA_W / 2) * pRough * Math.sin(clamp(slice.rx, 0, Math.PI / 2));

      const phh = halfH(pNear);
      const phw = halfW(pNear);
      const pFit = (phw * 2 * tier.pizzaFitW) / PIZZA_W;

      /*
       * Off-frame is not drawn. The pizza spends the whole of Scene 1
       * waiting below the viewport, and shading it there costs a draw
       * call per frame for something nobody can see.
       */
      const pReach = (PIZZA_W / 2) * pFit * slice.s;
      pizzaRig.visible =
        Math.abs((tier.pizzaFx + slice.ox + tier.showFx * slice.home) * phw) - pReach < phw &&
        Math.abs((tier.pizzaFy + slice.oy + tier.showFy * slice.home) * phh) - pReach < phh;

      const homeFx = tier.showFx * slice.home;
      const homeFy = tier.showFy * slice.home;

      pizzaRig.position.set(
        (tier.pizzaFx + slice.ox + homeFx) * phw,
        (tier.pizzaFy + slice.oy + homeFy) * phh + Math.sin(t * 0.47 + 1.9) * 0.07,
        pz
      );
      pizzaRig.scale.setScalar(pFit * slice.s);

      pizza.rotation.set(
        slice.rx + Math.sin(t * 0.39) * 0.02,
        slice.ry + t * 0.05,
        slice.rz + Math.cos(t * 0.33) * 0.015
      );

      /*
       * The layers come apart, bottom to top, with a per-layer offset so
       * the crust has already started sinking before the basil leaves.
       * A flat stagger made the whole pizza look like one stretching
       * object rather than four separating ones.
       */
      for (let i = 0; i < pizzaLayers.length; i++) {
        const L = pizzaLayers[i];
        const e = smoothstep(clamp(slice.explode * 1.3 - i * 0.07, 0, 1));
        const drift = Math.sin(t * 0.8 + i * 1.4) * 0.035 * e;

        L.holder.position.set(
          L.ex * e * PIZZA_SPAN,
          L.baseY + L.ey * e * PIZZA_SPAN + drift,
          L.ez * e * PIZZA_SPAN
        );
        L.holder.rotation.y = L.er * e;
        L.holder.rotation.z = L.er * e * 0.18;
      }
    } else {
      pizzaRig.visible = false;
    }

    /* --- the parcel ------------------------------------------------ */
    if (trip.on > 0.01 && tripProgress > 0.0005 && tripProgress < 0.9995) {
      const tz = trip.z;
      const thh = halfH(tz);
      const thw = halfW(tz);
      const tFit = (thw * 2 * tier.parcelFitW) / PARCEL_W;
      const reach = (PARCEL_W / 2) * tFit * trip.s;

      const px = trip.fx * thw;
      const py = trip.fy * thh + Math.sin(t * 0.8 + 0.4) * 0.05;

      parcelRig.visible = Math.abs(px) - reach < thw && Math.abs(py) - reach < thh;
      parcelRig.position.set(px, py, tz);
      parcelRig.scale.setScalar(tFit * trip.s);

      parcel.rotation.set(
        trip.rx + Math.sin(t * 0.5) * 0.03,
        trip.ry + t * 0.06,
        trip.rz + Math.cos(t * 0.43) * 0.025
      );
    } else {
      parcelRig.visible = false;
    }

    /* --- floaters: depth parallax plus a scroll-driven rise -------- */
    for (const cloud of clouds) {
      for (let i = 0; i < cloud.items.length; i++) {
        const it = cloud.items[i];
        const h = halfH(it.z);
        const w = h * camera.aspect;

        const bob = Math.sin(t * it.speed + it.phase) * 0.22;
        const y = it.fy * h + bob + scroll.drift * it.rise * h * 0.9;
        // Wrap vertically so the cloud never empties out on a long scroll.
        const wrapped = ((y + h * 1.4) % (h * 2.8) + h * 2.8) % (h * 2.8) - h * 1.4;

        dummy.position.set(it.fx * w + Math.cos(t * it.speed * 0.7 + it.phase) * 0.18, wrapped, it.z);
        dummy.rotation.set(t * it.spin, it.phase + t * it.spin * 1.3, t * it.spin * 0.6);
        dummy.scale.set(it.scale[0], it.scale[1], it.scale[2]);
        dummy.updateMatrix();
        cloud.mesh.setMatrixAt(i, dummy.matrix);
      }
      cloud.mesh.instanceMatrix.needsUpdate = true;
    }
    floaterGroup.visible = k > 0.25;

    /* --- camera parallax ------------------------------------------ */
    pointer.x += (pointer.tx - pointer.x) * 0.045;
    pointer.y += (pointer.ty - pointer.y) * 0.045;
    camera.position.x = pointer.x * tier.parallax;
    camera.position.y = -pointer.y * tier.parallax * 0.6;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    frames++;
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  function play() {
    if (running || disposed) return;
    running = true;
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function onPointer(e) {
    if (!tier.parallax) return;
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }

  function onVisibility() {
    if (document.hidden) pause();
    else play();
  }

  let resizeTimer = 0;
  function onResize() {
    resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ScrollTrigger.refresh(), 180);
  }

  function onContextLost(e) {
    e.preventDefault();
    dispose();
  }

  /*
   * The menu grid and the recommendation rail arrive from the API after
   * first paint, which changes the document height and therefore every
   * scroll offset. Without this the timeline stays calibrated against a
   * page that no longer exists.
   */
  let bodyObserver = null;
  if (typeof ResizeObserver === 'function') {
    let pending = 0;
    bodyObserver = new ResizeObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(() => { if (!disposed) ScrollTrigger.refresh(); }, 220);
    });
    bodyObserver.observe(document.body);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pause();

    tl.scrollTrigger && tl.scrollTrigger.kill();
    tl.kill();
    pizzaTl.scrollTrigger && pizzaTl.scrollTrigger.kill();
    pizzaTl.kill();
    showcaseTl.scrollTrigger && showcaseTl.scrollTrigger.kill();
    showcaseTl.kill();
    tripTl.scrollTrigger && tripTl.scrollTrigger.kill();
    tripTl.kill();
    finaleTl.scrollTrigger && finaleTl.scrollTrigger.kill();
    finaleTl.kill();
    introTween.kill();

    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    bodyObserver && bodyObserver.disconnect();
    clearTimeout(resizeTimer);

    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else if (o.material) o.material.dispose();
    });
    lights.forEach((l) => l.dispose && l.dispose());
    if (shadowMat.map) shadowMat.map.dispose();
    renderer.dispose();

    document.documentElement.classList.remove('qb-3d', 'qb-hero-dark', 'qb-scrolled');
    stage.remove();
  }

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  resize();
  renderer.render(scene, camera);   // prove the context works before committing
  document.documentElement.classList.add('qb-3d');
  ScrollTrigger.refresh();
  play();

  /* ---------------------------------------------------------------- */
  /* Test surface                                                      */
  /* ---------------------------------------------------------------- */

  /*
   * Deliberately exposed. The browser tests read the burger's real
   * matrix values at several scroll offsets, because "the animation is
   * genuinely scroll-linked rather than a one-shot reveal" is the one
   * claim about this feature that is easy to fake and impossible to
   * prove from a screenshot.
   */
  return {
    tier: () => tier.id,
    frames: () => frames,
    progress: () => progress,
    intro: () => intro.k,

    /*
     * The scroll-derived pose on its own, with no idle float or drift
     * mixed in. `read()` below reports what was actually rendered, which
     * necessarily includes the deliberate ambient motion; a test that
     * needs to compare two moments in time needs this one instead.
     */
    pose: () => ({ ...scroll }),

    /*
     * The real scroll offsets each act occupies, straight from
     * ScrollTrigger. The tests used to reconstruct these by hand and got
     * them subtly wrong — the sticky header shifts the hero's start by
     * its own height — which made evenly-spaced samples land off the
     * keyframes they were meant to be checking.
     */
    ranges: () => ({
      burger: tl.scrollTrigger
        ? { start: tl.scrollTrigger.start, end: tl.scrollTrigger.end }
        : null,
      pizza: pizzaTl.scrollTrigger
        ? { start: pizzaTl.scrollTrigger.start, end: pizzaTl.scrollTrigger.end }
        : null,
      showcase: showcaseTl.scrollTrigger
        ? { start: showcaseTl.scrollTrigger.start, end: showcaseTl.scrollTrigger.end }
        : null,
      trip: tripTl.scrollTrigger
        ? { start: tripTl.scrollTrigger.start, end: tripTl.scrollTrigger.end }
        : null,
      finale: finaleTl.scrollTrigger
        ? { start: finaleTl.scrollTrigger.start, end: finaleTl.scrollTrigger.end }
        : null,
    }),

    /* Scene 3's pizza, reported the same way as the burger. */
    pizza: () => ({
      progress: pizzaProgress,
      showcase: showcaseProgress,
      visible: pizzaRig.visible,
      spread: pizzaLayers[pizzaLayers.length - 1].holder.position.y - pizzaLayers[0].holder.position.y,
      x: pizzaRig.position.x, y: pizzaRig.position.y, z: pizzaRig.position.z,
      scale: pizzaRig.scale.x,
      rx: pizza.rotation.x, ry: pizza.rotation.y, rz: pizza.rotation.z,
      pose: { ...slice },
    }),

    /* Scene 4's parcel. */
    parcel: () => ({
      progress: tripProgress,
      visible: parcelRig.visible,
      x: parcelRig.position.x, y: parcelRig.position.y, z: parcelRig.position.z,
      scale: parcelRig.scale.x,
      ry: parcel.rotation.y,
      pose: { ...trip },
    }),

    /* Scene 8's returning burger. */
    finale: () => ({
      progress: finaleProgress,
      blend: fin.k,
      pose: { ...fin },
      act2: act2Vis,
      band: { top: band.style.top, height: band.style.height },
    }),

    read: () => ({
      x: rig.position.x, y: rig.position.y, z: rig.position.z,
      scale: rig.scale.x,
      rx: burger.rotation.x, ry: burger.rotation.y, rz: burger.rotation.z,
      explode: scroll.explode,
      visible: rig.visible,
      cut,
      actVis,
      // Not `|| 1`: a fully faded canvas reports 0, and `0 || 1` is 1.
      alpha: canvas.style.opacity === '' ? 1 : Number(canvas.style.opacity),
      spread: layers[layers.length - 1].holder.position.y - layers[0].holder.position.y,
    }),
    dispose,
  };
}
