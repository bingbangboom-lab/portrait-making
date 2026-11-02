// Painterly portrait engine for p5.brush 3.0.0 (p5 2.x, WEBGL).
//
// Five styles, chosen with SUBJECT.style or ?style= in the URL (see STYLES):
//   "oil" (default), "charcoal" (graphite and charcoal drawing), "watercolour"
//   (transparent washes on white paper), "ink" (pen and ink hatching) and
//   "pastel" (soft pastel on toned paper).
//
// Paints the way a portrait painter works, not traced:
//   1. a warm toned ground and a loose sienna underdrawing
//   2. a block-in of big value masses with a wide bristle brush
//   3. smaller strokes that follow the form, concentrated around the face
//   4. fine work only in the focal area (eyes, nose, mouth)
//   5. a few decisive accents: darkest darks, catchlights, highlights
// The photo is looked at the way a painter looks at a sitter: colour and the
// direction of forms are read from it, then pushed (cool shadows, warm
// lights, simplified values) and left loose and unfinished towards the edges.
//
// Everything specific to one sitter lives in subject.js (the SUBJECT object).
// Its coordinates are in "reference units": the photo scaled to SUBJECT.refWidth.

const W = 800;               // canvas width; height follows the photo
const GW = 400;              // analysis grid width; height follows the photo
const G = W / GW;            // grid -> canvas
let H, GH, S;                // set once the photo is loaded

// ?record paints in smaller steps per frame, for capturing the process
const RECORD = new URLSearchParams(location.search).has("record");
const STROKES_PER_FRAME = RECORD ? 30 : 160;
const STYLE = new URLSearchParams(location.search).get("style") || SUBJECT.style || "oil";

const C = Object.assign({
  ground:    "#e7d8cc",
  sienna:    "#9a5b3e",
  umber:     "#3b2419",
  cool:      [118, 100, 146],
  rose:      [168, 104, 108],
  warm:      [255, 228, 216],
  paper:     "#f3efe7",
  ink:       "#1d1b1f",
  inkPaper:  "#fbf9f4",
  pastelPaper: "#b8ab9a",
}, SUBJECT.palette || {});

// ------------------------------------------------------------- reference

let ref;      // blurred colour levels of the photo
let tensor;   // smoothed structure tensor for the direction of forms

async function loadReference(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  wcPhoto = img;
  GH = Math.round(GW * img.naturalHeight / img.naturalWidth);
  const cv = document.createElement("canvas");
  cv.width = GW;
  cv.height = GH;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, GW, GH);
  const d = ctx.getImageData(0, 0, GW, GH).data;
  return [0, 1, 2].map((ch) => Float32Array.from({ length: GW * GH }, (_, i) => d[i * 4 + ch]));
}

// three passes of a separable box blur approximate a gaussian
function blurChannel(src, r) {
  if (r < 1) return src;
  const a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < GH; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * GW + constrain(x, 0, GW - 1)];
      for (let x = 0; x < GW; x++) {
        b[y * GW + x] = acc / (2 * r + 1);
        acc += a[y * GW + Math.min(x + r + 1, GW - 1)] - a[y * GW + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < GW; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[constrain(y, 0, GH - 1) * GW + x];
      for (let y = 0; y < GH; y++) {
        a[y * GW + x] = acc / (2 * r + 1);
        acc += b[Math.min(y + r + 1, GH - 1) * GW + x] - b[Math.max(y - r, 0) * GW + x];
      }
    }
  }
  return a;
}

const blurRGB = (rgb, r) => rgb.map((ch) => blurChannel(ch, r));
const lum = (rgb) => rgb[0].map((_, i) => 0.299 * rgb[0][i] + 0.587 * rgb[1][i] + 0.114 * rgb[2][i]);

function structureTensor(L, r) {
  const xx = new Float32Array(GW * GH), xy = new Float32Array(GW * GH), yy = new Float32Array(GW * GH);
  for (let y = 1; y < GH - 1; y++) {
    for (let x = 1; x < GW - 1; x++) {
      const p = (dx, dy) => L[(y + dy) * GW + x + dx];
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      const i = y * GW + x;
      xx[i] = gx * gx; xy[i] = gx * gy; yy[i] = gy * gy;
    }
  }
  return [blurChannel(xx, r), blurChannel(xy, r), blurChannel(yy, r)];
}

function sampleAt(level, x, y) {
  const gx = constrain(x / G, 0, GW - 1.001), gy = constrain(y / G, 0, GH - 1.001);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const i = y0 * GW + x0;
  return level.map((ch) =>
    (ch[i] * (1 - fx) + ch[i + 1] * fx) * (1 - fy) + (ch[i + GW] * (1 - fx) + ch[i + GW + 1] * fx) * fy);
}

// direction along the form at a canvas point; where the photo has no clear
// structure, fall back to the painter's natural diagonal hand movement
function formDirection(x, y, field = tensor) {
  const i = constrain(Math.round(y / G), 0, GH - 1) * GW + constrain(Math.round(x / G), 0, GW - 1);
  const jxx = field[0][i], jxy = field[1][i], jyy = field[2][i];
  const tr = jxx + jyy;
  const coherence = tr > 1e-3 ? Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / tr : 0;
  const edge = 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2;
  const hand = (115 + 50 * (noise(x * 0.004, y * 0.004) - 0.5)) * Math.PI / 180;
  // away from the face, trust the hand more than the photo's micro-structure
  const k = constrain((coherence - 0.22) * 2.5, 0, 1) * Math.min(1, 0.3 + 1.4 * attention(x, y));
  let dx = Math.cos(edge) * k, dy = Math.sin(edge) * k;
  // align the two candidates before mixing so the blend stays continuous
  const hx = Math.cos(hand), hy = Math.sin(hand);
  const s = dx * hx + dy * hy < 0 ? -1 : 1;
  dx = dx * s + hx * (1 - k);
  dy = dy * s + hy * (1 - k);
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

// ------------------------------------------------------------- the painter's eye

const gauss = (x, y, [cx, cy, sx, sy]) => Math.exp(-(((x - cx * S) / (sx * S)) ** 2 + ((y - cy * S) / (sy * S)) ** 2) / 2);

// how much attention a region gets: most at the eyes, less at the edges
function attention(x, y) {
  return Math.max(gauss(x, y, SUBJECT.attention.face), 0.55 * gauss(x, y, SUBJECT.attention.head));
}

// the canvas is left loose and unfinished towards the bottom and the edges
function finish(x, y) {
  const n = noise(x * 0.01, y * 0.01) * 0.35;
  const bottom = constrain((H * 0.97 - y) / (H * (SUBJECT.unfinishedBottom ?? 0.3)) + n - 0.15, 0, 1);
  const side = constrain(Math.min(x, W - x, y) / 70 + n - 0.1, 0, 1);
  return bottom * side;
}

let FOCAL;
const inFocal = (x, y) => FOCAL.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1);

// observed colour -> painted colour: simplified value, cool shadows, warm
// lights, a little more chroma, and the small variation of a loaded brush
function paintColour(rgb, { simplify = 0, jitter = 6, lift = 1 } = {}) {
  let [r, g, b] = rgb;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (simplify > 0) {
    const q = Math.round(L * 6) / 6;
    const f = 1 + simplify * ((q + 0.02) / (L + 0.02) - 1);
    r *= f; g *= f; b *= f;
  }
  const mixTo = (c, t) => { r += (c[0] - r) * t; g += (c[1] - g) * t; b += (c[2] - b) * t; };
  // pigment mixing turns blue-violet over peach into olive, so skin shadows
  // lean rose; only hair, cloth and backdrop shadows go properly cool
  const skin = r > g && g > b && r - b > 25 && L > 0.3;
  if (L < 0.5) mixTo(skin ? C.rose : C.cool, (0.5 - L) * 0.2);
  if (L > 0.62) mixTo(C.warm, (L - 0.62) * 0.35);
  // enliven muted colours, leave already-strong ones alone
  const m = (r + g + b) / 3;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const boost = 1 + 0.2 * constrain(1 - chroma / 90, 0, 1) - 0.08 * constrain(chroma / 90 - 1, 0, 1);
  r = m + (r - m) * boost; g = m + (g - m) * boost; b = m + (b - m) * boost;
  // layered strokes mix darker, like real paint: mix the colour a little lighter
  lift *= 1 - 0.7 * L;
  r = r * (1 + 0.16 * lift) + 14 * lift;
  g = g * (1 + 0.16 * lift) + 14 * lift;
  b = b * (1 + 0.16 * lift) + 26 * lift; // pigment mixing drifts yellow
  const j = () => randomGaussian(0, jitter);
  return color(constrain(r + j(), 0, 255), constrain(g + j(), 0, 255), constrain(b + j(), 0, 255));
}

// which photo colours count as backdrop (by default: light and neutral; for a
// dark backdrop set minBrightness: -1 and a low maxBrightness)
const isBackground = (rgb) => {
  const { minBrightness = 200, maxBrightness = 256, maxChroma = 22 } = SUBJECT.backdrop.detect || {};
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  return mx > minBrightness && mx < maxBrightness && mx - mn < maxChroma;
};

// the backdrop is not copied: it is a broken colour that drifts between two
// tones and darkens a little behind the head
function backgroundColour(x, y) {
  const [a, b, c] = SUBJECT.backdrop.colours;
  const n = noise(x * 0.006 + 40, y * 0.006);
  const t = constrain(n * 1.6 - 0.3, 0, 1);
  const mix = a.map((v, i) => v + (b[i] - v) * t);
  const shadow = gauss(x, y, SUBJECT.backdrop.shade) ** 2;
  return paintColour(mix.map((v, i) => v + (c[i] - v) * shadow * 0.65), { jitter: 4, lift: 0 });
}

// ------------------------------------------------------------- strokes

// Follow the form from a starting point until the colour under the brush
// changes too much (Hertzmann's curved brush strokes).
function traceStroke(level, x, y, { radius, maxSteps, minSteps = 2, threshold, angle = null, follow = 0.3 }) {
  const c0 = sampleAt(level, x, y);
  const pts = [[x, y]];
  let px = x, py = y, pdx = 0, pdy = 0;
  const flip = random() < 0.5 ? -1 : 1;
  for (let i = 0; i < maxSteps; i++) {
    // with an angle, the strokes keep to one hatching direction, leaning into the form
    let [dx, dy] = angle === null ? formDirection(px, py) : markDirection(px, py, angle, follow, tensor);
    if (i === 0) { dx *= flip; dy *= flip; }
    else {
      if (dx * pdx + dy * pdy < 0) { dx = -dx; dy = -dy; }
      dx = 0.55 * dx + 0.45 * pdx; dy = 0.55 * dy + 0.45 * pdy;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    }
    const nx = px + dx * radius, ny = py + dy * radius;
    if (nx < 0 || ny < 0 || nx > W || ny > H) break;
    const c = sampleAt(level, nx, ny);
    if (i >= minSteps && Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]) > threshold) break;
    px = nx; py = ny; pdx = dx; pdy = dy;
    pts.push([px, py]);
  }
  return { pts, c0 };
}

function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// One layer of painting: candidate brush positions on a jittered grid,
// visited in random order like a hand moving around the canvas.
function* paintLayer({ level, colourLevel = level, lift = 1, radius, spacing, threshold, maxSteps, keep, brushName = "bristle", dryChance = 0, simplify = 0, background = true, bgKeep = 1, weightScale = 1, jitter = 6, angle = null, follow = 0.3, minPts = 2 }) {
  const starts = [];
  for (let y = spacing / 2; y < H; y += spacing)
    for (let x = spacing / 2; x < W; x += spacing)
      starts.push([x + random(-0.5, 0.5) * spacing, y + random(-0.5, 0.5) * spacing]);
  shuffled(starts);

  let n = 0;
  for (const [x, y] of starts) {
    if (random() > keep(x, y)) continue;
    const bg = !inFigure(x, y) && (isBackground(sampleAt(level, x, y)) || isBackground(sampleAt(ref.sharp, x, y)));
    // (random() only when needed, so the seeded oil painting stays as approved)
    if (bg && (!background || (bgKeep !== 1 && random() > (typeof bgKeep === "function" ? bgKeep(x, y) : bgKeep)))) continue;
    // the backdrop gets longer, broader, calmer strokes
    const r = bg ? radius * 1.4 : radius;
    const traced = traceStroke(level, x, y, { radius: r, maxSteps, threshold: bg ? threshold * 2 : threshold, angle, follow }).pts;
    // the brush lifts off where the canvas is left unfinished
    const cut = traced.findIndex(([px, py]) => finish(px, py) < 0.12);
    const pts = cut < 0 ? traced : traced.slice(0, cut);
    if (pts.length < minPts) continue;
    const col = bg ? backgroundColour(x, y) : paintColour(sampleAt(colourLevel, x, y), { simplify, lift, jitter });
    brush.set(random() < dryChance ? "dry" : brushName, col, (r * 2) / 10 * weightScale * random(0.85, 1.15));
    brush.spline(pts, 0.5);
    if (++n % STROKES_PER_FRAME === 0) yield;
  }
  yield;
}

const sc = (arr) => arr.map(([x, y, p]) => (p === undefined ? [x * S, y * S] : [x * S, y * S, p]));

// ------------------------------------------------------------- the painting

function* painting() {
  yield* toneGround();
  yield* underdrawing();

  // block-in: a big brush; shapes and values judged through a squint, but
  // the colour itself mixed clean
  yield* paintLayer({
    level: ref.squint, colourLevel: ref.soft, radius: 13, spacing: 15, threshold: 46, maxSteps: 7, simplify: 0.55,
    keep: (x, y) => 0.75 * finish(x, y), dryChance: 0.1,
  });
  // the forms: a mid-size brush, steered by the planes of the face
  yield* paintLayer({
    level: ref.soft, radius: 7, spacing: 8, threshold: 30, maxSteps: 10, simplify: 0.25, background: false,
    keep: (x, y) => finish(x, y) * (0.12 + 0.88 * attention(x, y)), dryChance: 0.06,
  });
  // refinement where the eye goes
  yield* paintLayer({
    level: ref.mid, lift: 0.6, radius: 3.6, spacing: 4.5, threshold: 22, maxSteps: 10, background: false,
    keep: (x, y) => (inFocal(x, y) ? 0.9 : Math.max(0, attention(x, y) - 0.45) * 1.1) * finish(x, y),
  });
  // the last small touches, only in the features
  yield* paintLayer({
    level: ref.sharp, lift: 0.3, radius: 1.8, spacing: 2.6, threshold: 18, maxSteps: 7, background: false,
    keep: (x, y) => (inFocal(x, y) ? 0.55 : 0),
  });

  yield* hairLights();
  yield* hairEdges();
  yield* accents();
}

// Light catching the waves of the hair: wherever a strand is lighter than
// the mass around it, a dry, warm stroke pulled along the hair's direction.
function* hairLights() {
  const { maxLum = 105, light = [196, 144, 104] } = SUBJECT.hair || {};
  const L = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  let n = 0;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const soft = sampleAt(ref.soft, x, y);
      if (L(soft) > maxLum) continue;
      const seen = sampleAt(ref.sharp, x, y);
      const lift = L(seen) - L(soft);
      if (lift < 6 || random() > 0.5 * finish(x, y)) continue;
      const { pts } = traceStroke(ref.mid, x, y, { radius: 3.5, maxSteps: 9, minSteps: 4, threshold: 60 });
      if (pts.length < 3) continue;
      const t = constrain(lift / 40, 0.2, 0.7);
      const col = seen.map((v, i) => v * 1.15 + (light[i] - v) * t);
      brush.set("dry", paintColour(col, { jitter: 8 }), random(0.45, 0.75));
      brush.spline(pts, 0.5);
      if (++n % (STROKES_PER_FRAME * 1.25) === 0) yield;
    }
  }
  yield;
}

function* toneGround() {
  brush.noStroke();
  brush.fillBleed(0.2, "out");
  brush.fillTexture(0.7, 0.25, true, 0.3);
  brush.fill(C.ground, 150);
  brush.rect(-20, -20, W + 40, H + 40);
  // spline() fills its path while a fill is active, so switch it off
  brush.noFill();
  yield;
}

// searching sienna lines, drawn quickly and more than once
function* underdrawing(colour = C.sienna, light = false) {
  brush.wiggle(2.5);
  for (const [name, path] of Object.entries(SUBJECT.sketch)) {
    const passes = /^(eye|nose|mouth)/.test(name) ? 1 : 2;
    for (let k = 0; k < passes; k++) {
      brush.set(light ? (k ? "2H" : "HB") : (k ? "2H" : "cpencil"), colour, random(0.6, 0.9));
      const j = k ? 6 : 0;
      brush.spline(sc(path.map(([x, y]) => [x + random(-j, j), y + random(-j, j)])), 0.5);
    }
    if (RECORD) yield;
  }
  // construction lines: the centre of the face and the eye line
  brush.set("2H", colour, 0.5);
  for (const [x1, y1, x2, y2] of SUBJECT.construction || []) brush.line(x1 * S, y1 * S, x2 * S, y2 * S);
  brush.noField();
  yield;
}

// a few flyaways that break the silhouette of the hair
function* hairEdges() {
  brush.wiggle(1.2);
  brush.set("liner", C.umber, 0.35);
  for (const f of (SUBJECT.hair && SUBJECT.hair.flyaways) || []) brush.spline(sc(f), 0.7);
  brush.noField();
  yield;
}

// styles drawn only in lines of one colour, with no tone of their own

// The decisive marks a painter saves for last. They are few, and broken
// rather than outlines: the lash line only where it is darkest, the pupils,
// the catchlights, the deepest corners of the nostrils and the mouth.
function* accents() {
  const A = SUBJECT.accents;
  const mark = (name, col, w, pts) => {
    brush.set(name, col, w);
    brush.spline(sc(pts), 0.6);
  };
  const dot = (col, [x, y, r]) => {
    brush.noStroke();
    brush.wash(col, 240);
    brush.polygon(sc(Array.from({ length: 18 }, (_, i) => [x + r * cos(i * 20), y + r * sin(i * 20)])));
    brush.noWash();
  };

  // thin lines the photo analysis loses, e.g. glasses frames: drawn in short
  // runs with a few gaps, so the edge is lost and found rather than outlined
  for (const { path, colour = "#3a2620", weight = 1 } of A.lines || []) {
    let run = [];
    for (const p of path) {
      run.push(p);
      if (run.length > 3 && random() < 0.25) { mark("liner", colour, weight * random(0.6, 1.1), run); run = random() < 0.5 ? [p] : []; }
    }
    if (run.length > 1) mark("liner", colour, weight, run);
  }
  for (const p of A.lashes || []) mark("liner", "#1c120d", 1.8, p);
  for (const d of A.pupils || []) dot("#140c08", d);
  for (const d of A.catchlights || []) dot("#fff8f0", d);
  for (const p of A.nostrils || []) mark("bristle", "#5a2c20", 0.3, p);
  for (const p of A.mouth || []) mark("liner", "#6e2a2c", 1.7, p);
  for (const { path, colour = "#eed8ca", brush: name = "dry" } of A.lights || []) mark(name, colour, 0.3, path);
  yield;
}

// ============================================================= shared by the styles

let flow;     // a smoother direction field for long strokes through the hair

// direction for a mark: a fixed hatching angle, the form, or a blend of both
function markDirection(x, y, angle, follow, field) {
  const [fx, fy] = formDirection(x, y, field);
  if (angle === null) return [fx, fy];
  const a = (angle + 12 * (noise(x * 0.01, y * 0.01) - 0.5)) * Math.PI / 180;
  let ax = Math.cos(a), ay = Math.sin(a);
  const s = fx * ax + fy * ay < 0 ? -1 : 1;
  ax = ax * (1 - follow) + fx * s * follow;
  ay = ay * (1 - follow) + fy * s * follow;
  const l = Math.hypot(ax, ay) || 1;
  return [ax / l, ay / l];
}

function* paper(colour = "#e9e3d8", opacity = 50) {
  brush.noStroke();
  brush.fillBleed(0.1, "out");
  brush.fillTexture(0.8, 0, true, 0);
  brush.fill(colour, opacity);
  brush.rect(-20, -20, W + 40, H + 40);
  brush.noFill();
  yield;
}

// ============================================================= charcoal style
//
// Drawn the way a draughtsman works, looking back at the sheet after every pass:
//   tone the sheet -> block in -> mass the ground and the big shapes -> rub the
//   skin -> marks along the forms -> compressed darks -> lift the lights -> the
//   features in graphite -> strands, accents and the rim of the ground.
//
// Two sheets of pigment are kept apart, because they behave differently on paper:
//   chSmudge: rubbed in by rag and stump, smooth, plus graphite
//   chStick:  sitting on the hills of the paper; the display shader thresholds it
//             against a height map of the paper, so it breaks on the tooth
// Rubs stop short of the target, so that visible strokes have the last of the
// value to carry; otherwise the drawing is right but looks like a filtered photo.

const CH_U = W / 1200;   // recipes are written for a sheet 1200 units wide
const CH_INK = [0.066, 0.062, 0.066];
let chSmudge, chStick, chShader, chTooth, chRegion, chKinds, chMargin, chT, chFocus, chFineFlow;
let chSeen = null, chLooks = 0, chMarks = 0, chSkinValue, chEdge;

const chGrid = (a, x, y) => a[constrain(y / G | 0, 0, GH - 1) * GW + constrain(x / G | 0, 0, GW - 1)];
const chSmooth = (a, b, v) => { const t = constrain((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function chTools() {
  const u = CH_U;
  // the side of a vine stick dragged flat: a band of uneven specks across the stroke
  brush.add("vineSide", {
    type: "custom", weight: 52 * u, scatter: 1.2 * u, opacity: 26, spacing: 2.2 * u,
    pressure: [0.82, 1.05, 0.72], rotate: "natural", markerTip: false, noise: 1,
    tip: (t) => {
      t.noStroke();
      for (let i = 0; i < 90; i++) {
        const y = random(-48, 48), edge = 1 - Math.pow(Math.abs(y) / 50, 3);
        t.fill(0, 40 + 170 * edge * random());
        t.rect(random(-6, -3), y, random(6, 12), random(0.6, 3.2));
      }
    },
  });
  // rag, stump and kneaded eraser are soft round contacts with the paper
  const softTip = (t) => {
    t.noStroke();
    for (let r = 48; r > 2; r -= 2) { t.fill(0, 9); t.circle(0, 0, r * 2); }
  };
  const soft = (weight, scatter, opacity, spacing, pressure) => ({ type: "custom", rotate: "random", markerTip: false, tip: softTip, weight: weight * u, scatter: scatter * u, opacity, spacing: spacing * u, pressure });
  brush.add("rag", soft(90, 3, 9, 7, [0.8, 1.1, 0.8]));
  brush.add("stump", soft(26, 0.6, 8, 1.8, [0.7, 1.05, 0.65]));
  // moves the paper 40-55% of the way to its colour in one pass, at any size; its mark
  // is about 50 x weight wide. A thin tip needs less opacity, or strokes read as dashes.
  brush.add("rub", soft(60, 1, 30, 3, [0.8, 1.05, 0.8]));
  brush.add("rubFine", soft(60, 1, 16, 3, [0.8, 1.05, 0.8]));
  brush.add("putty", soft(24, 0.3, 9, 1.4, [0.55, 1.1, 0.5]));
  brush.add("puttyPoint", soft(5, 0.1, 60, 0.6, [0.5, 1.1, 0.4]));
  // points: clouds of dots, scatter the half width, grain the continuity of the mark
  const taper = { mode: "gaussian", curve: [0.25, 0.25], min_max: [1.12, 0.62] };
  const point = (weight, scatter, sharpness, grain, opacity, spacing, noiseAmount) => ({ weight: weight * u, scatter: scatter * u, sharpness, grain, opacity, spacing: spacing * u, pressure: taper, noise: noiseAmount });
  brush.add("vine", point(1, 3.6, 0.88, 0.75, 34, 0.2, 1));
  brush.add("willow", point(1.1, 2.2, 0.9, 0.85, 70, 0.16, 0.8));
  brush.add("compressed", point(1.4, 1.5, 0.92, 1, 80, 0.12, 0.5));
  brush.add("graphite4B", point(0.85, 0.75, 0.9, 1, 62, 0.1, 0.5));
  brush.add("graphiteHB", point(0.6, 0.4, 0.9, 1, 42, 0.1, 0.5));
  brush.add("flush", { weight: 0.1, scatter: 0, sharpness: 1, grain: 1, opacity: 1, spacing: 1, pressure: taper, noise: 0 });
}

// radius and gives: how much error one mark is credited with removing, so a pass
// doesn't pile every stroke on the same spot
const CH_TOOLS = {
  rag:        { brush: "rag", layer: "smudge", colour: "#9c9995", radius: 34, gives: 0.008 },
  vineSide:   { brush: "vineSide", layer: "stick", colour: "#2c2a29", radius: 20, gives: 0.03 },
  stump:      { brush: "stump", layer: "smudge", colour: "#5c5956", radius: 10, gives: 0.02 },
  rub:        { brush: "rub", layer: "smudge", colour: "#808080", radius: 10, gives: 0.04 },
  rubFine:    { brush: "rubFine", layer: "smudge", colour: "#808080", radius: 10, gives: 0.03 },
  rubLift:    { brush: "rub", layer: "both", colour: "#ffffff", radius: 8, gives: 0.05, lifts: true },
  vine:       { brush: "vine", layer: "stick", colour: "#2a2827", radius: 4, gives: 0.04 },
  willow:     { brush: "willow", layer: "stick", colour: "#1b1a1a", radius: 3, gives: 0.07 },
  compressed: { brush: "compressed", layer: "stick", colour: "#0b0a0b", radius: 2, gives: 0.16 },
  graphite4B: { brush: "graphite4B", layer: "smudge", colour: "#262528", radius: 1, gives: 0.09 },
  graphiteHB: { brush: "graphiteHB", layer: "smudge", colour: "#413f43", radius: 1, gives: 0.06 },
  putty:      { brush: "putty", layer: "both", colour: "#ffffff", radius: 9, gives: 0.03, lifts: true },
  puttyPoint: { brush: "puttyPoint", layer: "both", colour: "#ffffff", radius: 2, gives: 0.09, lifts: true },
};

// p5.brush composites a colour when the next colour arrives, so a stroke off the
// sheet makes what is pending land in this layer, not on the canvas at frame end
function chLand() {
  brush.set("flush", "#ff00fe", 1);
  brush.line(-1e5, -1e5, -1e5 + 1, -1e5);
}

// each stroke is { tool, points: [[x, y, pressure]...], weight, colour?, curve? }
function chCommit(strokes) {
  for (const layer of [chSmudge, chStick]) {
    const name = layer === chSmudge ? "smudge" : "stick";
    const here = strokes.filter((s) => s.tool.layer === name || s.tool.layer === "both");
    if (!here.length) continue;
    layer.begin();
    brush.load(layer);
    let run = 0, last = null;
    for (const s of here) {
      const colour = s.colour ?? s.tool.colour;
      run = colour === last ? run + 1 : 0;
      last = colour;
      // the mask darkens pigment past 70% coverage, even white, so land it often
      if (run >= 6 && (STYLE === "pastel" || s.tool.brush.startsWith("rub"))) { chLand(); run = 0; }
      brush.set(s.tool.brush, colour, s.weight ?? 1);
      brush.spline(s.points.map(([x, y, p]) => [x - W / 2, y - H / 2, p ?? 1]), s.curve ?? 0.55);
    }
    chLand();
    layer.end();
    brush.load();
  }
  chMarks += strokes.length;
}

// what the drawing looks like on the analysis grid; every comparison is blurred,
// so four samples a cell are enough
function chLook() {
  if (STYLE === "ink") return inLook();
  chSmudge.loadPixels();
  chStick.loadPixels();
  const a = chSmudge.pixels, b = chStick.pixels, d = pixelDensity(), stride = G * d, row = W * d;
  const out = chSeen ?? (chSeen = new Float32Array(GW * GH));
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    let sum = 0;
    for (let o = 0; o < 4; o++) {
      const i = 4 * ((gy * stride + (o >> 1) * d) * row + gx * stride + (o & 1) * d);
      sum += ((a[i] + a[i + 1] + a[i + 2]) / 765) * ((b[i] + b[i + 1] + b[i + 2]) / 765);
    }
    out[gy * GW + gx] = sum / 4;
  }
  return out;
}

// The eye reads a shape's value within the shape: blurring across an edge would mix
// the ground into a lit cheek and leave a halo. Each label is blurred on its own.
const chMasks = new Map();
function chWithinBlur(src, r) {
  const R = Math.round(r);
  if (R < 1) return Float32Array.from(src);
  const out = new Float32Array(src.length);
  for (let label = 0; label <= chMargin; label++) {
    const key = label + ":" + R;
    if (!chMasks.has(key)) chMasks.set(key, blurChannel(Float32Array.from(chRegion, (v) => (v === label ? 1 : 0)), R));
    const weight = chMasks.get(key);
    const summed = blurChannel(src.map((v, i) => (chRegion[i] === label ? v : 0)), R);
    for (let i = 0; i < out.length; i++) if (chRegion[i] === label) out[i] = weight[i] > 1e-3 ? summed[i] / weight[i] : src[i];
  }
  return out;
}

// a right-handed wrist hatches from upper right to lower left
const chWrist = () => (x, y) => -2.2 + (noise(x * 0.004, y * 0.004) - 0.5) * 0.7;
const chFlow = () => (x, y) => chGrid(chGrid(chFocus, x, y) > 0.4 ? chFineFlow : WCM.flow, x, y);
const chWays = {
  wrist: chWrist,
  flow: chFlow,
  // along the shape where it has a clear direction, otherwise with the wrist
  form: (x, y) => (random() < chGrid(WCM.coh, x, y) * 1.8 ? chFlow() : chWrist()),
};

function chTrace(x, y, length, step, way, need, tol, first, where, commitment = 0.3) {
  const dir = way(x, y);
  let angle = dir(x, y) + (random() < 0.5 ? Math.PI : 0);
  const pts = [[x, y, first * 0.7]];
  let went = 0;
  while (went < length) {
    let next = dir(x, y);
    if (Math.cos(next - angle) < 0) next += Math.PI;
    angle += Math.atan2(Math.sin(next - angle), Math.cos(next - angle)) * 0.65;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    went += step;
    if (x < 2 || y < 2 || x > W - 2 || y > H - 2) break;
    if (where && !where(x, y)) break;
    const n = chGrid(need, x, y);
    if (n < tol && went > length * commitment) break;   // the hand lifts at what is already right
    pts.push([x, y, first * (0.75 + 0.5 * Math.min(1, Math.max(0, n) * 3))]);
  }
  return pts;
}

function chCredit(need, pts, radius, amount) {
  const rg = Math.max(1, Math.round(radius / G));
  for (const p of pts) {
    const cx = p[0] / G | 0, cy = p[1] / G | 0;
    for (let oy = -rg; oy <= rg; oy++) {
      const yy = cy + oy;
      if (yy < 0 || yy >= GH) continue;
      for (let ox = -rg; ox <= rg; ox++) {
        const xx = cx + ox;
        if (xx >= 0 && xx < GW && ox * ox + oy * oy <= rg * rg) need[yy * GW + xx] -= amount;
      }
    }
  }
}

// a matched stroke carries dust of the value it corrects towards: it pulls the paper
// to that value from either side and can't overshoot, so skin settles without clouds
const chGrey = (v) => { const g = Math.round((Math.round(constrain(v, 0, 1) * 64) / 64) * 255); return `rgb(${g},${g},${g})`; };

function* chNext() {
  chLooks++;
  yield;
}

// even coverage of a shape with matched strokes from a jittered grid; chasing errors
// alone leaves pale veins, because a blurred comparison can't see them
function* chBlanket(o) {
  const tool = CH_TOOLS[o.tool], wanted = chWithinBlur(o.target ?? chT, o.squint * CH_U / G), way = chWays[o.dir ?? "form"];
  const anywhere = new Float32Array(GW * GH).fill(1);
  const seeds = [], gap = o.spacing * CH_U;
  for (let y = 0; y < H; y += gap) for (let x = 0; x < W; x += gap) {
    const sx = x + random(gap), sy = y + random(gap);
    if (o.where(sx, sy)) seeds.push([sx, sy, random()]);
  }
  seeds.sort((a, b) => a[2] - b[2]);
  while (seeds.length) {
    const strokes = seeds.splice(0, 320).map(([x, y]) => {
      const value = chGrid(wanted, x, y);
      const stays = (px, py) => o.where(px, py) && Math.abs(chGrid(wanted, px, py) - value) < o.range;
      const length = random(o.length[0], o.length[1]) * CH_U;
      const pts = chTrace(x, y, length, Math.max(5 * CH_U, length / 4), way, anywhere, 0, 1, stays);
      if (pts.length < 2) pts.push([x + 1, y + 1, 0.8]);
      return { tool, points: pts, weight: o.weight, colour: chGrey(value) };
    });
    strokes.sort((a, b) => (a.colour < b.colour ? -1 : 1));   // fewer composites
    chCommit(strokes);
    yield* chNext();
  }
}

// rubs a passage again and again until its value has arrived, as near as the eye can tell
function* chSettle(o, rounds) {
  const wanted = chWithinBlur(o.target ?? chT, 3);
  for (let round = 0; round < rounds; round++) {
    yield* chBlanket(o);
    const seen = chWithinBlur(chLook(), 3);
    let off = 0, n = 0;
    for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) if (o.where(x, y)) { off += Math.abs(chGrid(seen, x, y) - chGrid(wanted, x, y)); n++; }
    if (n && off / n < 0.02) break;
  }
}

// one look-and-correct pass: marks land only where the drawing disagrees with the target
function* chWork(o) {
  const tool = CH_TOOLS[o.tool], radius = o.squint * CH_U / G;
  const wanted = chWithinBlur(o.target ?? chT, radius), sign = tool.lifts ? -1 : 1, way = chWays[o.dir ?? "form"], tol = o.tol ?? 0.02;
  for (let look = 0; look < o.looks; look++) {
    const seen = chWithinBlur(chLook(), radius);
    const need = new Float32Array(GW * GH);
    for (let i = 0; i < need.length; i++) need[i] = o.matched ? Math.abs(seen[i] - wanted[i]) : sign * (seen[i] - wanted[i]);
    const strokes = [];
    let tries = 0;
    while (strokes.length < o.marks && tries < o.marks * 400) {
      tries++;
      const x = random(W), y = random(H), n = chGrid(need, x, y);
      if (n < tol || random() > n * (o.eager ?? 5)) continue;
      if (o.where && !o.where(x, y)) continue;
      const length = random(o.length[0], o.length[1]) * CH_U;
      const pressure = (o.pressure ?? 1) * (0.8 + Math.min(0.5, n * 1.5));
      const value = o.matched ? chGrid(wanted, x, y) : 0;
      // a matched stroke stays on its own value and doesn't cross a change of tone
      const stays = o.matched ? (px, py) => (!o.where || o.where(px, py)) && Math.abs(chGrid(wanted, px, py) - value) < (o.range ?? 0.1) : o.where;
      const pts = chTrace(x, y, length, (o.step ?? Math.max(5, o.length[1] / 5)) * CH_U, way, need, tol, pressure, stays, o.commitment);
      if (pts.length < 2) continue;
      strokes.push({ tool, points: pts, weight: o.weight ?? 1, curve: o.curve, colour: o.matched ? chGrey(value) : o.colour });
      chCredit(need, pts, (o.creditRadius ?? tool.radius) * (o.weight ?? 1) * CH_U, o.gives ?? tool.gives);
    }
    if (!strokes.length) break;
    if (o.matched) strokes.sort((a, b) => (a.colour < b.colour ? -1 : 1));
    chCommit(strokes);
    yield* chNext();
  }
}

// ---------------- the study: what the drawing should say

function chStudy() {
  const N = GW * GH, O = SUBJECT.charcoal || {}, masses = WCM.masses, back = WCM.backHard;
  chKinds = [null, ...masses.map((m) => m.kind)];
  const skin = masses.findIndex((m) => m.kind === "skin") + 1;

  // one label per material; a feature's dark cells belong to the skin around them
  const region = new Uint8Array(N).fill(255);
  for (let i = 0; i < N; i++) if (back[i]) region[i] = 0;
  masses.forEach((m, k) => { for (const i of m.cells) region[i] = k + 1; });
  const focal = new Uint8Array(N);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (inFocal(x * G, y * G)) focal[y * GW + x] = 1;
  if (skin) for (let i = 0; i < N; i++) if (focal[i] && !back[i]) region[i] = skin;
  // cells no mass claimed take a neighbour's label
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < N; i++) {
      if (region[i] !== 255) continue;
      const x = i % GW;
      const near = [x > 0 ? region[i - 1] : 255, x < GW - 1 ? region[i + 1] : 255, i >= GW ? region[i - GW] : 255, i < N - GW ? region[i + GW] : 255].find((v) => v !== 255 && v !== 0);
      if (near !== undefined) { region[i] = near; changed = true; }
    }
    if (!changed) for (let i = 0; i < N; i++) if (region[i] === 255) region[i] = 0;
  }
  // freckles become islands of "hair" that collect specks: take the commonest label around
  for (let round = 0; round < 2; round++) {
    const was = region.slice();
    const count = new Uint16Array(masses.length + 1);
    for (let y = 2; y < GH - 2; y++) for (let x = 2; x < GW - 2; x++) {
      const i = y * GW + x;
      if (!was[i] || focal[i]) continue;
      count.fill(0);
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) count[was[i + a * GW + b]]++;
      let best = was[i];
      for (let k = 1; k < count.length; k++) if (count[k] > count[best]) best = k;
      region[i] = best;
    }
  }

  // a margin of bare paper, its own label so that it never reads as an error in the
  // ground beside it (that error is what rains stick marks along a rim)
  chMargin = masses.length + 1;
  chEdge = new Float32Array(N);
  const dark = darkBackdrop();
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const X = x * G, Y = y * G;
    const edge = Math.min(X, W - X, Y, H - Y) + (noise(X * 0.009, Y * 0.009) - 0.5) * 80 * CH_U + (noise(X * 0.05 + 5, Y * 0.05) - 0.5) * 26 * CH_U;
    chEdge[y * GW + x] = edge;
    if (edge < 34 * CH_U && (dark || region[y * GW + x] === 0)) region[y * GW + x] = chMargin;
  }
  chRegion = region;

  // where the time goes
  chFocus = new Float32Array(N);
  const [fx, fy, fsx, fsy] = SUBJECT.attention.face;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const X = x * G, Y = y * G;
    let f = 0.42 * Math.exp(-(((X / S - fx) / (fsx * 1.1)) ** 2 + ((Y / S - fy) / (fsy * 1.1)) ** 2));
    for (const [cx, cy, rx, ry] of FOCAL) f = Math.max(f, Math.exp(-(((X - cx) / (rx * 1.15)) ** 2 + ((Y - cy) / (ry * 1.15)) ** 2)));
    chFocus[y * GW + x] = f;
  }
  const fine = structureTensor(lum(ref.mid), 2);
  chFineFlow = new Float32Array(N);
  for (let i = 0; i < N; i++) chFineFlow[i] = 0.5 * Math.atan2(2 * fine[1][i], fine[0][i] - fine[2][i]) + Math.PI / 2;

  // The value study is a decision, not the photo in grey. Flushed skin is a light form
  // that happens to be coloured, so skin is valued with extra weight on red; plain
  // luminance makes sockets and lips look bruised. Values aren't stretched to fit, so
  // darker skin stays dark. Features keep their edges, where the rest loses its texture.
  const warm = (c) => (0.56 * c[0] + 0.36 * c[1] + 0.08 * c[2]) / 255;
  const lumOf = (c) => wcLumOf(c) / 255;
  const skinHard = skin ? masses[skin - 1].hard : new Float32Array(N);
  const warmMap = new Float32Array(N), warmSharp = new Float32Array(N);
  for (let i = 0; i < N; i++) { warmMap[i] = warm(at(WCM.colour, i)); warmSharp[i] = warm(at(ref.mid, i)); }
  const broad = wcNormBlur(warmMap.map((v) => v * 255), skinHard, 11).map((v) => v / 255);
  const litWarm = skin ? masses[skin - 1].cells.map((i) => warmMap[i]).sort((a, b) => a - b) : [0.8];
  const span = Math.max(0.76, litWarm[Math.floor(litWarm.length * 0.97)] - 0.06);
  const skinA = skin ? masses[skin - 1].cells.filter((_, k) => k % 3 === 0).map((i) => wcLab(at(WCM.colour, i))[1]).sort((a, b) => a - b) : [0];
  const medA = skinA[skinA.length >> 1];
  const halo = SUBJECT.backdrop.shade;
  // the same curve for the fine view of the features, which has its own local contrast
  chSkinValue = (w, wide, l, a) => {
    const t = Math.pow(constrain((w + 0.6 * constrain(w - wide, -0.1, 0.1) - 0.06) / span, 0, 1), 1.1);
    return Math.min(t, t + (Math.pow(constrain(l / 0.82, 0, 1), 1.1) - t) * 0.55 * chSmooth(9, 22, a - medA));
  };

  const finishAt = Float32Array.from({ length: N }, (_, i) => finish((i % GW) * G, ((i / GW) | 0) * G));
  const photo = SUBJECT.watercolour?.textureBlur === undefined;
  chT = new Float32Array(N);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, X = x * G, Y = y * G, kind = chKinds[region[i]];
    const c = at(WCM.colour, i), sharp = photo ? 1 : chSmooth(0.45, 0.85, chFocus[i]), mass = masses[region[i] - 1];
    const l = lumOf(c) * (1 - sharp) + lumOf(at(ref.mid, i)) * sharp;
    let t;
    if (region[i] === chMargin) t = 1;
    else if (region[i] === 0) {
      if (dark) t = constrain(0.08 + l * 0.6 + 0.1 * (noise(X * 0.004, Y * 0.004) - 0.5), 0.07, 0.3);
      else {
        // a pale wall: only a breath of tone behind the head, so the lit edges read
        const g = Math.exp(-(((X / S - halo[0]) / (halo[2] * 1.05)) ** 2 + ((Y / S - halo[1]) / (halo[3] * 1.05)) ** 2));
        t = 1 - (O.halo ?? 0.13) * g * (0.6 + 0.8 * noise(X * 0.003, Y * 0.003 + 4));
      }
    } else if (kind === "skin") {
      const near = photo ? 1 : chSmooth(0.22, 0.6, chFocus[i]), w = warmMap[i] * (1 - near) + warmSharp[i] * near;
      t = Math.pow(constrain((w + 0.3 * (w - broad[i]) - 0.06) / span, 0, 1), 1.1);
      // red reads pale in grey, so the lips keep the darker weight of plain luminance
      if (focal[i]) t = Math.min(t, t + (Math.pow(constrain(l / 0.82, 0, 1), 1.1) - t) * 0.55 * chSmooth(9, 22, wcLab(c)[1] - medA));
    } // long shapes keep their folds and locks: their value is already smeared along the flow
    else if (kind === "hair") t = Math.min(O.hairCap ?? 0.62, Math.pow(constrain(((photo ? 0.25 : 0.45) * mass.value[i] / 255 + (photo ? 0.75 : 0.55) * lumOf(at(ref.mid, i)) - 0.02) / 0.7, 0, 1), 0.95));
    else if (kind === "crisp") t = Math.min(0.94, Math.pow(constrain((0.45 * mass.value[i] / 255 + 0.55 * lumOf(at(ref.mid, i)) - 0.03) / 0.82, 0, 1), 1.15));
    else t = 0.16 + 0.56 * chSmooth(0.08, 0.8, l);
    // the figure runs out towards the bottom of the sheet
    if (region[i] !== chMargin && region[i] !== 0) t += (1 - t) * chSmooth(0.6, 0, finishAt[i]);
    else if (region[i] === 0 && dark) t += (1 - t) * chSmooth(0.5, 0, finishAt[i]) * 0.9;
    chT[i] = t;
  }
}

// a height map equalised to a flat histogram: comparing pigment with it covers exactly
// the fraction of paper the pigment asks for, so the tooth breaks up the mark without
// changing the value seen from a distance
function chPaper() {
  let s = ((SUBJECT.seed ?? 17) * 7919) % 2147483647 || 1;
  const d = pixelDensity(), w = W * d, h = H * d, n = w * h;
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = (s = (s * 16807) % 2147483647) / 2147483647;
  const soft = wcBoxBlur(white, w, h, 1), wide = wcBoxBlur(white, w, h, 3);
  const fine = soft.map((v, i) => 0.45 * white[i] + 0.55 * v);
  const height = new Float32Array(n);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < n; i++) {
    // fine pits and a faint horizontal laid line, as on Ingres charcoal paper
    const v = fine[i] - wide[i] + 0.006 * Math.sin(((i / w) | 0) * 0.45);
    height[i] = v;
    if (v < low) low = v;
    if (v > high) high = v;
  }
  const BINS = 4096, hist = new Uint32Array(BINS), bin = (v) => Math.min(BINS - 1, ((v - low) / (high - low)) * BINS | 0);
  for (let i = 0; i < n; i++) hist[bin(height[i])]++;
  const cdf = new Float32Array(BINS);
  for (let b = 0, sum = 0; b < BINS; b++) { sum += hist[b]; cdf[b] = sum / n; }
  const image = createImage(w, h);
  image.pixelDensity(1);
  image.loadPixels();
  for (let i = 0; i < n; i++) {
    image.pixels[4 * i] = cdf[bin(height[i])] * 255;
    image.pixels[4 * i + 1] = 128 + (fine[i] - wide[i]) * 500;
    image.pixels[4 * i + 3] = 255;
  }
  image.updatePixels();
  return image;
}

const CH_VERT = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aTexCoord;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
out vec2 vUV;
void main() {
  vUV = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}`;

const CH_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSmudge;
uniform sampler2D uStick;
uniform sampler2D uTooth;
uniform vec3 uPaper;
uniform vec3 uCharcoal;
float lum(vec3 c) { return dot(c, vec3(1.0 / 3.0)); }
void main() {
  vec4 tooth = texture(uTooth, vUV);
  float height = tooth.r;
  float rubbed = lum(texture(uSmudge, vUV).rgb);
  float pigment = 1.0 - lum(texture(uStick, vUV).rgb);
  // stick pigment settles on the hills first; the mix is dust between the grains
  float caught = smoothstep(height - 0.17, height + 0.17, pigment) * smoothstep(0.02, 0.14, pigment);
  float darkness = mix(pigment, caught, 0.5);
  vec3 paper = uPaper * (0.992 + 0.016 * tooth.g);
  // rubbed pigment sits a little deeper in the valleys, or stumping looks airbrushed
  float rubbedIn = (1.0 - rubbed) * mix(1.2, 0.8, height);
  vec3 sheet = mix(paper, uCharcoal, clamp(rubbedIn, 0.0, 1.0));
  outColor = vec4(mix(sheet, uCharcoal, darkness * 0.97), 1.0);
}`;

function chSetup() {
  chTools();
  chStudy();
  chTooth = chPaper();
  chShader = createShader(CH_VERT, STYLE === "ink" ? IN_FRAG : STYLE === "pastel" ? PC_FRAG : CH_FRAG);
  const d = pixelDensity(), o = { width: W, height: H, density: d, antialias: false, depth: false };
  chSmudge = createFramebuffer(o);
  chStick = createFramebuffer(o);
  for (const layer of [chSmudge, chStick]) { layer.begin(); background(255); layer.end(); }
}

function chShow() {
  const c = STYLES[STYLE].paper();
  shader(chShader);
  chShader.setUniform("uSmudge", chSmudge);
  chShader.setUniform("uStick", chStick);
  chShader.setUniform("uTooth", chTooth);
  chShader.setUniform("uPaper", [red(c) / 255, green(c) / 255, blue(c) / 255]);
  chShader.setUniform("uCharcoal", CH_INK);
  noStroke();
  plane(W, H);
  resetShader();
}

// the same looks land in the same order however they are split into frames, so a
// recording ends on exactly the drawing a normal run makes
const CH_LOOKS_PER_FRAME = 3;
function chFrame() {
  const started = performance.now();
  let step = { done: false }, looks = 0;
  while (!step.done && (RECORD ? looks < CH_LOOKS_PER_FRAME : performance.now() - started < 30)) { step = steps.next(); looks++; }
  chShow();
  if (step.done) {
    window.__ch = STYLE === "pastel" ? pcReport() : chReport();
    painted();
  }
}

// how far each mass is from the study, in levels of 255: lighterBy negative is too dark
function chReport() {
  const seen = chWithinBlur(chLook(), 2), target = chWithinBlur(chT, 2);
  const report = { looks: chLooks, marks: chMarks };
  const row = (name, test) => {
    let n = 0, sum = 0, sq = 0;
    for (let i = 0; i < seen.length; i++) if (test(i)) { const e = (seen[i] - target[i]) * 255; sum += e; sq += e * e; n++; }
    if (n) report[name] = { lighterBy: +(sum / n).toFixed(1), rms: +Math.sqrt(sq / n).toFixed(1) };
  };
  row("ground", (i) => chRegion[i] === 0);
  WCM.masses.forEach((m, k) => row(m.name, (i) => chRegion[i] === k + 1));
  return report;
}

// ---------------- the session

function* chBlockIn() {
  const tool = { ...CH_TOOLS.vine, layer: "smudge" }, wob = 4 * CH_U;
  const lines = [...Object.values(SUBJECT.sketch || {}), ...(SUBJECT.construction || []).map(([a, b, c, d]) => [[a, b], [c, d]])];
  for (const line of lines) {
    const strokes = [];
    for (let again = 0; again < 2; again++) {
      strokes.push({ tool, colour: "#77736f", weight: 0.42, curve: 0.7, points: sc(line).map(([x, y]) => [x + random(-wob, wob), y + random(-wob, wob), random(0.5, 0.95)]) });
    }
    if (line.length > 1) chCommit(strokes);
    yield* chNext();
  }
}

// long side-of-the-stick strokes over the whole ground, even and all with the wrist:
// the grain of the sheet. Their free ends, not a rubbed fade, make the edge of the ground.
function* chScrub(target, weight, spacing, length) {
  const tool = CH_TOOLS.vineSide, inGround = (x, y) => WCM.backHard[wcCell(x, y)] === 1 && chGrid(chEdge, x, y) > 22 * CH_U, gap = spacing * CH_U;
  const seeds = [];
  for (let y = 0; y < H; y += gap) for (let x = 0; x < W; x += gap) {
    const sx = x + random(gap), sy = y + random(gap);
    if (chGrid(chRegion, sx, sy) === 0 && chGrid(chT, sx, sy) < 0.6) seeds.push([sx, sy, random()]);
  }
  seeds.sort((a, b) => a[2] - b[2]);
  const anywhere = new Float32Array(GW * GH).fill(1);
  while (seeds.length) {
    const strokes = seeds.splice(0, 60).map(([x, y]) => {
      const len = random(length[0], length[1]) * CH_U;
      return { tool, weight: weight * random(0.8, 1.1), colour: target, points: chTrace(x, y, len, 18 * CH_U, chWays.wrist, anywhere, 0, random(0.65, 1), inGround) };
    }).filter((s) => s.points.length > 1);
    chCommit(strokes);
    yield* chNext();
  }
}

function chPencil(tool, weight, line, restated = 1, wobble = 0.5, colour) {
  const out = [], w = wobble * CH_U;
  for (let k = 0; k < restated; k++) {
    out.push({ tool: CH_TOOLS[tool], weight, colour, curve: 0.6, points: line.map(([x, y, p = 1]) => [x + random(-w, w), y + random(-w, w), (0.55 + p * 0.6) * random(0.92, 1.05)]) });
  }
  return out;
}

// Marks the size of the features themselves, on a grid as fine as the layers: one view of
// the photo per focal ellipse, read against the sheet, darks in graphite and lights lifted.
function* chCloseLook(o = {}) {
  wcFineGrid();
  const F = WCM.fine, O = SUBJECT.watercolour || {}, blur = O.featureBlur ?? 2;
  const views = FOCAL.map(([cx, cy, rx, ry]) => {
    const x0 = Math.max(0, Math.floor((cx - rx * 1.1) * 2)), x1 = Math.min(F.w - 1, Math.ceil((cx + rx * 1.1) * 2));
    const y0 = Math.max(0, Math.floor((cy - ry * 1.1) * 2)), y1 = Math.min(F.h - 1, Math.ceil((cy + ry * 1.1) * 2));
    const w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;
    const rgb = [0, 1, 2].map((k) => {
      const c = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = F.data[((y + y0) * F.w + x + x0) * 4 + k];
      return wcBoxBlur(c, w, h, blur);
    });
    const warm = new Float32Array(n), L = new Float32Array(n);
    for (let i = 0; i < n; i++) { warm[i] = (0.56 * rgb[0][i] + 0.36 * rgb[1][i] + 0.08 * rgb[2][i]) / 255; L[i] = wcLumOf([rgb[0][i], rgb[1][i], rgb[2][i]]) / 255; }
    const wide = wcBoxBlur(warm, w, h, 12);
    const T = new Float32Array(n), fade = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, X = (x + x0) / 2, Y = (y + y0) / 2, label = chGrid(chRegion, X, Y);
      T[i] = chSkinValue(warm[i], wide[i], L[i], wcLab([rgb[0][i], rgb[1][i], rgb[2][i]])[1]);
      fade[i] = label === 0 || label === chMargin ? 0 : 1 - chSmooth(0.7, 1, Math.hypot((X - cx) / rx, (Y - cy) / ry));
    }
    // along the shape, from the view's own gradients
    const gx = new Float32Array(n), gy = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = L[i + 1] - L[i - 1]; gy[i] = L[i + w] - L[i - w]; }
    const a = wcBoxBlur(gx.map((v) => v * v), w, h, 3), b = wcBoxBlur(gy.map((v) => v * v), w, h, 3), c = wcBoxBlur(gx.map((v, i) => v * gy[i]), w, h, 3);
    const along = a.map((v, i) => 0.5 * Math.atan2(2 * c[i], v - b[i]) + Math.PI / 2);
    return { x0, y0, w, h, n, T, fade, along };
  });
  for (let round = 0; round < 9; round++) {
    chSmudge.loadPixels();
    chStick.loadPixels();
    const A = chSmudge.pixels, B = chStick.pixels;
    for (const v of views) {
      const seen = new Float32Array(v.n);
      for (let y = 0; y < v.h; y++) for (let x = 0; x < v.w; x++) {
        const p = ((y + v.y0) * F.w + x + v.x0) * 4;
        seen[y * v.w + x] = ((A[p] + A[p + 1] + A[p + 2]) / 765) * ((B[p] + B[p + 1] + B[p + 2]) / 765);
      }
      const soft = wcBoxBlur(seen, v.w, v.h, blur), strokes = [];
      const needs = [soft.map((q, i) => (q - v.T[i]) * v.fade[i]), soft.map((q, i) => (v.T[i] - q) * v.fade[i])];
      needs.forEach((need, lifting) => {
        if (lifting && o.ink) return;
        const tol = lifting ? 0.07 : 0.03, cap = Math.round(v.n / (lifting ? 170 : 32));
        for (let tries = 0, made = 0; tries < cap * 60 && made < cap; tries++) {
          const sx = Math.floor(random(v.w)), sy = Math.floor(random(v.h)), n0 = need[sy * v.w + sx];
          if (n0 < tol || random() > n0 * 6) continue;
          const pts = [[(sx + v.x0) / 2, (sy + v.y0) / 2, 0.9]], len = random(3, 10) * (lifting ? 0.6 : 1);
          let x = sx, y = sy, ang = v.along[sy * v.w + sx] + (random() < 0.5 ? Math.PI : 0);
          for (let went = 0; went < len; went += 1.2) {
            x += Math.cos(ang) * 2.4; y += Math.sin(ang) * 2.4;
            if (x < 1 || y < 1 || x >= v.w - 1 || y >= v.h - 1) break;
            const i = Math.floor(y) * v.w + Math.floor(x);
            if (need[i] < tol * 0.6) break;
            let next = v.along[i];
            if (Math.cos(next - ang) < 0) next += Math.PI;
            ang += Math.atan2(Math.sin(next - ang), Math.cos(next - ang)) * 0.5;
            pts.push([(x + v.x0) / 2, (y + v.y0) / 2, 0.8 + Math.min(0.5, need[i] * 1.5)]);
          }
          if (pts.length < 2) continue;
          const strong = n0 > 0.16, gives = lifting ? 0.14 : strong ? 0.13 : 0.08;
          if (o.ink) strokes.push({ tool: CH_TOOLS.penFine, weight: strong ? 1.05 : 0.8, points: pts });
          else strokes.push(lifting ? { tool: CH_TOOLS.puttyPoint, weight: 0.5, points: pts } : { tool: CH_TOOLS[strong ? "graphite4B" : "graphiteHB"], weight: strong ? 1.1 : 1.2, points: pts });
          for (const [px, py] of pts) {
            const gx = Math.round(px * 2 - v.x0), gy = Math.round(py * 2 - v.y0);
            for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
              const i = (gy + b) * v.w + gx + a;
              if (gx + a >= 0 && gx + a < v.w && gy + b >= 0 && gy + b < v.h) need[i] -= gives * 0.5;
            }
          }
          made++;
        }
      });
      if (strokes.length) chCommit(strokes);
    }
    yield* chNext();
  }
}

// the features: tone first, then what can be read from the sitter's own shapes, then
// the few measured lines. A line on untoned skin looks traced on.
function* chFeatures() {
  const A = SUBJECT.accents || {}, focus = (level) => (x, y) => chGrid(chFocus, x, y) > level;
  yield* chSettle({ tool: "rubFine", squint: 3, spacing: 4, length: [6, 14], range: 0.1, dir: "flow", weight: 0.12, where: focus(0.5) }, 4);
  yield* chWork({ tool: "rubFine", matched: true, range: 0.1, squint: 3, looks: 16, marks: 90, length: [8, 24], step: 4, weight: 0.11, dir: "flow", where: focus(0.45), tol: 0.02, creditRadius: 4, gives: 0.04 });
  const eyes = Object.entries(SUBJECT.sketch || {}).filter(([k]) => /^eye/.test(k)).map(([, p]) => sc(p));
  const inEye = (x, y) => eyes.some((p) => wcInPoly(p, x, y));
  const strokes = [];
  // the few measured lines go in first and quietly: the close look below corrects them
  for (const p of A.lashes || []) {
    strokes.push(...chPencil("stump", 0.13, sc(p), 2, 0.4, "#4e4b48"), ...chPencil("graphiteHB", 1, sc(p), 1, 0.3));
  }
  for (const p of A.nostrils || []) strokes.push(...chPencil("graphiteHB", 1, sc(p), 1, 0.3));
  // the parting carries the mouth; its ends stay lost
  for (const p of A.mouth || []) strokes.push(...chPencil("stump", 0.13, sc(p), 2, 0.3, "#4e4b48"), ...chPencil("graphiteHB", 1, sc(p), 1, 0.3));
  for (const { path } of A.lines || []) strokes.push(...chPencil("graphiteHB", 0.8, sc(path), 1, 0.5));
  while (strokes.length) { chCommit(strokes.splice(0, 24)); yield* chNext(); }

  yield* chCloseLook();

  // pupils: tight circling until black, cut by the lid
  for (const [px, py, r] of A.pupils || []) {
    const [cx, cy, R] = [px * S, py * S, r * S];
    const rings = chPencil("rubFine", 0.07, [[cx - R * 0.45, cy], [cx, cy + R * 0.1], [cx + R * 0.45, cy]], 4, 0.1, "#161516");
    for (let k = 0; k < 26; k++) {
      const a = random(Math.PI * 2), q = random(0.15, 0.95) * R;
      const circle = [0, 1.1, 2.2].map((d) => [cx + Math.cos(a + d) * q, cy + Math.sin(a + d) * q, 1]);
      if (!eyes.length || circle.every(([x, y]) => inEye(x, y))) rings.push(...chPencil("graphite4B", 1.1, circle, 1, 0));
    }
    chCommit(rings);
    yield* chNext();
  }
}

// the decisive lines, over the close look: lost at their ends, soft on one side
function chLastLines() {
  const A = SUBJECT.accents || {}, out = [];
  for (const p of [...(A.lashes || []), ...(A.mouth || [])]) {
    const heavy = p.filter((q) => (q[2] ?? 1) >= 0.4);
    if (heavy.length > 1) out.push(...chPencil("graphite4B", 1, sc(heavy), 1, 0.25), ...chPencil("stump", 0.1, sc(p), 1, 0.3, "#3c3a38"));
  }
  return out;
}

// the last lifts: catchlights and each subject's measured lights
function* chLights() {
  const A = SUBJECT.accents || {}, out = chLastLines();
  for (const [x, y, r] of A.catchlights || []) {
    const [cx, cy, R] = [x * S, y * S, Math.max(1, Math.min(r, 3.2) * S)];
    out.push(...chPencil("rub", 0.1, [[cx - R * 0.5, cy], [cx, cy + R * 0.1], [cx + R * 0.5, cy]], 3, 0.1, "#ffffff"), ...chPencil("puttyPoint", 0.7, [[cx - R * 0.5, cy], [cx, cy + R * 0.1], [cx + R * 0.5, cy]], 3, 0.1));
  }
  for (const { path, colour } of A.lights || []) {
    const c = color(colour), v = (0.299 * red(c) + 0.587 * green(c) + 0.114 * blue(c)) / 255;
    const [mx, my] = sc([path[path.length >> 1]])[0], here = chGrid(chT, mx, my);
    out.push(...chPencil("rubFine", 0.14, sc(path), 1, 0.5, chGrey(here + (v - here) * 0.5)));
  }
  while (out.length) { chCommit(out.splice(0, 20)); yield* chNext(); }
}

function* charcoal() {
  const T = chT, labels = WCM.masses.map((_, k) => k + 1), dark = darkBackdrop();
  const within = (...rs) => (x, y) => rs.includes(chGrid(chRegion, x, y));
  const ofKind = (...ks) => labels.filter((l) => ks.includes(chKinds[l]));
  const lighter = (d) => T.map((t) => Math.min(1, t + d));
  const floored = (v) => T.map((t) => Math.max(t, v));
  // a wide stump can't work up to an edge without dragging one value over another, so
  // it stays a tip's width inside; finer stumps close the gap afterwards
  const solid = (label, r) => {
    const m = blurChannel(Float32Array.from(chRegion, (v) => (v === label ? 1 : 0)), Math.max(1, Math.round(r * CH_U / G)));
    return (x, y) => chGrid(m, x, y) > 0.92;
  };
  const rim = (label, r) => {
    const m = blurChannel(Float32Array.from(chRegion, (v) => (v === label ? 1 : 0)), Math.max(1, Math.round(r * CH_U / G)));
    return (x, y) => chGrid(chRegion, x, y) === label && chGrid(m, x, y) < 0.97;
  };
  const figure = (x, y) => { const l = chGrid(chRegion, x, y); return l > 0 && l < chMargin; };
  const skins = ofKind("skin"), hairs = ofKind("hair"), crisps = ofKind("crisp"), softs = ofKind("soft");
  const scaled = (...ls) => constrain(ls.reduce((n, l) => n + WCM.masses[l - 1].cells.length, 0) / 22000, 1, 5);
  const toned = (where, v = 0.75) => (x, y) => where(x, y) && chGrid(T, x, y) < v;
  const inLights = (...rs) => (x, y) => rs.includes(chGrid(chRegion, x, y)) && chGrid(T, x, y) > 0.55;

  // 1. Tone the sheet, lights of the face left as bare paper
  yield* chWork({ tool: "rag", target: floored(0.72), squint: 22, looks: 6, marks: 50, length: [90, 240], dir: "wrist", tol: 0.012, where: within(...(dark ? [0] : []), ...hairs, ...softs) });

  // 2. Block in lightly, with the whole arm
  yield* chBlockIn();

  // 3. The ground. It cuts the silhouette out of the sheet, so it comes first
  if (dark) {
    const ground = lighter(0.07), inside = within(0);
    yield* chSettle({ tool: "rub", target: ground, squint: 28, spacing: 34, length: [90, 220], range: 0.4, dir: "wrist", weight: 1.3, where: solid(0, 30) }, 5);
    yield* chSettle({ tool: "rub", target: ground, squint: 14, spacing: 14, length: [40, 110], range: 0.4, dir: "wrist", weight: 0.5, where: solid(0, 12) }, 4);
    yield* chSettle({ tool: "rub", target: ground, squint: 6, spacing: 7, length: [16, 44], range: 0.4, dir: "wrist", weight: 0.21, where: rim(0, 26) }, 5);
    yield* chScrub("#2c2a29", 0.72, 34, [150, 340]);
    yield* chWork({ tool: "vineSide", squint: 12, looks: 8, marks: 60, length: [90, 240], weight: 0.6, dir: "wrist", where: inside, tol: 0.02, colour: "#2c2a29" });
    yield* chWork({ tool: "vine", squint: 10, looks: 6, marks: 90, length: [120, 320], step: 18, dir: "wrist", weight: 1.25, where: inside, tol: -1, eager: 99, commitment: 1, gives: 0 });
  } else {
    yield* chWork({ tool: "rag", squint: 26, looks: 7, marks: 26, length: [100, 260], dir: "wrist", tol: 0.008, where: within(0) });
    yield* chWork({ tool: "vine", squint: 18, looks: 3, marks: 30, length: [80, 220], step: 18, dir: "wrist", weight: 0.8, where: within(0), tol: 0.012, commitment: 0.9, gives: 0.05 });
  }

  // 4. The big masses, stopped short so that strokes have work left to do
  const massed = (d) => lighter(d);
  for (const l of [...hairs, ...crisps]) {
    const target = massed(chKinds[l] === "hair" ? 0.06 : 0.09), dir = "flow";
    yield* chSettle({ tool: "rub", target, squint: 20, spacing: 22, length: [40, 110], range: 0.18, dir, weight: 0.83, where: solid(l, 22) }, 4);
    yield* chSettle({ tool: "rub", target, squint: 10, spacing: 11, length: [24, 70], range: 0.14, dir, weight: 0.4, where: solid(l, 9) }, 3);
    yield* chSettle({ tool: "rub", target, squint: 5, spacing: 7, length: [14, 40], range: 0.14, dir, weight: 0.21, where: within(l) }, 3);
    yield* chSettle({ tool: "rub", target, squint: 2.5, spacing: 6, length: [12, 34], range: 0.2, dir, weight: 0.12, where: within(l) }, 2);
  }
  for (const l of softs) {
    const target = massed(0.05);
    yield* chSettle({ tool: "rub", target, squint: 24, spacing: 24, length: [50, 130], range: 0.25, weight: 0.92, where: solid(l, 22) }, 4);
    yield* chSettle({ tool: "rub", target, squint: 12, spacing: 12, length: [30, 80], range: 0.2, weight: 0.46, where: solid(l, 11) }, 3);
    yield* chSettle({ tool: "rub", target, squint: 5, spacing: 7, length: [14, 40], range: 0.14, weight: 0.21, where: within(l) }, 3);
  }

  // 5. The skin: stumped, coarse to fine. Shadows stop a little short for the hatching
  const skinTarget = T.map((t) => Math.min(1, t + 0.05 * chSmooth(0.85, 0.5, t)));
  for (const l of skins) {
    yield* chSettle({ tool: "rub", target: skinTarget, squint: 28, spacing: 24, length: [30, 70], range: 0.2, weight: 0.96, where: solid(l, 24) }, 4);
    yield* chSettle({ tool: "rub", target: skinTarget, squint: 16, spacing: 13, length: [16, 40], range: 0.12, weight: 0.52, where: solid(l, 12) }, 3);
    yield* chSettle({ tool: "rub", target: skinTarget, squint: 12, spacing: 10, length: [14, 34], range: 0.1, weight: 0.4, where: solid(l, 8) }, 3);
    yield* chSettle({ tool: "rub", target: skinTarget, squint: 8, spacing: 7, length: [12, 28], range: 0.12, weight: 0.23, where: within(l) }, 3);
    yield* chSettle({ tool: "rubFine", target: skinTarget, squint: 4, spacing: 4, length: [8, 20], range: 0.06, weight: 0.16, where: within(l) }, 4);
    yield* chWork({ tool: "rub", target: skinTarget, matched: true, range: 0.08, squint: 8, looks: 8, marks: 110, length: [12, 36], weight: 0.27, step: 6, where: within(l), tol: 0.028, creditRadius: 7, gives: 0.022 });
  }
  // a mean can say a region is settled while a small notch is far out
  yield* chWork({ tool: "rub", target: lighter(0.03), matched: true, range: 0.25, squint: 4, looks: 8, marks: 160, length: [10, 30], step: 5, weight: 0.2, where: figure, tol: 0.08, eager: 12, creditRadius: 5, gives: 0.06 });

  // the seams between masses, which every tip stayed inside of, are still bare paper
  const seam = blurChannel(Float32Array.from(chRegion, (v, i) => {
    const r = i % GW < GW - 1 ? chRegion[i + 1] : v, d = i < chRegion.length - GW ? chRegion[i + GW] : v;
    return v < chMargin && ((r !== v && r < chMargin) || (d !== v && d < chMargin)) ? 1 : 0;
  }), 2);
  const onSeam = (x, y) => chGrid(chRegion, x, y) < chMargin && chGrid(seam, x, y) > 0.03 && chGrid(T, x, y) < 0.97;
  yield* chSettle({ tool: "rub", target: lighter(0.02), squint: 3, spacing: 5, length: [10, 26], range: 0.3, dir: "flow", weight: 0.13, where: onSeam }, 3);

  // 6. Marks: these carry the value the rubs left, so they show as drawing
  if (hairs.length) yield* chWork({ tool: "vine", squint: 4, looks: 10, marks: 90 * scaled(...hairs), length: [60, 220], step: 14, dir: "flow", weight: 1.15, where: toned(within(...hairs)), tol: 0.025, commitment: 0.75 });
  if (crisps.length) yield* chWork({ tool: "vine", squint: 4, looks: 10, marks: 90 * scaled(...crisps), length: [60, 200], step: 14, dir: "flow", where: toned(within(...crisps)), tol: 0.025, commitment: 0.75 });
  if (softs.length) yield* chWork({ tool: "vineSide", squint: 6, looks: 9, marks: 50 * scaled(...softs), length: [70, 200], step: 14, dir: "form", weight: 0.36, where: toned(within(...softs)), tol: 0.015, commitment: 0.75, colour: "#3a3735" });
  // hatching with the wrist across the shadow side of the face, thinning out towards the features
  if (skins.length) yield* chWork({ tool: "graphite4B", squint: 6, looks: 7, marks: 90, length: [40, 110], step: 10, dir: "wrist", weight: 1.05, where: (x, y) => within(...skins)(x, y) && chGrid(chFocus, x, y) < 0.6 && chGrid(T, x, y) < 0.72, tol: 0.012, commitment: 0.8, gives: 0.03 });

  // 7. The darks, saved until now because they can't be undone
  const darkLabels = [...hairs, ...crisps];
  if (darkLabels.length) yield* chWork({ tool: "compressed", squint: 2.5, looks: 10, marks: 50 * scaled(...darkLabels), length: [50, 170], step: 14, weight: 0.72, dir: "flow", where: toned(within(...darkLabels), 0.6), tol: 0.04, commitment: 0.75, gives: 0.1 });

  // 8. Draw with the eraser: bring back what has gone too dark, then restate the edge of the ground
  for (const l of skins) yield* chWork({ tool: "rub", matched: true, range: 0.11, squint: 16, looks: 5, marks: 60, length: [20, 60], weight: 0.52, where: within(l), tol: 0.03, creditRadius: 14, gives: 0.016 });
  yield* chWork({ tool: "putty", squint: 5, looks: 7, marks: 30, length: [10, 40], dir: "flow", where: inLights(...labels), tol: 0.07, gives: 0.04, commitment: 0.1 });
  if (dark) yield* chSettle({ tool: "rub", target: lighter(0.04), squint: 4, spacing: 6, length: [12, 30], range: 0.4, dir: "wrist", weight: 0.15, where: rim(0, 12) }, 2);

  for (const l of skins) {
    yield* chSettle({ tool: "rubFine", target: T, squint: 3, spacing: 5, length: [8, 20], range: 0.1, weight: 0.12, where: rim(l, 8) }, 2);
    yield* chWork({ tool: "rubFine", matched: true, range: 0.14, squint: 3, looks: 5, marks: 90, length: [6, 18], step: 4, weight: 0.13, where: within(l), tol: 0.035, eager: 9, creditRadius: 5, gives: 0.05 });
  }

  // 9. The features
  yield* chFeatures();

  // 10. Folds and strands: dark then light, long strokes along the shape
  const longs = [...hairs, ...crisps];
  if (longs.length) {
    yield* chWork({ tool: "graphite4B", squint: 1.5, looks: 8, marks: 110 * scaled(...longs), length: [50, 190], step: 12, dir: "flow", where: toned(within(...longs)), tol: 0.04, weight: 1.15, commitment: 0.75 });
    yield* chWork({ tool: "puttyPoint", squint: 1.5, looks: 6, marks: 50, length: [24, 110], step: 10, dir: "flow", where: inLights(...longs), tol: 0.08, weight: 0.9, commitment: 0.1 });
    // hair's study is smeared along the flow, so no error asks for strands: they are drawn
    // anyway, dark in the shadows and lifted in the upper half of its values
    for (const l of hairs) {
      const m = WCM.masses[l - 1], vals = m.cells.filter((_, k) => k % 7 === 0).map((i) => T[i]).sort((a, b) => a - b);
      const mid = vals[Math.floor(vals.length * 0.55)], high = vals[Math.floor(vals.length * 0.9)];
      const free = { squint: 1.5, looks: 4, step: 10, dir: "flow", tol: -1, eager: 99, commitment: 1, gives: 0 };
      yield* chWork({ ...free, tool: "compressed", marks: 40 * scaled(l), length: [60, 200], weight: 0.5, where: (x, y) => chGrid(chRegion, x, y) === l && chGrid(T, x, y) < mid });
      yield* chWork({ ...free, tool: "puttyPoint", marks: 26 * scaled(l), length: [40, 150], weight: 0.55, where: (x, y) => chGrid(chRegion, x, y) === l && chGrid(T, x, y) > mid && chGrid(T, x, y) < Math.max(high, mid + 0.05) + 0.2 });
    }
    // sheen in dark hair is light against its surroundings, however dark it is itself
    if (hairs.length) yield* chWork({ tool: "puttyPoint", squint: 1.5, looks: 5, marks: 50 * scaled(...hairs), length: [30, 120], step: 10, dir: "flow", where: (x, y) => within(...hairs)(x, y) && chGrid(T, x, y) > 0.24 && chGrid(T, x, y) < 0.8, tol: 0.05, weight: 0.8, commitment: 0.1 });
  }
  for (const f of SUBJECT.hair?.flyaways || []) chCommit(chPencil("graphiteHB", 0.8, sc(f), 1, 0.4));
  yield* chLights();
  yield* chNext();
}


// ============================================================= watercolour style
//
// Painted the way a watercolourist builds a portrait, light to dark:
//   1. a light pencil drawing on white paper
//   2. a first pale wash over every shape of colour, leaving the paper white
//      for the highlights
//   3. a loose wash of the backdrop, run into the hair while it is wet
//   4. glazes of the shadow shapes, each smaller and darker than the last,
//      soft-edged away from the face and crisper near the features
//   5. the hair's darks dropped in, then a few strokes along its flow
//   6. the features in small, deliberate shapes, then the last accents
// Nothing is lightened afterwards: the paper is the only white.

const WC_PAPER = [249, 246, 240];

const at = (level, i) => [level[0][i], level[1][i], level[2][i]];
// optional outline of the figure (backdrop.figure, reference units): nothing
// inside it is backdrop, for a backdrop as dark as the deepest hair shadows
let figure = null;
function figureMask() {
  const poly = SUBJECT.backdrop.figure;
  if (!poly) return;
  const pts = poly.map(([x, y]) => [x * S / G, y * S / G]);
  figure = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    // even-odd crossings along the row
    const xs = [];
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [x1, y1] = pts[j], [x2, y2] = pts[k];
      if ((y1 > gy) !== (y2 > gy)) xs.push(x1 + (gy - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let gx = Math.max(0, Math.ceil(xs[k])); gx <= Math.min(GW - 1, xs[k + 1]); gx++) figure[gy * GW + gx] = 1;
  }
}
const inFigure = (x, y) => figure !== null && figure[Math.round(constrain(y / G, 0, GH - 1)) * GW + Math.round(constrain(x / G, 0, GW - 1))] === 1;
const bgAt = (i) => !(figure && figure[i]) && (isBackground(at(ref.soft, i)) || isBackground(at(ref.sharp, i)));
// areas the subject marks as hair even where it is too light for hair.maxLum, such
// as a wispy fringe with the forehead showing through (SUBJECT.hair.areas)
const inHairArea = (x, y) => (SUBJECT.hair?.areas || []).some((poly) => {
  let inside = false;
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
    const [x1, y1] = [poly[j][0] * S, poly[j][1] * S], [x2, y2] = [poly[k][0] * S, poly[k][1] * S];
    if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) / (y2 - y1) * (x2 - x1)) inside = !inside;
  }
  return inside;
});
const darkBackdrop = () => (SUBJECT.backdrop.detect?.maxBrightness ?? 256) < 128;

// 4-connected pieces of a set of cells on an mw-wide grid
function connected(cells, mw) {
  const inSet = new Set(cells), seen = new Set(), out = [];
  for (const s of cells) {
    if (seen.has(s)) continue;
    const comp = [], stack = [s];
    seen.add(s);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const x = c % mw;
      for (const t of [x + 1 < mw ? c + 1 : -1, x > 0 ? c - 1 : -1, c + mw, c - mw]) {
        if (t >= 0 && inSet.has(t) && !seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    out.push(comp);
  }
  return out;
}

// ------------------------------------------------------------- watercolour
//
// Painted in named masses, the way a watercolourist plans a sheet: skin, hair,
// each cloth and the backdrop each get their own pigment and recipe, so colours
// stay clean. Pigments and value steps are read from the photo, so nothing is
// tuned to one skin tone. Each session ends a frame, which dries the paper;
// clean water laid just before a glaze lets its edge feather. Between sessions
// the painter looks: wcSee() reads the canvas back, and the last glazes and all
// of the features go only where the painting is still lighter than the photo.

let WCM = {};            // masses and shared fields, filled by wcLook()
let wcPhoto = null;      // the photo at full size, for the features
let wcSession = 0;
const WU = W / 1000;     // recipes are written for a sheet 1000 units wide
const wcStep = (a, b, v) => { const t = constrain((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wcMult = (...fields) => {
  const out = new Float32Array(GW * GH).fill(1);
  for (const f of fields) for (let i = 0; i < out.length; i++) out[i] *= f[i];
  return out;
};
const wcLumOf = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const wcCell = (x, y) => constrain(Math.round(y / G), 0, GH - 1) * GW + constrain(Math.round(x / G), 0, GW - 1);

function wcInPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function wcRaster(polys) {
  const out = new Float32Array(GW * GH);
  for (const poly of polys) {
    const xs = poly.map((p) => p[0] / G), ys = poly.map((p) => p[1] / G);
    const x1 = Math.min(GW - 1, Math.ceil(Math.max(...xs))), y1 = Math.min(GH - 1, Math.ceil(Math.max(...ys)));
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= y1; y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= x1; x++)
        if (wcInPoly(poly, x * G, y * G)) out[y * GW + x] = 1;
  }
  return out;
}

// the iso-contours of a field (marching squares), as loops in cell coordinates
function wcIsoLoops(f, w, h, iso) {
  const edge = (x, y, v) => 2 * (y * (w + 2) + x) + (v ? 1 : 0);
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1e6 : f[y * w + x]);
  const pos = new Map(), adj = new Map();
  const cross = (id, ax, ay, bx, by) => {
    if (!pos.has(id)) {
      const a = val(ax, ay), b = val(bx, by), t = (iso - a) / (b - a);
      pos.set(id, [ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    return id;
  };
  const link = (a, b) => {
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
  };
  const SEGS = { 1: ["LB"], 2: ["BR"], 3: ["LR"], 4: ["TR"], 5: ["TL", "BR"], 6: ["TB"], 7: ["TL"], 8: ["TL"], 9: ["TB"], 10: ["TR", "LB"], 11: ["TR"], 12: ["LR"], 13: ["BR"], 14: ["LB"] };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = (val(x, y) > iso ? 8 : 0) | (val(x + 1, y) > iso ? 4 : 0) | (val(x + 1, y + 1) > iso ? 2 : 0) | (val(x, y + 1) > iso ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const side = {
        T: () => cross(edge(x + 1, y + 1, false), x, y, x + 1, y),
        B: () => cross(edge(x + 1, y + 2, false), x, y + 1, x + 1, y + 1),
        L: () => cross(edge(x + 1, y + 1, true), x, y, x, y + 1),
        R: () => cross(edge(x + 2, y + 1, true), x + 1, y, x + 1, y + 1),
      };
      for (const s of SEGS[c]) link(side[s[0]](), side[s[1]]());
    }
  }
  const loops = [], seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start, prev = null;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pos.get(cur));
      const next = adj.get(cur).find((n) => n !== prev && !seen.has(n));
      prev = cur;
      cur = next;
    }
    if (loop.length > 4) loops.push(loop);
  }
  return loops;
}

const wcArea = (l) => { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

function wcSmooth(l, it) {
  for (let k = 0; k < it; k++) {
    l = l.map((p, i) => {
      const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
  }
  return l;
}

function wcResample(l, step) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < l.length; i++) {
    const p = l[i], q = l[(i + 1) % l.length];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    let t = carry;
    while (t < d) { out.push([p[0] + ((q[0] - p[0]) * t) / d, p[1] + ((q[1] - p[1]) * t) / d]); t += step; }
    carry = t - d;
  }
  return out.length >= 3 ? out : l;
}

// fills use non-zero winding, so a hole wound the other way and joined by a seam
// of short edges stays unpainted: the paper is reserved without cutting the wash
function wcBridge(outer, holes, step) {
  let ring = outer;
  for (const hole of holes) {
    let bi = 0, bj = 0, best = Infinity;
    for (let i = 0; i < ring.length; i++)
      for (let j = 0; j < hole.length; j++) {
        const d = (ring[i][0] - hole[j][0]) ** 2 + (ring[i][1] - hole[j][1]) ** 2;
        if (d < best) { best = d; bi = i; bj = j; }
      }
    const a = ring[bi], b = hole[bj], n = Math.ceil(Math.sqrt(best) / step);
    const seam = Array.from({ length: Math.max(0, n - 1) }, (_, k) => [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n]);
    ring = [...ring.slice(0, bi + 1), ...seam, ...hole.slice(bj), ...hole.slice(0, bj), b, ...seam.slice().reverse(), ...ring.slice(bi)];
  }
  return ring;
}

// a field on a w x h grid -> polygons in canvas units, largest first
function wcTraceOn(f, w, h, ox, oy, cell, { iso = 0.5, step = 10, minArea = 400, minHole = 500, max = 40, it = 2 } = {}) {
  const least = Math.min(minArea, minHole);
  const info = wcIsoLoops(f, w, h, iso)
    .map((l) => l.map(([x, y]) => [(x + ox) * cell, (y + oy) * cell]))
    .map((l) => ({ l, a: Math.abs(wcArea(l)) })).filter((o) => o.a >= least).sort((p, q) => q.a - p.a);
  info.forEach((o, i) => {
    let depth = 0;
    o.parent = null;
    for (let j = i - 1; j >= 0; j--) {
      if (wcInPoly(info[j].l, o.l[0][0], o.l[0][1])) { if (depth === 0) o.parent = info[j]; depth++; }
    }
    o.hole = depth % 2 === 1;
  });
  const out = [];
  for (const o of info) {
    if (o.hole || o.a < minArea) continue;
    const ring = wcResample(wcSmooth(o.l, it), step);
    if (wcArea(ring) < 0) ring.reverse();
    const holes = info.filter((h2) => h2.hole && h2.parent === o && h2.a >= minHole)
      .map((h2) => { const r = wcResample(wcSmooth(h2.l, it), step); if (wcArea(r) > 0) r.reverse(); return r; });
    out.push(wcBridge(ring, holes, step));
    if (out.length >= max) break;
  }
  return out;
}

// a field on the analysis grid -> polygons; sizes are in units of a 1000-wide sheet
function wcTrace(f, o = {}) {
  let x0 = GW, x1 = -1, y0 = GH, y1 = -1;
  const iso = o.iso ?? 0.5;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (f[y * GW + x] > iso) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return [];
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(GW - 1, x1 + 2); y1 = Math.min(GH - 1, y1 + 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, crop = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = f[(y + y0) * GW + x + x0];
  return wcTraceOn(crop, w, h, x0, y0, G, {
    ...o,
    step: Math.max(1.5, (o.step ?? 10) * WU),
    minArea: (o.minArea ?? 400) * WU * WU,
    minHole: (o.minHole ?? 500) * WU * WU,
  });
}

function wcBlob(cx, cy, rx, ry, n = 26, rough = 0.18, rot = 0) {
  const seed = random(1000), c = Math.cos(rot), s = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + rough * (noise(seed + Math.cos(a) * 1.3, seed + Math.sin(a) * 1.3) * 2 - 1) * 2;
    const dx = Math.cos(a) * rx * k, dy = Math.sin(a) * ry * k;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
}

// where the mask holds and the value map is darker than t
function wcDarker(mask, L, t, soft = 10, r = 1) {
  const out = new Float32Array(GW * GH);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] * constrain((t - L[i]) / soft + 0.5, 0, 1);
  return r ? blurChannel(out, r) : out;
}

// ---- the brush

function wcPaint(polys, col, opacity, { bleed = 0.1, tex = 0.5, rim = 0.35, scatter = false, split = 0.15 } = {}) {
  brush.noStroke();
  brush.fill(col, opacity);
  brush.fillTexture(tex, rim, scatter, split);
  // long polygons get torn up below this bleed
  for (const poly of polys) {
    brush.fillBleed(Math.max(bleed, poly.length / 3800), "out");
    brush.polygon(poly);
  }
  brush.noFill();
}

// clean water, just before the paint it carries: it is overwritten by later fills
function wcWet(shape, pad = 40) {
  const xs = shape.map((q) => q[0]), ys = shape.map((q) => q[1]);
  const p = pad * WU, x0 = Math.min(...xs) - p, x1 = Math.max(...xs) + p, y0 = Math.min(...ys) - p, y1 = Math.max(...ys) + p;
  wcPaint([wcResample([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 40 * WU)], color(243, 211, 172), 2, { bleed: 0.5, tex: 0, rim: 0 });
}

function wcStrokeLine(pts, name, col, weight, curve = 0.6) {
  brush.noFill();
  brush.set(name, col, weight);
  brush.spline(pts, curve);
  brush.noStroke();
}

function wcBrushes() {
  const round = (m) => { m.noStroke(); m.fill(0); m.circle(0, 0, 90); };
  brush.add("rigger", { type: "custom", weight: 2.6, scatter: 0.02, opacity: 110, spacing: 0.22, noise: 0.5, pressure: [0.55, 1.15, 0.12], tip: round, rotate: "none", markerTip: false });
  brush.add("round3", { type: "custom", weight: 4.5, scatter: 0.03, opacity: 95, spacing: 0.2, noise: 0.35, pressure: [0.4, 1.1, 0.25], tip: round, rotate: "none", markerTip: false });
  brush.add("dilute", { type: "custom", weight: 5, scatter: 0.05, opacity: 26, spacing: 0.25, noise: 0.5, pressure: [0.5, 1.1, 0.4], tip: round, rotate: "none", markerTip: false });
}

// the observed colour as a pigment: a little richer, since washes grey and thin
function wcPigment(rgb, rich = 1.2) {
  const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return rgb.map((v) => constrain(m + (v - m) * rich, 0, 255));
}
const wcColour = (rgb, rich = 1.2) => color(...wcPigment(rgb, rich));
const wcThin = (rgb, t) => rgb.map((v, k) => WC_PAPER[k] + (v - WC_PAPER[k]) * t);

// ---- looking at the sitter

const wcLab = ([R, G2, B]) => {
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const [r, g, b] = [f(R), f(G2), f(B)];
  const g3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = g3((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = g3(0.2126 * r + 0.7152 * g + 0.0722 * b), z = g3((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};

function wcKMeans(points, k, it = 14) {
  const d2 = (a, b) => a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0);
  const sample = points.filter((_, i) => i % 5 === 0);
  // farthest-first from the mean: no dependence on the random sequence
  const mean = sample[0].map((_, j) => sample.reduce((s, p) => s + p[j], 0) / sample.length);
  const centres = [];
  while (centres.length < k) {
    let best = null, bd = -1;
    for (const p of sample) {
      const d = centres.length ? Math.min(...centres.map((c) => d2(p, c))) : d2(p, mean);
      if (d > bd) { bd = d; best = p; }
    }
    centres.push([...best]);
  }
  const nearest = (p) => { let b = 0, bd = Infinity; centres.forEach((c, j) => { const d = d2(p, c); if (d < bd) { bd = d; b = j; } }); return b; };
  for (let t = 0; t < it; t++) {
    const sum = centres.map(() => new Array(centres[0].length + 1).fill(0));
    for (const p of sample) { const s = sum[nearest(p)]; p.forEach((v, j) => { s[j] += v; }); s[p.length]++; }
    sum.forEach((s, j) => { if (s[s.length - 1]) centres[j] = s.slice(0, -1).map((v) => v / s[s.length - 1]); });
  }
  return nearest;
}

// tones smeared along the flow, so masses read as locks or folds, not blobs
function wcAlongFlow(mask, L) {
  const out = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      if (mask[i] < 0.05) { out[i] = 255; continue; }
      let s = L[i], n = 1;
      for (const dir of [1, -1]) {
        let a = x, b = y;
        for (let k = 0; k < 11; k++) {
          const j = constrain(Math.round(b), 0, GH - 1) * GW + constrain(Math.round(a), 0, GW - 1);
          if (mask[j] < 0.3) break;
          a += Math.cos(WCM.flow[j]) * dir;
          b += Math.sin(WCM.flow[j]) * dir;
          s += L[constrain(Math.round(b), 0, GH - 1) * GW + constrain(Math.round(a), 0, GW - 1)];
          n++;
        }
      }
      out[i] = s / n;
    }
  }
  return out;
}

// a value map that ignores everything outside the mask, so hair and lashes
// never read as shadow on the skin
function wcNormBlur(v, w, r) {
  const a = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) a[i] = v[i] * w[i];
  const A = blurChannel(a, r), B = blurChannel(w, r);
  return A.map((p, i) => (B[i] > 0.02 ? p / B[i] : 255));
}

function wcLook() {
  const O = SUBJECT.watercolour || {};
  const N = GW * GH;
  const L = lum(blurRGB(ref.sharp, O.textureBlur ?? 2));
  WCM.lum = L;
  WCM.colour = blurRGB(ref.sharp, O.textureBlur ?? 2);
  const lab = Array.from({ length: N }, (_, i) => wcLab(at(WCM.colour, i)));

  // direction, and how far it can be trusted
  WCM.flow = new Float32Array(N);
  WCM.coh = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const [xx, xy, yy] = [flow[0][i], flow[1][i], flow[2][i]];
    WCM.flow[i] = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
    WCM.coh[i] = Math.hypot(xx - yy, 2 * xy) / (xx + yy + 1e-3);
  }

  // the backdrop: only what connects to the edge of the sheet, or highlights
  // and dark folds inside the figure are lost to it
  const back = new Uint8Array(N), stack = [];
  for (let x = 0; x < GW; x++) stack.push(x, (GH - 1) * GW + x);
  for (let y = 0; y < GH; y++) stack.push(y * GW, y * GW + GW - 1);
  while (stack.length) {
    const i = stack.pop();
    if (back[i] || !bgAt(i)) continue;
    back[i] = 1;
    const x = i % GW;
    if (x > 0) stack.push(i - 1);
    if (x < GW - 1) stack.push(i + 1);
    if (i >= GW) stack.push(i - GW);
    if (i < N - GW) stack.push(i + GW);
  }
  WCM.back = blurChannel(Float32Array.from(back), 1);
  WCM.backHard = back;
  const pix = [];
  for (let i = 0; i < N; i += 3) if (back[i]) pix.push(at(WCM.colour, i));
  WCM.backColour = pix.length ? [0, 1, 2].map((k) => pix.reduce((s, c) => s + c[k], 0) / pix.length) : [235, 232, 226];

  // ragged margins: nothing runs to the edge of the sheet in a straight line
  WCM.fade = new Float32Array(N);
  WCM.vignette = new Float32Array(N);
  const [hx, hy] = [SUBJECT.backdrop.shade[0] * S, SUBJECT.backdrop.shade[1] * S];
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const X = x * G, Y = y * G;
    WCM.fade[y * GW + x] = wcStep(0.25, 0.55, finish(X, Y));
    const d = Math.hypot((X - hx) / (W * 0.5), (Y - hy) / (H * 0.5));
    const n = noise(X * 0.005 + 9, Y * 0.005 + 3) + 0.5 * noise(X * 0.02, Y * 0.02 + 8);
    WCM.vignette[y * GW + x] = wcStep(0.1, 0.3, 1.32 - d + (n - 0.75) * 0.75);
  }

  // the reserved features: eye almonds, and the lips by colour
  const eyePolys = Object.entries(SUBJECT.sketch).filter(([k]) => /^eye/.test(k)).map(([, p]) => sc(p));
  const eyes = wcRaster(eyePolys), kept = wcRaster((O.reserve || []).map(sc));
  WCM.feat = eyes.map((v, i) => Math.max(v * 0.45, kept[i] * 0.95));

  // named regions first, in order; the rest of the figure is worked out by colour
  const labels = new Int16Array(N).fill(-1);
  const defs = [];
  for (const r of O.regions || []) {
    const raster = wcRaster([sc(r.poly)]);
    const members = [];
    for (let i = 0; i < N; i++) if (raster[i] && !back[i]) { labels[i] = -2; members.push(i); }
    if (r.split) {
      const near = wcKMeans(members.map((i) => [lab[i][1], lab[i][2]]), r.split);
      const parts = Array.from({ length: r.split }, () => []);
      for (const i of members) parts[near([lab[i][1], lab[i][2]])].push(i);
      parts.forEach((cells, k) => defs.push({ name: `${r.name}${k}`, kind: r.kind, cells }));
    } else defs.push({ name: r.name, kind: r.kind, cells: members });
  }
  // later regions take their cells from earlier ones
  const owner = new Int16Array(N).fill(-1);
  defs.forEach((d, k) => { for (const i of d.cells) owner[i] = k; });
  defs.forEach((d, k) => { d.cells = d.cells.filter((i) => owner[i] === k); });

  const free = (i) => labels[i] === -1 && !back[i];
  if (!defs.some((d) => d.kind === "skin")) {
    // skin: the colour of the middle of the face, wherever it connects or is large
    const [fx, fy, sx, sy] = SUBJECT.attention.face;
    const as = [], bs = [];
    for (let i = 0; i < N; i++) {
      const x = (i % GW) * G, y = ((i / GW) | 0) * G;
      if (back[i] || inFocal(x, y) || ((x / S - fx) / sx) ** 2 + ((y / S - fy) / sy) ** 2 > 0.3) continue;
      as.push(lab[i][1]); bs.push(lab[i][2]);
    }
    as.sort((a, b) => a - b); bs.sort((a, b) => a - b);
    const [ma, mb] = [as[as.length >> 1] ?? 15, bs[bs.length >> 1] ?? 20];
    const tol = O.skinTolerance ?? 16, maxLum = SUBJECT.hair?.maxLum ?? 105;
    const cand = [];
    for (let i = 0; i < N; i++) {
      const x = (i % GW) * G, y = ((i / GW) | 0) * G;
      if (free(i) && L[i] >= maxLum * 0.8 && !inHairArea(x, y) && (lab[i][1] - ma) ** 2 + (lab[i][2] - mb) ** 2 < tol * tol) cand.push(i);
    }
    const cells = connected(cand, GW).filter((c) => c.length > N * 0.004).flat();
    for (const i of cells) labels[i] = -2;
    defs.push({ name: "skin", kind: "skin", cells });
  }
  // hair: what is left of the darks
  const hairCells = [];
  for (let i = 0; i < N; i++) {
    const x = (i % GW) * G, y = ((i / GW) | 0) * G;
    if (free(i) && (L[i] < (SUBJECT.hair?.maxLum ?? 105) || inHairArea(x, y))) { hairCells.push(i); labels[i] = -2; }
  }
  if (hairCells.length > N * 0.01) defs.push({ name: "hair", kind: "hair", cells: hairCells });
  // the rest: cloth and anything else, by colour
  const rest = [];
  for (let i = 0; i < N; i++) if (free(i)) rest.push(i);
  if (rest.length > N * 0.005) {
    const k = O.cloths ?? 2;
    const near = wcKMeans(rest.map((i) => [lab[i][1], lab[i][2], lab[i][0] * 0.3]), k);
    const parts = Array.from({ length: k }, () => []);
    for (const i of rest) parts[near([lab[i][1], lab[i][2], lab[i][0] * 0.3])].push(i);
    parts.forEach((cells, j) => { if (cells.length > N * 0.003) defs.push({ name: `cloth${j}`, kind: null, cells }); });
  }

  // every mass gets a soft mask, a value map and a kind
  WCM.masses = defs.filter((d) => d.cells.length > 50).map((d) => {
    const hard = new Float32Array(N);
    for (const i of d.cells) hard[i] = 1;
    const mask = blurChannel(hard, 1);
    let kind = d.kind;
    if (!kind) {
      // crisp folds have strong, coherent edges; a soft cloth has neither
      let g = 0;
      for (const i of d.cells) g += WCM.coh[i] * (Math.abs((L[i + 1] ?? 0) - (L[i - 1] ?? 0)) + Math.abs((L[i + GW] ?? 0) - (L[i - GW] ?? 0)));
      kind = g / d.cells.length > (O.crispAbove ?? 4) ? "crisp" : "soft";
    }
    let value;
    if (kind === "skin") {
      const w = hard.map((v, i) => v * (1 - WCM.feat[i]));
      const near = wcNormBlur(L, w, 2), far = wcNormBlur(L, w, 6), mix = O.skinDetail ?? 0.5;
      value = near.map((v, i) => mix * v + (1 - mix) * far[i]);
    } else if (kind === "soft") value = wcNormBlur(L, hard, 6);
    else value = wcAlongFlow(mask, wcNormBlur(L, hard, 1));
    const sorted = d.cells.map((i) => value[i]).sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
    return { name: d.name, kind, hard, mask, value, cells: d.cells, hi: q(0.97), lo: q(0.02) };
  });
  WCM.lit = (m) => {
    const c = m.cells.filter((i) => m.value[i] > m.hi - (m.hi - m.lo) * 0.2);
    return [0, 1, 2].map((k) => c.reduce((s, i) => s + WCM.colour[k][i], 0) / Math.max(1, c.length));
  };
}

// the colour the photo has where a mass's value map is near t
function wcColourAt(m, t) {
  const band = Math.max(5, (m.hi - m.lo) / 10);
  let s = [0, 0, 0], n = 0;
  for (let k = 0; k < m.cells.length; k += 2) {
    const i = m.cells[k];
    if (Math.abs(m.value[i] - t) < band) { s[0] += WCM.colour[0][i]; s[1] += WCM.colour[1][i]; s[2] += WCM.colour[2][i]; n++; }
  }
  return n ? s.map((v) => v / n) : WCM.lit(m);
}

// the canvas as it stands, on the analysis grid (the last frame has dried)
function wcSee() {
  const im = get();
  const cv = document.createElement("canvas");
  cv.width = GW; cv.height = GH;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im.canvas, 0, 0, GW, GH);
  const d = ctx.getImageData(0, 0, GW, GH).data;
  const rgb = [0, 1, 2].map((k) => blurChannel(Float32Array.from({ length: GW * GH }, (_, i) => d[i * 4 + k]), 1));
  return { rgb, L: lum(rgb) };
}

// The pigment a glaze needs: a transparent glaze multiplies what is under it, so to
// darken S to T it filters by T / S, and a fill of this opacity only goes part of the
// way. The hue always stays the photo's: only how dark to mix it is measured, since
// correcting each colour channel on its own swings into wild colours.
//
// Strength of colour is measured too, when asked: a thin glaze moves the sheet only part
// of the way, so over a pale wash it has to be stronger than the colour it is after, or
// it only greys the wash. It is measured along the photo's own hue, so the hue can't swing.
function wcMix(T, S, rich = 1.15, opacity = 150, floor = 0.7, tune = false) {
  const t = wcPigment(T, rich), part = (opacity / 255) * (SUBJECT.watercolour?.reach ?? 0.58);
  const filter = (wcLumOf(t) + 6) / (wcLumOf(S) + 6);
  // never much darker than the colour it is after: dark pigment over a light wash
  // greys it, so the darks are built up over several glazes instead
  // a glaze thinned almost to paper does nothing but pale what it covers
  const want = Math.min(Math.max(247 * constrain((filter - 1 + part) / part, 0, 1), wcLumOf(t) * floor), wcLumOf(t) * 1.12);
  const k = want / Math.max(4, wcLumOf(t));
  // lighter than the colour itself means thinning it with water, not brightening it
  const mixed = t.map((v, c) => (k >= 1 ? v + (WC_PAPER[c] - v) * constrain((want - wcLumOf(t)) / Math.max(1, 247 - wcLumOf(t)), 0, 1) : v * k));
  if (!tune) return color(...mixed);
  const lT = wcLumOf(T), lS = wcLumOf(S), dT = T.map((v) => v - lT), dS = S.map((v) => v - lS);
  const size = dT[0] ** 2 + dT[1] ** 2 + dT[2] ** 2;
  if (size < 4) return color(...mixed);
  const there = (dS[0] * dT[0] + dS[1] * dT[1] + dS[2] * dT[2]) / size;
  const f = constrain(1 + (1 - there) * (1 - part) / part, 0.7, 1.9), l = wcLumOf(mixed);
  return color(...mixed.map((v) => constrain(l + (v - l) * f, 0, 255)));
}
function wcNeed(cells, seen, rich, opacity, floor, tune) {
  const T = [0, 0, 0], S = [0, 0, 0], n = Math.max(1, cells.length);
  for (const i of cells) for (let k = 0; k < 3; k++) { T[k] += WCM.colour[k][i] / n; S[k] += seen.rgb[k][i] / n; }
  return wcMix(T, S, rich, opacity, floor, tune);
}

// ---- recipes

function wcSoftGlazes(levels, open, L, seen, opacity = 130, minArea = 900, rich, floor, tune) {
  const value = new Float32Array(L.length);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) value[y * GW + x] = L[y * GW + x] + 14 * (noise(x * 0.06 + 21, y * 0.06) - 0.5);
  const inside = [];
  for (let i = 0; i < value.length; i++) if (open[i] > 0.5) inside.push(i);
  for (const t of levels) {
    const band = inside.filter((i) => Math.abs(value[i] - t) < 14);
    if (band.length < 12) continue;
    let gap = 0;
    for (const i of band) gap += wcGap(seen, i) / band.length;
    if (gap < 2) continue;
    const col = wcNeed(band, seen, rich, opacity, floor, tune);
    for (const s of wcTrace(wcDarker(open, value, t, 18, 2), { step: 8, minArea, minHole: 2500, max: 5 })) {
      wcWet(s);
      wcPaint([s], col, opacity, { bleed: 0.1, tex: 0.3, rim: 0.02, split: 0.25 });
    }
  }
}

const wcChroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
function wcGap(seen, i) {
  const d = seen.L[i] - WCM.lum[i];
  if (d < -8) return d;
  const dull = wcChroma(WCM.colour[0][i], WCM.colour[1][i], WCM.colour[2][i]) - wcChroma(seen.rgb[0][i], seen.rgb[1][i], seen.rgb[2][i]);
  return Math.max(d, dull * 0.35);
}

// a mass broken into organic patches with fresh seeds, so joins never stack
function wcPatchCells(mask) {
  const seeds = [];
  for (let y = 30 * WU; y < H; y += 150 * WU) {
    for (let x = random(0, 110 * WU); x < W; x += 110 * WU) seeds.push([x + random(-34, 34) * WU, y + random(-60, 60) * WU]);
  }
  const cells = seeds.map(() => []);
  const offset = random(100);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      if (mask[i] < 0.02) continue;
      const X = x * G + 90 * WU * (noise(x * 0.036 + offset, y * 0.036) - 0.5);
      const Y = y * G + 90 * WU * (noise(x * 0.036 + offset, y * 0.036 + 50) - 0.5);
      let d1 = Infinity, d2 = Infinity, c1 = 0, c2 = 0;
      for (let k = 0; k < seeds.length; k++) {
        const d = Math.hypot(X - seeds[k][0], (Y - seeds[k][1]) / 1.8);
        if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = k; } else if (d < d2) { d2 = d; c2 = k; }
      }
      cells[c1].push(i);
      if (d2 - d1 < 3) cells[c2].push(i);
    }
  }
  return cells.filter((c) => c.length >= 30);
}

// one tone over a mass, patch by patch
function wcPatches(mask, L, t, seen, opacity, step, soft = 8, rich) {
  for (const cell of wcPatchCells(mask)) {
    const under = cell.filter((i) => Math.abs(L[i] - t) < 16 && wcGap(seen, i) > 2);
    if (under.length < 12) continue;
    const f = new Float32Array(GW * GH);
    for (const i of cell) f[i] = mask[i] * constrain((t - L[i]) / soft + 0.5, 0, 1);
    wcPaint(wcTrace(f, { step, minArea: 70, minHole: 90, max: 8, it: 1 }), wcNeed(under, seen, rich, opacity), opacity, { bleed: 0.1, tex: 0.25, rim: 0.06, split: 0.12 });
  }
}

function wcWalk(x, y, maxLen, mask) {
  const path = [[x, y]];
  let t = WCM.flow[wcCell(x, y)], len = 0;
  const step = 10 * WU;
  while (len < maxLen) {
    let next = WCM.flow[wcCell(x, y)];
    if (Math.cos(next - t) < 0) next += Math.PI;
    if (Math.cos(next - t) < 0.75) break;
    t = Math.atan2(Math.sin(t) * 0.6 + Math.sin(next) * 0.4, Math.cos(t) * 0.6 + Math.cos(next) * 0.4);
    x += Math.cos(t) * step;
    y += Math.sin(t) * step;
    len += step;
    if (mask[wcCell(x, y)] < 0.5) break;
    path.push([x, y]);
  }
  return path;
}

const wcTaper = (path) => path.map(([x, y], i) => [x, y, 0.25 + 1.1 * Math.sin(Math.PI * Math.pow(i / (path.length - 1), 0.7))]);

// strokes along the flow, only where the direction can be trusted; their colour
// comes from the photo a little darker or lighter than the wash they sit on
function wcStrands(m, mask, count, lenMin, lenMax, wMin, wMax, contrast) {
  let done = 0;
  for (let tries = 0; tries < 12000 && done < count; tries++) {
    const x = random(W), y = random(H), i = wcCell(x, y);
    if (mask[i] < 0.9 || WCM.coh[i] < 0.3) continue;
    const path = wcWalk(x, y, random(lenMin, lenMax) * WU, mask);
    if (path.length < 5) continue;
    const c = at(WCM.colour, i), k = random() < 0.7 ? 1 - contrast : 1 + contrast * 1.4;
    wcStrokeLine(wcTaper(path), "dilute", wcColour(c.map((v) => v * k + 10), 1.3), random(wMin, wMax), 0.7);
    done++;
  }
}

// the next session: the paper dries, and changing one session can't reshuffle the rest
function* wcNext() {
  yield;
  randomSeed((SUBJECT.seed ?? 17) + 1000 + ++wcSession * 17);
}

const wcLevels = (m, from, to, n) => Array.from({ length: n }, (_, k) => {
  const t = m.hi - (m.hi - m.lo) * (from + (to - from) * (n > 1 ? k / (n - 1) : 0));
  return t;
});

// ---- sessions

// the wall: pale washes loosely round the head, wet colours dropped into them
function* wcPaleBackdrop() {
  const O = SUBJECT.backdrop;
  const open = wcMult(WCM.back, WCM.vignette);
  const lobe = (seed, t) => {
    const f = new Float32Array(GW * GH);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) f[y * GW + x] = open[y * GW + x] * (noise(x * 0.012 + seed, y * 0.012) > t ? 1 : 0);
    return blurChannel(f, 3);
  };
  const base = WCM.backColour;
  for (let k = 0; k < 2; k++) {
    wcPaint(wcTrace(lobe(k * 37 + 5, 0.36), { step: 24, minArea: 4000, minHole: 6000, max: 4 }), wcColour(wcThin(O.colours[k] || base, 0.75), 1.5), 62, { bleed: 0.34, tex: 0.5, rim: 0.2, split: 0.3 });
    yield* wcNext();
  }
  // the shade behind the head, run in wet
  const shade = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) shade[y * GW + x] = open[y * GW + x] * (gauss(x * G, y * G, O.shade) * (0.6 + noise(x * 0.02 + 9, y * 0.02)) > 0.72 ? 1 : 0);
  for (const s of wcTrace(blurChannel(shade, 3), { step: 18, minArea: 2500, minHole: 5000, max: 4 })) {
    wcWet(s);
    wcPaint([s], wcColour(wcThin(O.colours[2] || base, 0.7), 1.5), 54, { bleed: 0.22, tex: 0.4, rim: 0.1, split: 0.3 });
  }
  yield* wcNext();
}

function* wcSkin(m) {
  // 0 for fair skin, towards 1 for deep skin: thin glazes alone would never reach it
  const deep = constrain((190 - m.hi) / 100, 0, 1);
  const lit = WCM.lit(m), open = m.mask.map((v, i) => v * WCM.fade[i] * (1 - WCM.feat[i]));
  // the first wash runs under whatever frames the skin, so no white slits
  const reach = blurChannel(m.hard, 2);
  const wide = reach.map((v, i) => constrain(v * 2.5, 0, 1) * WCM.fade[i] * (1 - WCM.feat[i]) * (1 - WCM.backHard[i]));
  wcPaint(wcTrace(wcDarker(wide, m.value, m.hi + 30, 14, 2), { step: 10, minArea: 900, minHole: 12000, max: 4 }), wcColour(wcThin(lit, 0.85 + 0.15 * deep), 1.5), 205 + 40 * deep, { bleed: 0.2, tex: 0.2, rim: 0.12, split: 0.25 });
  yield* wcNext();
  // many small steps in value, a few to a session, looking again between them
  // starting above the brightest value, so the highlight melts in instead of standing as an island
  const ts = wcLevels(m, -0.12, 0.97, 24);
  for (let k = 0; k < ts.length; k += 2) {
    wcSoftGlazes(ts.slice(k, k + 2), open, m.value, wcSee(), 95 + 120 * deep, 500, 1.4, 0.7 - 0.2 * deep, true);
    yield* wcNext();
  }
  // found edges, only where the head turns into what frames it: on dry paper
  const other = blurChannel(m.hard.map((v, i) => (v || WCM.backHard[i] ? 0 : 1)), 8);
  const band = open.map((v, i) => v * constrain(other[i] * 5 - 0.25, 0, 1));
  const t = m.hi - (m.hi - m.lo) * 0.3;
  const seen = wcSee();
  const edgeCells = m.cells.filter((i) => band[i] > 0.5 && m.value[i] < t && wcGap(seen, i) > 4);
  if (edgeCells.length > 8) wcPaint(wcTrace(wcDarker(band, m.value, t, 10, 2), { step: 7, minArea: 500, minHole: 9000, max: 4 }), wcNeed(edgeCells, seen, 1.15, 80, undefined, true), 80, { bleed: 0.07, tex: 0.35, rim: 0.2, split: 0.25 });
  yield* wcNext();
  // the flush of blood: thin layers where the photo's skin is redder than its own average
  const lab = m.cells.map((i) => wcLab(at(WCM.colour, i))[1]);
  const mean = lab.reduce((a, b) => a + b, 0) / lab.length;
  const flush = new Float32Array(GW * GH);
  m.cells.forEach((i, k) => { flush[i] = (lab[k] - mean) * (1 - WCM.feat[i]) * WCM.fade[i]; });
  const smooth = blurChannel(flush, 6);
  const rose = wcPigment(wcThin(wcColourAt(m, m.hi - (m.hi - m.lo) * 0.25).map((v, k) => v * [1.05, 0.72, 0.78][k]), 0.8), 1.4);
  for (const level of [1.5, 3, 4.5, 6]) {
    for (const s of wcTrace(smooth.map((v) => constrain((v - level) / 2 + 0.5, 0, 1)), { step: 8, minArea: 300, max: 4 })) {
      wcWet(s);
      wcPaint([s], color(...rose), 22, { bleed: 0.06, tex: 0.1, rim: 0, split: 0.1 });
    }
  }
  yield* wcNext();
}

function* wcHair(m) {
  const mask = m.mask.map((v, i) => v * WCM.fade[i]);
  const col = (f) => wcColour(wcColourAt(m, m.hi - (m.hi - m.lo) * f), 1.25);
  // three overlapping parts, each a warm mass with its darks dropped in wet
  const ys = m.cells.map((i) => i % GW).sort((a, b) => a - b);
  const q = (p) => ys[Math.floor(p * (ys.length - 1))];
  const bounds = [[0, q(0.42)], [q(0.3), q(0.72)], [q(0.6), GW]];
  for (const [x0, x1] of bounds) {
    const part = mask.map((v, i) => (i % GW >= x0 && i % GW <= x1 ? v : 0));
    wcPaint(wcTrace(blurChannel(part, 2), { step: 8, minArea: 500, minHole: 400, max: 5 }), col(0.15), 225, { bleed: 0.12, tex: 0.5, rim: 0.2, split: 0.25 });
    const dark = wcDarker(part, m.value, m.hi - (m.hi - m.lo) * 0.65, 18, 2);
    wcPaint(wcTrace(dark, { step: 12, minArea: 500, max: 5 }), col(0.8), 170, { bleed: 0.2, tex: 0.5, rim: 0.05, split: 0.3 });
  }
  yield* wcNext();
  // darker tones as two thin passes each: one strong pass reads as camouflage
  for (const f of [0.3, 0.5]) {
    const t = m.hi - (m.hi - m.lo) * f;
    for (let k = 0; k < 2; k++) { wcPatches(mask, m.value, t, wcSee(), 120, 7); yield* wcNext(); }
  }
  // one glaze over the whole mass pulls the patches together
  {
    const seen = wcSee();
    wcPaint(wcTrace(blurChannel(mask, 2), { step: 8, minArea: 500, minHole: 800, max: 6 }), wcNeed(m.cells, seen, 1.15, 130), 130, { bleed: 0.12, tex: 0.3, rim: 0.1, split: 0.2 });
    yield* wcNext();
  }
  for (const f of [0.68, 0.84, 0.94]) {
    const t = m.hi - (m.hi - m.lo) * f;
    for (let k = 0; k < 2; k++) { wcPatches(mask, m.value, t, wcSee(), 160, 6); yield* wcNext(); }
  }
}

function* wcCrisp(m) {
  const mask = m.mask.map((v, i) => v * WCM.fade[i]);
  const lit = WCM.lit(m);
  // pale first wash, with the brightest lights left as paper
  wcPaint(wcTrace(wcDarker(mask, m.value, m.hi + 12, 18, 1), { step: 7, minArea: 200, minHole: 300, max: 6, it: 1 }), wcColour(wcThin(lit, 0.85), 1.3), 225, { bleed: 0.2, tex: 0.55, rim: 0.15, split: 0.3 });
  yield* wcNext();
  for (const f of [0.1, 0.25, 0.42, 0.58, 0.72, 0.85, 0.94]) {
    wcPatches(mask, m.value, m.hi - (m.hi - m.lo) * f, wcSee(), f > 0.8 ? 130 : 165, f > 0.7 ? 5 : 7, f > 0.8 ? 18 : 8, 1.5);
    yield* wcNext();
  }
}

// soft cloth: water would dilute a wash this large to nothing, so it is built dry,
// in patches with very soft edges over a heavily blurred value map
function* wcSoft(m) {
  const mask = m.mask.map((v, i) => v * WCM.fade[i]);
  const lit = WCM.lit(m);
  const whole = wcTrace(blurChannel(mask, 2), { step: 10, minArea: 400, minHole: 3000, max: 3 });
  wcPaint(whole, wcColour(wcThin(lit, 0.95), 1.5), 245, { bleed: 0.14, tex: 0.6, rim: 0.3, split: 0.3 });
  wcPaint(whole, wcColour(wcThin(lit, 0.95), 1.5), 200, { bleed: 0.14, tex: 0.5, rim: 0.1, split: 0.25 });
  yield* wcNext();
  if (m.hi - m.lo < 45) {
    for (let k = 0; k < 3; k++) {
      const seen = wcSee();
      let lighter = 0;
      for (const i of m.cells) lighter += (seen.L[i] - WCM.lum[i]) / m.cells.length;
      if (lighter < 3) break;
      // only as strong as what is left to do: a full wash near the end overshoots
      const strength = constrain(lighter * 7, 50, 170);
      wcPaint(whole, wcNeed(m.cells, seen, 1.5, strength), strength, { bleed: 0.12, tex: 0.5, rim: 0.12, split: 0.25 });
      yield* wcNext();
    }
    return;
  }
  for (const f of [0.15, 0.32, 0.5, 0.66, 0.8, 0.92]) {
    wcPatches(mask, m.value, m.hi - (m.hi - m.lo) * f, wcSee(), 165, 9, 26, 1.5);
    yield* wcNext();
  }
}

// a dark ground, late, so spills can't ruin the lights it surrounds. Not one flat
// black: it starts as a warm transparent umber, each pass misses some of the sheet
// in large drifting shapes, and it deepens only near the figure, thinning outwards
function* wcDarkBackdrop() {
  const base = WCM.backColour;
  const warmth = constrain(wcLumOf(base) / 40, 0, 1);
  const mix = (k, warm) => wcColour([base[0] * k + warm * warmth, base[1] * k, base[2] * k - warm * warmth * 0.5], 1.3);
  // a hair over the edge of the figure, so no white slit is left beside it
  const reach = blurChannel(WCM.back, 1).map((v) => constrain(v * 1.6, 0, 1));
  const open = wcMult(reach, WCM.vignette);
  // a big wash wrapped round the figure thins out on its far side, so the ground is
  // laid in overlapping sectors, a new starting angle on every pass
  const [hx, hy] = [SUBJECT.backdrop.shade[0] * S, SUBJECT.backdrop.shade[1] * S];
  const sectors = (mask, turn) => [0, 1, 2, 3].map((k) => {
    const mid = turn + k * Math.PI / 2;
    const f = mask.map((v, i) => {
      const x = i % GW, y = (i / GW) | 0;
      const a = Math.atan2(y * G - hy, x * G - hx) - mid + 2.2 * (noise(x * 0.012 + k * 19, y * 0.012 + turn) - 0.5);
      return Math.cos(a) > 0.45 ? v : 0;
    });
    return blurChannel(f, 4);
  });
  const lay = (mask, turn, col, op, o) => {
    for (const sec of sectors(mask, turn)) wcPaint(wcTrace(sec, { step: 11, minArea: 1500, minHole: 800, max: 2 }), col, op, o);
  };
  lay(open, 0.3, mix(1.8, 14), 235, { bleed: 0.3, tex: 0.7, rim: 0.2, split: 0.3 });
  // colours dropped in wet, sampled from the photo's own backdrop and pushed apart
  for (let k = 0; k < 7; k++) {
    let x, y, tries = 0;
    do { x = random(W); y = random(H); } while (open[wcCell(x, y)] < 0.9 && ++tries < 60);
    const s = wcTrace(blurChannel(wcMult(wcRaster([wcBlob(x, y, random(60, 130) * WU, random(60, 130) * WU, 24, 0.3)]), open), 2), { step: 10, minArea: 800, max: 1 });
    if (!s.length) continue;
    wcWet(s[0]);
    wcPaint(s, k % 3 === 2 ? mix(1.2, -8) : mix(1.7, 20), 120, { bleed: 0.3, tex: 0.6, rim: 0.05, split: 0.35 });
  }
  yield* wcNext();
  // each pass leaves a little of the last one showing, in large drifting shapes
  const passes = [[1.45, 10, 0.3], [1.2, 6, 0.34], [1.02, 3, 0.38]];
  for (let p = 0; p < passes.length; p++) {
    const [k, warm, t] = passes[p];
    const f = open.map((v, i) => v * constrain((noise((i % GW) * 0.011 + p * 31, ((i / GW) | 0) * 0.011 + 7) - t) / 0.08, 0, 1));
    lay(f, 0.3 + p * 0.7, mix(k, warm), 235, { bleed: 0.26, tex: 0.5, rim: 0.12, split: 0.2 });
    yield* wcNext();
  }
  // the depth: nearest the figure the ground goes as dark as the photo's, thinning outwards
  const [sx, sy] = [SUBJECT.backdrop.shade[2], SUBJECT.backdrop.shade[3]];
  for (const [k, reachK, turn] of [[0.86, 1.5, 1.1], [0.74, 1.05, 2.1]]) {
    const near = open.map((v, i) => v * (gauss((i % GW) * G, ((i / GW) | 0) * G, [SUBJECT.backdrop.shade[0], SUBJECT.backdrop.shade[1], sx * reachK, sy * reachK]) * (0.75 + 0.5 * noise((i % GW) * 0.01 + 3, ((i / GW) | 0) * 0.01)) > 0.3 ? 1 : 0));
    lay(blurChannel(near, 3), turn, mix(k, 0), 235, { bleed: 0.3, tex: 0.4, rim: 0.08, split: 0.2 });
    yield* wcNext();
  }
}

// the painter looks: another glaze only where the painting is still lighter than the photo
function* wcCorrect(masses, gate = 10) {
  const seen = wcSee();
  for (const m of masses) {
    if (m.kind === "skin" && gate < 15 && m.hi > 150) continue;
    const deficit = new Float32Array(GW * GH);
    for (const i of m.cells) deficit[i] = wcGap(seen, i) * WCM.fade[i] * (1 - WCM.feat[i]);
    if (m.kind === "skin") {
      const deep = constrain((190 - m.hi) / 100, 0, 1);
      const f = blurChannel(deficit, 5).map((v) => constrain((v - gate) / 18 + 0.5, 0, 1));
      for (const s of wcTrace(f, { step: 8, minArea: 300, minHole: 1500, max: 6 })) {
        // each shape's own colour: one pigment across a whole face leaves a grey band
        const inside = wcRaster([s]), cells = m.cells.filter((i) => inside[i] && f[i] > 0.5);
        if (cells.length < 8) continue;
        wcWet(s);
        wcPaint([s], wcNeed(cells, seen, 1.45, 70 + 130 * deep, 0.9 - 0.4 * deep, true), 70 + 130 * deep, { bleed: 0.12, tex: 0.3, rim: 0.02, split: 0.2 });
      }
      continue;
    }
    // large wrap-around masses have no useful middle, so they are corrected patch by patch
    const f = blurChannel(deficit, 2).map((v) => constrain((v - gate) / 10 + 0.5, 0, 1));
    for (const cell of wcPatchCells(f)) {
      const under = cell.filter((i) => f[i] > 0.5);
      if (under.length < 10) continue;
      const g = new Float32Array(GW * GH);
      for (const i of cell) g[i] = f[i];
      wcPaint(wcTrace(g, { step: 6, minArea: 90, minHole: 200, max: 6, it: 2 }), wcNeed(under, seen, 1.5, 170, m.kind === "hair" ? 0.45 : 0.55), 170, { bleed: 0.09, tex: 0.3, rim: 0.05, split: 0.2 });
    }
  }
  yield* wcNext();
}

// the features are looked at closely: small glazes, from a finer view of the photo,
// wherever the painting is lighter than the photo. Likeness comes from the photo's
// own shapes, not from outlines, and the edges stay those of a wash
function wcFineGrid() {
  const fw = W * 2, fh = H * 2;
  const cv = document.createElement("canvas");
  cv.width = fw; cv.height = fh;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(wcPhoto, 0, 0, fw, fh);
  WCM.fine = { w: fw, h: fh, data: ctx.getImageData(0, 0, fw, fh).data };
}

function wcBoxBlur(a, w, h, r) {
  let src = a;
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[y * w + constrain(x, 0, w - 1)];
      for (let x = 0; x < w; x++) { t[y * w + x] = s / n; s += src[y * w + Math.min(x + r + 1, w - 1)] - src[y * w + Math.max(x - r, 0)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += t[constrain(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += t[Math.min(y + r + 1, h - 1) * w + x] - t[Math.max(y - r, 0) * w + x]; }
    }
    src = out;
  }
  return src;
}

function* wcFeatures() {
  wcFineGrid();
  const blurR = SUBJECT.watercolour?.featureBlur ?? 2;
  // each focal ellipse: photo values, photo colours, a falloff at its edge
  const views = FOCAL.map(([cx, cy, rx, ry]) => {
    const x0 = Math.max(0, Math.floor((cx - rx) * 2)), x1 = Math.min(WCM.fine.w - 1, Math.ceil((cx + rx) * 2));
    const y0 = Math.max(0, Math.floor((cy - ry) * 2)), y1 = Math.min(WCM.fine.h - 1, Math.ceil((cy + ry) * 2));
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const chan = [0, 1, 2].map(() => new Float32Array(w * h));
    const fade = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y + y0) * WCM.fine.w + x + x0) * 4;
      for (let k = 0; k < 3; k++) chan[k][y * w + x] = WCM.fine.data[p + k];
      fade[y * w + x] = 1 - wcStep(0.72, 1, Math.hypot(((x + x0) / 2 - cx) / rx, ((y + y0) / 2 - cy) / ry));
    }
    const rgb = chan.map((c) => wcBoxBlur(c, w, h, blurR));
    const L = rgb[0].map((v, i) => 0.299 * v + 0.587 * rgb[1][i] + 0.114 * rgb[2][i]);
    return { x0, y0, w, h, rgb, L, fade };
  });
  // large gaps first, with stronger paint; then finer ones
  for (const gate of [44, 30, 20, 13, 8, 5]) {
    const im = get();
    const cv = document.createElement("canvas");
    cv.width = WCM.fine.w; cv.height = WCM.fine.h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(im.canvas, 0, 0, cv.width, cv.height);
    for (const v of views) {
      const d = ctx.getImageData(v.x0, v.y0, v.w, v.h).data;
      const under = [0, 1, 2].map((k) => wcBoxBlur(Float32Array.from({ length: v.w * v.h }, (_, i) => d[i * 4 + k]), v.w, v.h, blurR));
      const soft = under[0].map((p, i) => 0.299 * p + 0.587 * under[1][i] + 0.114 * under[2][i]);
      const raw = soft.map((p, i) => {
        const d = p - v.L[i];
        const dull = wcChroma(v.rgb[0][i], v.rgb[1][i], v.rgb[2][i]) - wcChroma(under[0][i], under[1][i], under[2][i]);
        return constrain(((d < -8 ? d : Math.max(d, dull * 0.5)) * v.fade[i] - gate) / 5 + 0.5, 0, 1);
      });
      const sorted = Float32Array.from(v.L).sort(), middle = sorted[sorted.length >> 1], split = middle - (middle - sorted[Math.floor(sorted.length * 0.03)]) * 0.45;
      for (const f of [raw.map((a, i) => (v.L[i] >= split ? a : 0)), raw.map((a, i) => (v.L[i] < split ? a : 0))]) for (const s of wcTraceOn(f, v.w, v.h, v.x0, v.y0, 0.5, { step: 2.2, minArea: 7, minHole: 10, max: 14, it: 2 })) {
        const xs = s.map((q) => q[0]), ys = s.map((q) => q[1]);
        const bx0 = Math.max(0, Math.floor(Math.min(...xs) * 2 - v.x0)), bx1 = Math.min(v.w - 1, Math.ceil(Math.max(...xs) * 2 - v.x0));
        const by0 = Math.max(0, Math.floor(Math.min(...ys) * 2 - v.y0)), by1 = Math.min(v.h - 1, Math.ceil(Math.max(...ys) * 2 - v.y0));
        const T = [0, 0, 0], U2 = [0, 0, 0];
        let n = 0;
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
          const i = y * v.w + x, w = f[i];
          if (w < 0.5) continue;
          for (let c = 0; c < 3; c++) { T[c] += v.rgb[c][i]; U2[c] += under[c][i]; }
          n++;
        }
        if (!n) continue;
        const tm = T.map((a) => a / n);
        wcPaint([s], wcMix(tm, U2.map((a) => a / n), 1.3 + constrain(wcChroma(...tm) / 140, 0, 0.3), 165), 165, { bleed: 0.06, tex: 0.25, rim: 0.05, split: 0.15 });
      }
    }
    yield* wcNext();
  }
}

// the last, decisive marks: sampled from the photo, soft and few
function* wcAccents() {
  const A = SUBJECT.accents;
  const darkest = (pts) => {
    let best = [60, 45, 40], bl = 1e9;
    for (const p of pts) { const c = sampleAt(ref.mid, p[0] * S, p[1] * S); const l = wcLumOf(c); if (l < bl) { bl = l; best = c; } }
    return best;
  };
  for (const { path, colour = "#3a2620", weight = 1 } of A.lines || []) {
    let run = [];
    for (const p of path) {
      run.push(p);
      if (run.length > 3 && random() < 0.25) { wcStrokeLine(sc(run), "dilute", colour, weight * 0.75, 0.6); run = random() < 0.5 ? [p] : []; }
    }
    if (run.length > 1) wcStrokeLine(sc(run), "dilute", colour, weight * 0.75, 0.6);
  }
  for (const p of A.lashes || []) wcStrokeLine(sc(p), "dilute", wcColour(darkest(p).map((v) => v * 0.7), 1.1), 0.8, 0.7);
  for (const p of A.nostrils || []) wcStrokeLine(sc(p), "dilute", wcColour(darkest(p), 1.1), 1.0, 0.7);
  for (const p of A.mouth || []) wcStrokeLine(sc(p), "dilute", wcColour(darkest(p).map((v) => v * 0.7), 1.25), 0.8, 0.7);
  for (const f of SUBJECT.hair?.flyaways || []) wcStrokeLine(sc(wcTaper(f)), "rigger", wcColour(darkest(f), 1.15), 0.7, 0.7);
  // the pupils, small against the iris, from the photo's own dark
  brush.noStroke();
  for (const [x, y, r] of A.pupils || []) {
    const near = Array.from({ length: 8 }, (_, k) => [x + Math.cos(k * 0.78) * r * 0.5, y + Math.sin(k * 0.78) * r * 0.5]);
    brush.wash(wcColour(darkest(near), 1.05), 215);
    brush.polygon(sc(wcBlob(x, y, r * 1.15, r * 1.15, 14, 0.05)));
    brush.noWash();
  }
  yield* wcNext();
  // gouache only for the catchlights: anything larger reads as a sticker
  for (const [x, y, r] of A.catchlights || []) {
    brush.wash(color(253, 252, 247), 225);
    brush.polygon(sc(wcBlob(x, y, Math.min(r, 3), Math.min(r, 3), 12, 0.08)));
    brush.noWash();
  }
  yield* wcNext();
}

// a little spatter where the pigment could have come from, off the face and body
function* wcSpatter() {
  const big = [...WCM.masses].sort((a, b) => b.cells.length - a.cells.length).filter((m) => m.kind !== "skin");
  for (const m of big.slice(0, 2)) {
    const c = wcColourAt(m, m.hi - (m.hi - m.lo) * 0.3);
    for (let k = 0, placed = 0; k < 200 && placed < 7; k++) {
      const i = m.cells[Math.floor(random(m.cells.length))];
      const x = (i % GW) * G + randomGaussian(0, 70 * WU), y = ((i / GW) | 0) * G + randomGaussian(0, 70 * WU);
      if (x < 15 || y < 15 || x > W - 15 || y > H - 15) continue;
      const j = wcCell(x, y);
      // on bare paper only
      if (!WCM.backHard[j] || WCM.vignette[j] > 0.2 && darkBackdrop()) continue;
      if (attention(x, y) > 0.3) continue;
      const r = random(0.6, 2.2) ** 1.3 * WU * 1.2;
      wcPaint([wcBlob(x, y, r + 1.4, r + 1.4, 10, 0.12)], wcColour(c, 1.3), random(90, 170), { bleed: 0.01, tex: 0, rim: 0.6 });
      placed++;
    }
  }
  yield* wcNext();
}

function* watercolour() {
  wcSession = 0;
  wcBrushes();
  yield* paper("#f6f1e8", 18);
  yield* underdrawing("#a39e97", true);
  randomSeed((SUBJECT.seed ?? 17) + 1000);
  const dark = darkBackdrop();
  // a pale wall goes first and thin; a dark ground comes late
  if (!dark) yield* wcPaleBackdrop();
  for (const m of WCM.masses) if (m.kind === "skin") yield* wcSkin(m);
  const rest = WCM.masses.filter((m) => m.kind !== "skin");
  // lightest masses first: light to dark across the whole sheet
  rest.sort((a, b) => b.hi - a.hi);
  for (const m of rest) {
    if (m.kind === "hair") yield* wcHair(m);
    else if (m.kind === "crisp") yield* wcCrisp(m);
    else yield* wcSoft(m);
    if (m.kind === "crisp" && m.cells.length > GW * GH * 0.02) wcStrands(m, m.mask.map((v, i) => v * WCM.fade[i]), 18, 40, 200, 0.5, 0.9, 0.12);
  }
  yield* wcNext();
  if (dark) yield* wcDarkBackdrop();
  // the painter steps back: two rounds of correction before the details
  for (const gate of [26, 20, 15, 11, 8, 6]) yield* wcCorrect(WCM.masses, gate);
  // rigger work where the direction is real
  for (const hair of WCM.masses.filter((m) => m.kind === "hair")) {
    wcStrands(hair, hair.mask.map((v, i) => v * WCM.fade[i]), 130, 40, 170, 0.5, 1.1, 0.35);
    yield* wcNext();
  }
  yield* wcFeatures();
  yield* wcAccents();
  yield* wcSpatter();
  // how close the values came, for the critique
  const seen = blurChannel(wcSee().L, 2), target = blurChannel(WCM.lum, 2);
  window.__wc = Object.fromEntries(WCM.masses.map((m) => {
    let e = 0, b = 0;
    const kept = m.cells.filter((i) => WCM.fade[i] > 0.8);
    for (const i of kept) { const d = seen[i] - target[i]; e += d * d; b += d; }
    return [m.name, { kind: m.kind, share: +(m.cells.length / (GW * GH)).toFixed(3), lighterBy: +(b / Math.max(1, kept.length)).toFixed(1), rms: +Math.sqrt(e / Math.max(1, kept.length)).toFixed(1) }];
  }));
}

// ============================================================= shared line tools

let edges;   // edge strength 0..1 from the photo (where a contour would be drawn)

function edgeField(L) {
  const out = new Float32Array(GW * GH);
  for (let y = 1; y < GH - 1; y++) {
    for (let x = 1; x < GW - 1; x++) {
      const p = (dx, dy) => L[(y + dy) * GW + x + dx];
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      out[y * GW + x] = Math.hypot(gx, gy);
    }
  }
  const sorted = Float32Array.from(out).sort();
  const hi = sorted[Math.floor(sorted.length * 0.985)] || 1;
  return [out.map((v) => Math.min(1, v / hi))];
}

// ============================================================= pen and ink style
//
// Drawn the way an engraver thinks and an illustrator inks, looking back at the sheet
// after every set of lines:
//   pencil -> the solid blacks with a sable -> the ground ruled in -> line sets over the
//   masses, each laid only where the sheet is still too light -> the features from a
//   close view of the photo -> contours, lost and found -> accents and white gouache.
//
// There is no grey ink. A value is a family of evenly spaced lines, and how much each
// line swells under pressure; crossing sets go only where one set can't get dark enough.
// The lines follow the form, so they describe it as they tone it.

const IN_PEN_WIDTH = 0.78;   // how wide a pen line is, in canvas units, at pressure 1

Object.assign(CH_TOOLS, {
  pen:     { brush: "pen", layer: "stick", colour: "#000000", radius: 2, gives: 0.1 },
  penFine: { brush: "penFine", layer: "stick", colour: "#000000", radius: 1, gives: 0.09 },
  sable:   { brush: "sable", layer: "stick", colour: "#000000", radius: 3, gives: 0.3 },
  gouache: { brush: "gouache", layer: "stick", colour: "#ffffff", radius: 2, gives: 0.1, lifts: true },
  pencil:  { brush: "vine", layer: "smudge", colour: "#a5a19b", radius: 2, gives: 0 },
});

const IN_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSmudge;
uniform sampler2D uStick;
uniform sampler2D uTooth;
uniform vec3 uPaper;
uniform vec3 uCharcoal;
float lum(vec3 c) { return dot(c, vec3(1.0 / 3.0)); }
void main() {
  vec4 tooth = texture(uTooth, vUV);
  vec2 px = 0.75 / vec2(textureSize(uStick, 0));
  float ink = 1.0 - 0.25 * (lum(texture(uStick, vUV + px).rgb) + lum(texture(uStick, vUV - px).rgb)
    + lum(texture(uStick, vUV + vec2(px.x, -px.y)).rgb) + lum(texture(uStick, vUV + vec2(-px.x, px.y)).rgb));
  // ink is either there or it isn't: its edge is crisp, but not a jagged one
  float laid = smoothstep(0.12, 0.72, ink);
  vec3 paper = uPaper * (0.994 + 0.012 * tooth.g);
  vec3 sheet = paper * mix(1.0, lum(texture(uSmudge, vUV).rgb), 0.7);
  outColor = vec4(mix(sheet, uCharcoal, laid), 1.0);
}`;

function inkTools() {
  const round = (t) => { t.noStroke(); t.fill(0); t.circle(0, 0, 92); };
  const nib = (weight, spacing, pressure) => ({ type: "custom", tip: round, rotate: "none", markerTip: false, scatter: 0, opacity: 255, noise: 0, weight, spacing, pressure });
  // a steel nib: lifts in and out to a point, swells between
  brush.add("pen", nib(IN_PEN_WIDTH, 0.12, [0.35, 1, 0.2]));
  brush.add("penFine", nib(0.5, 0.1, [0.45, 1, 0.3]));
  // a loaded sable: wide, solid, and it ends in a point at both ends
  brush.add("sable", nib(5, 0.5, [0.2, 1.1, 0.12]));
  // white gouache from a fine brush, for what a nib has covered
  brush.add("gouache", nib(1, 0.12, [0.4, 1, 0.3]));
}

function inkSetup() {
  inkTools();
  // ink has no pale grey worth the lines: lights go to bare paper, so the shapes stay clear
  chT = chT.map((t) => { const v = constrain(t / 0.93, 0, 1); return v >= 1 ? 1 : Math.pow(v, 1.1); });
}

// the sheet on the grid, every device pixel counted: a point sample of a line says nothing
function inLook() {
  chSmudge.loadPixels();
  chStick.loadPixels();
  const a = chSmudge.pixels, b = chStick.pixels, d = pixelDensity(), s = G * d, row = W * d, k = 1 / (s * s * 255);
  const out = chSeen ?? (chSeen = new Float32Array(GW * GH));
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    let sum = 0;
    for (let oy = 0; oy < s; oy++) {
      const r = (gy * s + oy) * row + gx * s;
      for (let ox = 0; ox < s; ox++) sum += b[4 * (r + ox)];
    }
    out[gy * GW + gx] = sum * k * (0.3 + 0.7 * a[4 * ((gy * s) * row + gx * s)] / 255);
  }
  return out;
}

// a smooth field per mass, from the form where the photo shows one and the wrist where
// it doesn't: lines bend with what they describe and never jitter from cell to cell
function inField(turn = 0, smooth = 5, trustForm = 1) {
  const N = GW * GH, cx = new Float32Array(N), cy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i % GW) * G, y = ((i / GW) | 0) * G, kind = chKinds[chRegion[i]];
    const long = kind === "hair" || kind === "crisp";
    const trust = (long ? 1 : constrain(WCM.coh[i] * 1.5, 0, 0.8)) * trustForm;
    const wrist = chWrist()(x, y), form = WCM.flow[i];
    cx[i] = trust * Math.cos(2 * form) + (1 - trust) * Math.cos(2 * wrist);
    cy[i] = trust * Math.sin(2 * form) + (1 - trust) * Math.sin(2 * wrist);
  }
  const R = Math.max(1, Math.round(smooth)), a = chWithinBlur(cx, R), b = chWithinBlur(cy, R);
  return Float32Array.from({ length: N }, (_, i) => 0.5 * Math.atan2(b[i], a[i]) + turn);
}

// One set of evenly spaced lines. A seed takes a line both ways along the field until
// the sheet is dark enough there, it nears another line, or the hand has gone far enough.
// Each point's pressure is the coverage the sheet still needs there.
function* inLines({ field, spacing, where, wanted, squint = 4, tol = 0.02, reach = [60, 170], pressure = [0.45, 1.5], tool = "pen", weight = 1, batch = 24, bias = 1 }) {
  const seen = chWithinBlur(inLook(), squint);
  const need = (x, y) => (chGrid(seen, x, y) - chGrid(wanted, x, y)) * bias;
  const cell = Math.max(2, spacing), cols = Math.ceil(W / cell) + 2, rows = Math.ceil(H / cell) + 2;
  const buckets = new Map(), width = IN_PEN_WIDTH * weight * (tool === "penFine" ? 0.66 : 1);
  const bucket = (x, y) => (Math.floor(y / cell) + 1) * cols + Math.floor(x / cell) + 1;
  const tooClose = (x, y, line) => {
    const c = bucket(x, y), lim = (spacing * 0.86) ** 2;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const list = buckets.get(c + oy * cols + ox);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) if (list[k + 2] !== line && (list[k] - x) ** 2 + (list[k + 1] - y) ** 2 < lim) return true;
    }
    return false;
  };
  const note = (x, y, line) => { const c = bucket(x, y); let l = buckets.get(c); if (!l) buckets.set(c, l = []); l.push(x, y, line); };

  const seeds = [];
  for (let y = 0; y < H; y += spacing) for (let x = 0; x < W; x += spacing) seeds.push([x + random(spacing), y + random(spacing), random()]);
  seeds.sort((a, b) => a[2] - b[2]);

  let strokes = [], id = 0;
  for (const [sx, sy] of seeds) {
    if (sx < 2 || sy < 2 || sx > W - 2 || sy > H - 2 || !where(sx, sy) || need(sx, sy) < tol || tooClose(sx, sy, -1)) continue;
    id++;
    const half = (sign, length) => {
      const pts = [];
      let x = sx, y = sy, a = chGrid(field, x, y) + (sign < 0 ? Math.PI : 0);
      for (let went = 0; went < length; went += 2) {
        let next = chGrid(field, x, y);
        if (Math.cos(next - a) < 0) next += Math.PI;
        a += Math.atan2(Math.sin(next - a), Math.cos(next - a)) * 0.5;
        x += Math.cos(a) * 2; y += Math.sin(a) * 2;
        if (x < 2 || y < 2 || x > W - 2 || y > H - 2 || !where(x, y) || need(x, y) < tol * 0.5 || tooClose(x, y, id)) break;
        pts.push([x, y]);
      }
      return pts;
    };
    const length = random(reach[0], reach[1]) / 2;
    const line = [...half(-1, length).reverse(), [sx, sy], ...half(1, length)];
    if (line.length < 4) continue;
    for (const [x, y] of line) note(x, y, id);
    const points = line.filter((_, k) => k % 3 === 0 || k === line.length - 1).map(([x, y]) => [x, y, constrain(need(x, y) * spacing / (width * 0.9), pressure[0], pressure[1])]);
    if (points.length < 2) continue;
    strokes.push({ tool: CH_TOOLS[tool], weight, points, curve: 0.5 });
    if (strokes.length >= batch) { chCommit(strokes); strokes = []; yield* chNext(); }
  }
  if (strokes.length) chCommit(strokes);
  yield* chNext();
}

// contours where the photo has a real edge: found near the features, lost away from them
function* inContours() {
  const fine = chFineFlow, strokes = [];
  const edgeAt = (x, y) => chGrid(edges[0], x, y);
  const count = Math.round((W * H) / 340);
  for (let k = 0; k < count; k++) {
    const x = random(W), y = random(H), label = chGrid(chRegion, x, y);
    if (label >= chMargin) continue;
    const e = edgeAt(x, y);
    if (e < 0.34 || random() > (0.25 + 0.75 * attention(x, y)) * finish(x, y)) continue;
    const pts = [[x, y, 0.5]];
    let px = x, py = y, a = chGrid(fine, x, y) + (random() < 0.5 ? Math.PI : 0);
    for (let went = 0; went < random(16, 70); went += 3) {
      let next = chGrid(fine, px, py);
      if (Math.cos(next - a) < 0) next += Math.PI;
      a += Math.atan2(Math.sin(next - a), Math.cos(next - a)) * 0.6;
      px += Math.cos(a) * 3; py += Math.sin(a) * 3;
      if (px < 2 || py < 2 || px > W - 2 || py > H - 2) break;
      const here = edgeAt(px, py);
      if (here < 0.2) break;
      pts.push([px, py, 0.5 + 0.7 * here]);
    }
    if (pts.length < 3) continue;
    strokes.push({ tool: CH_TOOLS.pen, weight: 0.85, points: pts, curve: 0.6 });
    if (strokes.length >= 120) { chCommit(strokes.splice(0)); yield* chNext(); }
  }
  if (strokes.length) chCommit(strokes);
  yield* chNext();
}

// lashes, the parting of the lips, pupils and the last whites
function* inAccents() {
  const A = SUBJECT.accents || {}, out = [];
  const pen = (tool, weight, line, wobble = 0.25) => ({ tool: CH_TOOLS[tool], weight, curve: 0.6, points: line.map(([x, y, p = 1]) => [x + random(-wobble, wobble), y + random(-wobble, wobble), 0.5 + p * 0.8]) });
  for (const p of A.lashes || []) out.push(pen("pen", 1.3, sc(p)));
  for (const p of A.nostrils || []) out.push(pen("pen", 1, sc(p)));
  for (const p of A.mouth || []) out.push(pen("pen", 1.2, sc(p)));
  for (const { path } of A.lines || []) out.push(pen("penFine", 1, sc(path), 0.4));
  chCommit(out);
  yield* chNext();
  const eyes = Object.entries(SUBJECT.sketch || {}).filter(([k]) => /^eye/.test(k)).map(([, p]) => sc(p));
  for (const [px, py, r] of A.pupils || []) {
    const [cx, cy, R] = [px * S, py * S, r * S], dots = [];
    for (let k = 0; k < 16; k++) {
      const a = random(Math.PI * 2), q = random(0, 0.9) * R;
      const c = [0, 1.1, 2.2].map((d) => [cx + Math.cos(a + d) * q, cy + Math.sin(a + d) * q, 1]);
      if (!eyes.length || c.every(([x, y]) => eyes.some((poly) => wcInPoly(poly, x, y)))) dots.push({ tool: CH_TOOLS.penFine, weight: 1.2, points: c, curve: 0.5 });
    }
    chCommit(dots);
  }
  yield* chNext();
  const white = [];
  for (const [x, y, r] of A.catchlights || []) {
    const [cx, cy, R] = [x * S, y * S, Math.max(0.9, Math.min(r, 3.2) * S)];
    white.push({ tool: CH_TOOLS.gouache, weight: R * 1.3, curve: 0.5, points: [[cx - R * 0.35, cy, 1], [cx, cy, 1.1], [cx + R * 0.35, cy, 1]] });
  }
  for (const { path } of A.lights || []) white.push({ tool: CH_TOOLS.gouache, weight: 0.9, curve: 0.6, points: sc(path).map(([x, y]) => [x, y, 0.9]) });
  chCommit(white);
  yield* chNext();
}

function* inkDrawing() {
  const T = chT, labels = WCM.masses.map((_, k) => k + 1), dark = darkBackdrop();
  const within = (...rs) => (x, y) => rs.includes(chGrid(chRegion, x, y));
  const ofKind = (...ks) => labels.filter((l) => ks.includes(chKinds[l]));
  const skins = ofKind("skin"), hairs = ofKind("hair"), crisps = ofKind("crisp"), softs = ofKind("soft");
  const scaled = (...ls) => constrain(ls.reduce((n, l) => n + WCM.masses[l - 1].cells.length, 0) / 22000, 1, 5);
  const toned = (where, v) => (x, y) => where(x, y) && chGrid(T, x, y) < v;
  const inner = (...ls) => {
    const m = blurChannel(Float32Array.from(chRegion, (v) => (ls.includes(v) ? 1 : 0)), 4);
    return (x, y) => chGrid(m, x, y) > 0.93;
  };

  // 1. A light pencil drawing
  yield* chBlockIn();

  // 2. The solid blacks first, along the flow: they set the scale for every grey after them
  const longs = [...hairs, ...crisps];
  if (longs.length) yield* chWork({ tool: "sable", squint: 2, looks: 3, marks: 60 * scaled(...longs), length: [40, 150], step: 12, dir: "flow", weight: 1, where: toned(inner(...longs), 0.13), tol: 0.3, gives: 0.4, commitment: 0.8 });
  if (softs.length) yield* chWork({ tool: "sable", squint: 3, looks: 3, marks: 50 * scaled(...softs), length: [30, 110], step: 12, dir: "form", weight: 0.9, where: toned(inner(...softs), 0.1), tol: 0.3, gives: 0.4, commitment: 0.8 });

  // 3. The ground, ruled in with the wrist and crossed until it is dark enough
  if (dark) {
    const inside = within(0);
    yield* inLines({ field: inField(0, 8, 0), spacing: 3, where: inside, wanted: T, squint: 6, reach: [140, 360], pressure: [0.9, 2] });
    yield* inLines({ field: inField(1.2, 8, 0), spacing: 3, where: inside, wanted: T, squint: 6, reach: [120, 300], pressure: [0.7, 2] });
    yield* inLines({ field: inField(-0.4, 8, 0), spacing: 2.8, where: inside, wanted: T, squint: 6, reach: [80, 220], pressure: [0.6, 2] });
  } else {
    yield* inLines({ field: inField(0, 8, 0), spacing: 7, where: within(0), wanted: T, squint: 8, tol: 0.015, reach: [60, 180], pressure: [0.4, 1] });
  }

  // 4. Long shapes: lines along the flow, closer and closer, never hatched across
  const form = inField(0, 3);
  for (const [spacing, pressure, reach] of [[4.2, [0.5, 2], [70, 220]], [3, [0.45, 2], [60, 190]], [2.4, [0.4, 2], [40, 150]]]) {
    if (longs.length) yield* inLines({ field: form, spacing, where: within(...longs), wanted: T, squint: 2.5, tol: 0.025, reach, pressure });
  }
  // only the deepest of them take a set at a slight angle
  if (longs.length) yield* inLines({ field: inField(0.32, 3), spacing: 3, where: toned(within(...longs), 0.5), wanted: T, squint: 2.5, tol: 0.03, reach: [30, 100], pressure: [0.4, 2] });

  // 5. Soft cloth: along the form, then crossed
  if (softs.length) {
    const where = within(...softs);
    yield* inLines({ field: form, spacing: 4.6, where, wanted: T, squint: 4, tol: 0.03, reach: [50, 170], pressure: [0.5, 1.5] });
    yield* inLines({ field: inField(1.05, 4), spacing: 4.2, where, wanted: T, squint: 4, tol: 0.035, reach: [40, 130], pressure: [0.45, 1.5] });
    yield* inLines({ field: inField(-0.55, 4), spacing: 3.4, where, wanted: T, squint: 4, tol: 0.04, reach: [30, 100], pressure: [0.4, 1.4] });
  }

  // 6. Skin: fine lines round the form, the fewest sets it can be done in. The lit side stays bare
  if (skins.length) {
    const where = within(...skins);
    yield* inLines({ field: inField(0, 4), spacing: 3, where, wanted: T, squint: 3, tol: 0.03, weight: 0.85, reach: [24, 90], pressure: [0.5, 1.8] });
    yield* inLines({ field: inField(0.8, 4), spacing: 3, where, wanted: T, squint: 3, tol: 0.05, weight: 0.85, reach: [18, 70], pressure: [0.5, 1.8] });
  }

  if (longs.length) yield* chWork({ tool: "gouache", squint: 2, looks: 3, marks: 26 * scaled(...longs), length: [24, 100], step: 8, dir: "flow", weight: 0.75, where: toned(within(...longs), 0.14), tol: -1, eager: 99, commitment: 1, gives: 0 });

  // 7. Features, contours, and the last marks
  yield* chCloseLook({ ink: true });
  yield* inContours();
  yield* inAccents();
  yield* chNext();
}

// ============================================================= pastel style
//
// Drawn the way a pastellist works on toned paper, from a box of sticks chosen for
// this sitter, looking back at the sheet after every pass:
//   sanguine drawing -> the ground -> each mass blocked in with the side of the stick ->
//   the skin rubbed together with a finger -> strokes with the edge of the stick, wherever
//   the sheet still disagrees with the sitter -> pastel pencil in the features -> folds,
//   strands, accents, and last the lights, laid on top.
//
// One layer holds the pigment. The display shader lets the paper show from the valleys
// of its tooth, so the grain belongs to the sheet and not to dots in each stroke.
// Pastel covers, so a stroke can correct in either direction: its colour is taken a
// little past the target, because one pass moves the sheet only part of the way.

let pcTarget, pcBox = [], pcBoxLab = [], pcCache = new Map(), pcPaperRGB;

Object.assign(CH_TOOLS, {
  pcSide:   { brush: "pcSide", layer: "stick", colour: "#808080", radius: 14, gives: 0.05 },
  pcFinger: { brush: "rub", layer: "stick", colour: "#808080", radius: 10, gives: 0.05 },
  pcEdge:   { brush: "pcEdge", layer: "stick", colour: "#808080", radius: 5, gives: 0.08 },
  pcPoint:  { brush: "pcPoint", layer: "stick", colour: "#808080", radius: 2, gives: 0.1 },
});

const PC_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSmudge;
uniform sampler2D uStick;
uniform sampler2D uTooth;
uniform vec3 uPaper;
uniform vec3 uCharcoal;
void main() {
  float height = 0.5 * (texture(uTooth, vUV * 0.8).r + texture(uTooth, vUV * 0.8 + 0.37).r);
  vec3 pigment = texture(uStick, vUV).rgb;
  // pigment sits on the hills: the deepest valleys still show the paper, and hills catch light
  float valley = smoothstep(0.5, 0.26, height);
  vec3 sheet = mix(pigment, uPaper, valley * 0.2);
  outColor = vec4(sheet * (0.96 + 0.08 * height), 1.0);
}`;

// a darker sheet under a dark ground, so that its bare margin doesn't glare
function pcPaper() {
  if (SUBJECT.palette?.pastelPaper) return color(SUBJECT.palette.pastelPaper);
  return color(darkBackdrop() ? "#8f8373" : C.pastelPaper);
}

function pastelTools() {
  const u = CH_U;
  // the side of a stick dragged flat: a band of uneven pigment
  brush.add("pcSide", {
    type: "custom", weight: 42 * u, scatter: 1 * u, opacity: 70, spacing: 2.4 * u,
    pressure: [0.85, 1.05, 0.7], rotate: "natural", markerTip: false, noise: 0.8,
    tip: (t) => {
      t.noStroke();
      for (let i = 0; i < 120; i++) {
        const y = random(-48, 48), edge = 1 - Math.pow(Math.abs(y) / 50, 3);
        t.fill(0, 50 + 190 * edge * random());
        t.rect(random(-7, -2), y, random(6, 13), random(0.8, 3.6));
      }
    },
  });
  // the edge of the stick: a short, full, slightly broken mark
  brush.add("pcEdge", {
    type: "custom", weight: 11 * u, scatter: 0.25 * u, opacity: 120, spacing: 0.8 * u,
    pressure: [0.6, 1.1, 0.55], rotate: "natural", markerTip: false, noise: 0.6,
    tip: (t) => {
      t.noStroke();
      for (let i = 0; i < 64; i++) {
        const y = random(-46, 46), edge = 1 - Math.pow(Math.abs(y) / 48, 4);
        t.fill(0, 50 + 170 * edge * random());
        t.rect(random(-10, -3), y, random(6, 16), random(1, 4));
      }
    },
  });
  // a pastel pencil
  brush.add("pcPoint", {
    type: "custom", weight: 2.4, scatter: 0.25, opacity: 150, spacing: 0.3,
    pressure: [0.55, 1.05, 0.45], rotate: "none", markerTip: false, noise: 0.4,
    tip: (t) => { t.noStroke(); t.fill(0); t.circle(0, 0, 82); },
  });
}

function pastelSetup() {
  pastelTools();
  const N = GW * GH, paper = pcPaper(), dark = darkBackdrop();
  pcPaperRGB = [red(paper), green(paper), blue(paper)];
  chStick.begin();
  background(paper);
  chStick.end();

  // what the sheet should say: the sitter's colour, a little richer, with the texture of
  // the mass away from the features; the figure runs out into the paper at the bottom
  const out = [0, 1, 2].map(() => new Float32Array(N));
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, X = x * G, Y = y * G, label = chRegion[i], kind = chKinds[label], f = finish(X, Y);
    let c, fade;
    if (label === chMargin) { c = pcPaperRGB; fade = 1; }
    else if (label === 0) {
      c = at(WCM.colour, i);
      // a pale wall is broken colour over the paper; a dark one is laid in nearly solid
      if (dark) { c = c.map((v) => v * 0.9 + 10); fade = chSmooth(0.5, 0, f) * 0.95; }
      else { c = c.map((v, k) => v * 0.72 + pcPaperRGB[k] * 0.28); fade = chSmooth(0.5, 0, f); }
    } else {
      const near = kind === "hair" || kind === "crisp" ? 0.6 : chSmooth(0.3, 0.75, chFocus[i]);
      const w = SUBJECT.watercolour?.textureBlur === undefined ? near : near * 0.6;
      c = [0, 1, 2].map((k) => WCM.colour[k][i] * (1 - w) + ref.mid[k][i] * w);
      const m = (c[0] + c[1] + c[2]) / 3;
      c = c.map((v) => constrain(m + (v - m) * 1.08, 0, 255));
      fade = chSmooth(0.6, 0, f);
    }
    for (let k = 0; k < 3; k++) out[k][i] = (c[k] * (1 - fade) + pcPaperRGB[k] * fade) / 255;
  }
  pcTarget = out;

  // the box: the colours this sitter needs, so that the picture holds together
  const samples = [];
  for (let i = 0; i < N; i += 5) if (chRegion[i] < chMargin) samples.push(wcLab([out[0][i] * 255, out[1][i] * 255, out[2][i] * 255]));
  const K = 44, centres = [];
  samples.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < K; k++) centres.push(samples[Math.floor((k + 0.5) / K * samples.length)].slice());
  for (let it = 0; it < 10; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const p of samples) { const s = sum[pcNearest(p, centres)]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; }
    sum.forEach((s, j) => { if (s[3]) centres[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  // the box keeps its lightest lights, which a mean would lose
  for (let k = 0; k < 6; k++) centres.push(samples[Math.floor(samples.length * (0.992 - k * 0.012))].slice());
  pcBoxLab = centres;
  // Lab back to a stick's colour: the mean of the cells nearest it
  const rgb = centres.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < N; i += 3) {
    if (chRegion[i] >= chMargin) continue;
    const c = [out[0][i] * 255, out[1][i] * 255, out[2][i] * 255], s = rgb[pcNearest(wcLab(c), centres)];
    s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++;
  }
  pcBox = rgb.map((s) => `rgb(${Math.round(s[0] / Math.max(1, s[3]))},${Math.round(s[1] / Math.max(1, s[3]))},${Math.round(s[2] / Math.max(1, s[3]))})`);
}

function pcNearest(lab, centres) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < centres.length; j++) {
    const c = centres[j], d = (lab[0] - c[0]) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

// the nearest stick to a colour; quantised lookups, since this runs for every stroke
function pcStick(rgb) {
  const key = (rgb[0] >> 3) << 10 | (rgb[1] >> 3) << 5 | rgb[2] >> 3;
  let j = pcCache.get(key);
  if (j === undefined) { j = pcNearest(wcLab([(rgb[0] >> 3) * 8 + 4, (rgb[1] >> 3) * 8 + 4, (rgb[2] >> 3) * 8 + 4]), pcBoxLab); pcCache.set(key, j); }
  return pcBox[j];
}

// the sheet on the grid, in colour
function pcLook() {
  chStick.loadPixels();
  const b = chStick.pixels, d = pixelDensity(), s = G * d, row = W * d, N = GW * GH;
  const out = [0, 1, 2].map(() => new Float32Array(N));
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const c = [0, 0, 0];
    for (let o = 0; o < 4; o++) {
      const i = 4 * ((gy * s + (o >> 1) * d) * row + gx * s + (o & 1) * d);
      c[0] += b[i]; c[1] += b[i + 1]; c[2] += b[i + 2];
    }
    const g = gy * GW + gx;
    out[0][g] = c[0] / 1020; out[1][g] = c[1] / 1020; out[2][g] = c[2] / 1020;
  }
  return out;
}

// one look-and-correct pass. Marks land where the sheet is furthest from the sitter and
// don't cross a change of value or of mass, so a stroke of one colour stays on its own passage.
function* pcWork(o) {
  const tool = CH_TOOLS[o.tool], radius = o.squint * CH_U / G, way = chWays[o.dir ?? "form"], tol = o.tol ?? 0.04, push = o.push ?? 0.45;
  const wanted = pcTarget.map((c) => chWithinBlur(c, radius));
  const value = wanted[0].map((v, i) => 0.3 * v + 0.59 * wanted[1][i] + 0.11 * wanted[2][i]);
  for (let look = 0; look < o.looks; look++) {
    const seen = pcLook().map((c) => chWithinBlur(c, radius));
    const need = new Float32Array(GW * GH);
    for (let i = 0; i < need.length; i++) {
      const dr = seen[0][i] - wanted[0][i], dg = seen[1][i] - wanted[1][i], db = seen[2][i] - wanted[2][i];
      need[i] = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.5 + db * db * 0.2);
    }
    const strokes = [];
    let tries = 0;
    while (strokes.length < o.marks && tries < o.marks * 300) {
      tries++;
      const x = random(W), y = random(H), n = chGrid(need, x, y);
      if (n < tol || random() > n * (o.eager ?? 6)) continue;
      if (!o.where(x, y)) continue;
      const here = chGrid(value, x, y), label = chGrid(chRegion, x, y);
      const stays = (px, py) => o.where(px, py) && chGrid(chRegion, px, py) === label && Math.abs(chGrid(value, px, py) - here) < (o.range ?? 0.12);
      const length = random(o.length[0], o.length[1]) * CH_U;
      const pts = chTrace(x, y, length, (o.step ?? Math.max(5, o.length[1] / 5)) * CH_U, way, need, tol * 0.5, o.pressure ?? 1, stays, o.commitment ?? 0.4);
      if (pts.length < 2) continue;
      const c = [0, 1, 2].map((k) => { const w = chGrid(wanted[k], x, y); return constrain((w + (w - chGrid(seen[k], x, y)) * push) * 255, 0, 255); });
      strokes.push({ tool, points: pts, weight: (o.weight ?? 1) * random(0.85, 1.1), colour: pcStick(c), curve: o.curve });
      chCredit(need, pts, (o.creditRadius ?? tool.radius) * (o.weight ?? 1) * CH_U, o.gives ?? tool.gives);
    }
    if (!strokes.length) break;
    strokes.sort((a, b) => (a.colour < b.colour ? -1 : 1));
    // in small batches, so that a recording has frames to show
    while (strokes.length) { chCommit(strokes.splice(0, 30)); yield* chNext(); }
  }
}

// the features from a close view of the photo, in colour, with the pencil
function* pcCloseLook() {
  wcFineGrid();
  const F = WCM.fine, blur = SUBJECT.watercolour?.featureBlur ?? 2;
  const views = FOCAL.map(([cx, cy, rx, ry]) => {
    const x0 = Math.max(0, Math.floor((cx - rx * 1.1) * 2)), x1 = Math.min(F.w - 1, Math.ceil((cx + rx * 1.1) * 2));
    const y0 = Math.max(0, Math.floor((cy - ry * 1.1) * 2)), y1 = Math.min(F.h - 1, Math.ceil((cy + ry * 1.1) * 2));
    const w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;
    const rgb = [0, 1, 2].map((k) => {
      const c = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = F.data[((y + y0) * F.w + x + x0) * 4 + k];
      return wcBoxBlur(c, w, h, blur);
    });
    const L = rgb[0].map((v, i) => 0.3 * v + 0.59 * rgb[1][i] + 0.11 * rgb[2][i]);
    const gx = new Float32Array(n), gy = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = L[i + 1] - L[i - 1]; gy[i] = L[i + w] - L[i - w]; }
    const a = wcBoxBlur(gx.map((v) => v * v), w, h, 3), b = wcBoxBlur(gy.map((v) => v * v), w, h, 3), c = wcBoxBlur(gx.map((v, i) => v * gy[i]), w, h, 3);
    const along = a.map((v, i) => 0.5 * Math.atan2(2 * c[i], v - b[i]) + Math.PI / 2);
    const fade = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = (x + x0) / 2, Y = (y + y0) / 2, label = chGrid(chRegion, X, Y);
      fade[y * w + x] = label === 0 || label === chMargin ? 0 : 1 - chSmooth(0.7, 1, Math.hypot((X - cx) / rx, (Y - cy) / ry));
    }
    return { x0, y0, w, h, n, rgb, along, fade };
  });
  for (let round = 0; round < 8; round++) {
    chStick.loadPixels();
    const B = chStick.pixels;
    for (const v of views) {
      const seen = [0, 1, 2].map((k) => {
        const c = new Float32Array(v.n);
        for (let y = 0; y < v.h; y++) for (let x = 0; x < v.w; x++) c[y * v.w + x] = B[((y + v.y0) * F.w + x + v.x0) * 4 + k];
        return wcBoxBlur(c, v.w, v.h, blur);
      });
      const need = new Float32Array(v.n);
      for (let i = 0; i < v.n; i++) {
        const dr = seen[0][i] - v.rgb[0][i], dg = seen[1][i] - v.rgb[1][i], db = seen[2][i] - v.rgb[2][i];
        need[i] = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.5 + db * db * 0.2) / 255 * v.fade[i];
      }
      const strokes = [], cap = Math.round(v.n / 34), tol = 0.04;
      for (let tries = 0, made = 0; tries < cap * 60 && made < cap; tries++) {
        const sx = Math.floor(random(v.w)), sy = Math.floor(random(v.h)), start = sy * v.w + sx, n0 = need[start];
        if (n0 < tol || random() > n0 * 6) continue;
        const pts = [[(sx + v.x0) / 2, (sy + v.y0) / 2, 0.9]], len = random(3, 10);
        let x = sx, y = sy, ang = v.along[start] + (random() < 0.5 ? Math.PI : 0);
        for (let went = 0; went < len; went += 1.2) {
          x += Math.cos(ang) * 2.4; y += Math.sin(ang) * 2.4;
          if (x < 1 || y < 1 || x >= v.w - 1 || y >= v.h - 1) break;
          const i = Math.floor(y) * v.w + Math.floor(x);
          if (need[i] < tol * 0.6) break;
          let next = v.along[i];
          if (Math.cos(next - ang) < 0) next += Math.PI;
          ang += Math.atan2(Math.sin(next - ang), Math.cos(next - ang)) * 0.5;
          pts.push([(x + v.x0) / 2, (y + v.y0) / 2, 0.8 + Math.min(0.5, need[i] * 1.5)]);
        }
        if (pts.length < 2) continue;
        const c = [0, 1, 2].map((k) => constrain(v.rgb[k][start] + (v.rgb[k][start] - seen[k][start]) * 0.5, 0, 255));
        strokes.push({ tool: CH_TOOLS.pcPoint, weight: 0.9, points: pts, colour: `rgb(${c.map(Math.round).join(",")})` });
        for (const [px, py] of pts) {
          const gx = Math.round(px * 2 - v.x0), gy = Math.round(py * 2 - v.y0);
          for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
            const i = (gy + b) * v.w + gx + a;
            if (gx + a >= 0 && gx + a < v.w && gy + b >= 0 && gy + b < v.h) need[i] -= 0.05;
          }
        }
        made++;
      }
      if (strokes.length) chCommit(strokes);
    }
    yield* chNext();
  }
}

// the few measured marks, then the lights: the one thing pastel can do that paint on
// white paper can't is put light over dark, and it saves that for the end
function* pcAccents() {
  const A = SUBJECT.accents || {}, out = [];
  const darkest = (line) => {
    let best = [60, 40, 36], bl = Infinity;
    for (const [x, y] of line) { const c = sampleAt(ref.mid, x, y), l = c[0] + c[1] + c[2]; if (l < bl) { bl = l; best = c; } }
    return `rgb(${best.map((v) => Math.round(v * 0.7)).join(",")})`;
  };
  const mark = (line, weight, colour) => ({ tool: CH_TOOLS.pcPoint, weight, colour, curve: 0.6, points: line.map(([x, y, p = 1]) => [x + random(-0.3, 0.3), y + random(-0.3, 0.3), 0.6 + p * 0.6]) });
  for (const p of [...(A.lashes || []), ...(A.nostrils || []), ...(A.mouth || [])]) out.push(mark(sc(p), 0.8, darkest(sc(p))));
  for (const { path, colour, weight } of A.lines || []) out.push(mark(sc(path), (weight ?? 0.8) * 0.8, colour ?? darkest(sc(path))));
  for (const [px, py, r] of A.pupils || []) {
    const [cx, cy, R] = [px * S, py * S, r * S];
    for (let k = 0; k < 6; k++) {
      const a = random(Math.PI * 2), q = random(0, 0.5) * R;
      out.push(mark([[cx + Math.cos(a) * q, cy + Math.sin(a) * q], [cx - Math.cos(a) * q, cy - Math.sin(a) * q]], Math.max(0.8, R * 0.5), "rgb(26,20,22)"));
    }
  }
  chCommit(out);
  yield* chNext();
  const lights = [];
  for (const { path, colour } of A.lights || []) lights.push(mark(sc(path), 1, colour ?? "#f4eee4"));
  for (const [x, y, r] of A.catchlights || []) {
    const [cx, cy, R] = [x * S, y * S, Math.max(0.9, Math.min(r, 3.2) * S)];
    lights.push(mark([[cx - R * 0.3, cy], [cx + R * 0.3, cy]], R * 0.9, "#fbf7ef"));
  }
  chCommit(lights);
  yield* chNext();
}

function* pastel() {
  const labels = WCM.masses.map((_, k) => k + 1), dark = darkBackdrop();
  const within = (...rs) => (x, y) => rs.includes(chGrid(chRegion, x, y));
  const ofKind = (...ks) => labels.filter((l) => ks.includes(chKinds[l]));
  const skins = ofKind("skin"), hairs = ofKind("hair"), crisps = ofKind("crisp"), softs = ofKind("soft");
  const scaled = (...ls) => constrain(ls.reduce((n, l) => n + WCM.masses[l - 1].cells.length, 0) / 22000, 1, 5);
  const figure = (x, y) => { const l = chGrid(chRegion, x, y); return l > 0 && l < chMargin; };
  const focus = (level) => (x, y) => figure(x, y) && chGrid(chFocus, x, y) > level;

  // 1. A loose drawing in sanguine, quiet, and none of it where the sheet stays bare
  const sanguine = `rgb(${[138, 70, 48].map((v, k) => Math.round(v * 0.5 + pcPaperRGB[k] * 0.5)).join(",")})`;
  for (const line of Object.values(SUBJECT.sketch || {})) {
    const points = sc(line).filter(([x, y]) => finish(x, y) > 0.45);
    if (points.length < 2) continue;
    chCommit([{ tool: CH_TOOLS.pcPoint, weight: 0.32, colour: sanguine, curve: 0.7, points: points.map(([x, y]) => [x + random(-1.5, 1.5), y + random(-1.5, 1.5), random(0.6, 1)]) }]);
    yield* chNext();
  }

  // 2. The ground, all with the wrist: it cuts out the silhouette
  const ground = within(0);
  if (dark) {
    yield* pcWork({ tool: "pcSide", squint: 22, looks: 8, marks: 110, length: [90, 260], step: 22, dir: "wrist", where: ground, tol: 0.03, range: 0.5, gives: 0.03, creditRadius: 16 });
    yield* pcWork({ tool: "pcEdge", squint: 10, looks: 6, marks: 200, length: [40, 120], dir: "wrist", weight: 1.3, where: ground, tol: 0.03, range: 0.5, gives: 0.05 });
    yield* pcWork({ tool: "pcEdge", squint: 5, looks: 5, marks: 240, length: [24, 80], dir: "wrist", weight: 1.1, where: ground, tol: 0.035, range: 0.5, gives: 0.06, push: 0.7 });
  } else {
    yield* pcWork({ tool: "pcSide", squint: 24, looks: 6, marks: 70, length: [90, 240], step: 22, dir: "wrist", where: ground, tol: 0.03, range: 0.5, gives: 0.03, creditRadius: 18 });
  }

  // 3. The masses with the side of the stick, darkest first, so lights go over them
  for (const l of [...hairs, ...crisps, ...softs, ...skins]) {
    const dir = chKinds[l] === "skin" || chKinds[l] === "soft" ? "form" : "flow";
    yield* pcWork({ tool: "pcSide", squint: 12, looks: 6, marks: 70 * scaled(l), length: [40, 130], step: 16, dir, where: within(l), tol: 0.035, range: 0.16, weight: 0.8, creditRadius: 12, gives: 0.04 });
    yield* pcWork({ tool: "pcSide", squint: 7, looks: 5, marks: 90 * scaled(l), length: [24, 80], step: 12, dir, where: within(l), tol: 0.035, range: 0.12, weight: 0.42, creditRadius: 7, gives: 0.05 });
  }

  // 4. The skin rubbed together with a finger, as far as the features
  for (const l of skins) {
    yield* pcWork({ tool: "pcFinger", squint: 10, looks: 6, marks: 90, length: [16, 44], step: 7, where: within(l), tol: 0.025, range: 0.09, weight: 0.3, push: 0.1, creditRadius: 9, gives: 0.03 });
    yield* pcWork({ tool: "pcFinger", squint: 5, looks: 6, marks: 110, length: [10, 28], step: 5, where: within(l), tol: 0.03, range: 0.07, weight: 0.16, push: 0.1, creditRadius: 5, gives: 0.04 });
  }

  // 5. The edge of the stick over everything: this is what shows as pastel
  const longs = [...hairs, ...crisps];
  if (longs.length) yield* pcWork({ tool: "pcEdge", squint: 4, looks: 10, marks: 150 * scaled(...longs), length: [50, 170], step: 12, dir: "flow", where: within(...longs), tol: 0.035, range: 0.12, weight: 0.9, commitment: 0.7, gives: 0.06 });
  if (softs.length) yield* pcWork({ tool: "pcEdge", squint: 6, looks: 8, marks: 110 * scaled(...softs), length: [40, 130], step: 12, dir: "form", where: within(...softs), tol: 0.035, range: 0.12, weight: 1, commitment: 0.6, gives: 0.06 });
  for (const l of skins) yield* pcWork({ tool: "pcEdge", squint: 4, looks: 9, marks: 120, length: [14, 46], step: 6, dir: "wrist", where: within(l), tol: 0.035, range: 0.08, weight: 0.55, creditRadius: 5, gives: 0.08 });

  // the seams between masses, which every stroke stayed inside of, still show paper
  const seam = blurChannel(Float32Array.from(chRegion, (v, i) => {
    const r = i % GW < GW - 1 ? chRegion[i + 1] : v, d = i < chRegion.length - GW ? chRegion[i + GW] : v;
    return v < chMargin && ((r !== v && r < chMargin) || (d !== v && d < chMargin)) ? 1 : 0;
  }), 2);
  const onSeam = (x, y) => chGrid(chRegion, x, y) < chMargin && chGrid(seam, x, y) > 0.03;
  yield* pcWork({ tool: "pcFinger", squint: 2, looks: 6, marks: 220, length: [8, 28], step: 4, dir: "flow", where: onSeam, tol: 0.05, range: 0.1, weight: 0.13, push: 0.2, creditRadius: 3, gives: 0.12, eager: 12 });

  // 6. Smaller as the eye comes in
  yield* pcWork({ tool: "pcEdge", squint: 2.5, looks: 8, marks: 110, length: [8, 24], step: 4, dir: "flow", where: focus(0.4), tol: 0.04, range: 0.1, weight: 0.3, creditRadius: 3, gives: 0.1 });
  yield* pcCloseLook();

  // 7. Folds and strands with the pencil, dark and light, along the shape
  if (longs.length) yield* pcWork({ tool: "pcPoint", squint: 1.5, looks: 8, marks: 110 * scaled(...longs), length: [40, 170], step: 10, dir: "flow", where: within(...longs), tol: 0.05, range: 0.1, weight: 1, commitment: 0.75, push: 0.8, gives: 0.09 });

  // 8. The last marks, and the lights over everything
  const lit = (x, y) => figure(x, y) && 0.3 * chGrid(pcTarget[0], x, y) + 0.59 * chGrid(pcTarget[1], x, y) + 0.11 * chGrid(pcTarget[2], x, y) > 0.62;
  yield* pcWork({ tool: "pcEdge", squint: 3, looks: 7, marks: 120, length: [14, 50], step: 6, dir: "flow", where: lit, tol: 0.03, range: 0.14, weight: 0.5, push: 1.2, creditRadius: 3, gives: 0.09 });
  yield* pcAccents();
  yield* chNext();
}

// how far each mass is from the target, in levels of 255
function pcReport() {
  const seen = pcLook().map((c) => chWithinBlur(c, 2)), want = pcTarget.map((c) => chWithinBlur(c, 2));
  const report = { looks: chLooks, marks: chMarks };
  const row = (name, test) => {
    let n = 0, sq = 0, sum = 0;
    for (let i = 0; i < seen[0].length; i++) if (test(i)) {
      const dr = seen[0][i] - want[0][i], dg = seen[1][i] - want[1][i], db = seen[2][i] - want[2][i];
      sq += (dr * dr + dg * dg + db * db) / 3; sum += (dr + dg + db) / 3; n++;
    }
    if (n) report[name] = { lighterBy: +(sum / n * 255).toFixed(1), rms: +(Math.sqrt(sq / n) * 255).toFixed(1) };
  };
  row("ground", (i) => chRegion[i] === 0);
  WCM.masses.forEach((m, k) => row(m.name, (i) => chRegion[i] === k + 1));
  return report;
}

// ------------------------------------------------------------- sketch

let steps;

// each style: the colour of its bare paper and the generator that makes it
const SHEET_STYLES = ["charcoal", "ink", "pastel"];   // drawn on layers and shown through a shader
const STYLES = {
  oil: { paper: () => C.ground, run: () => painting() },
  charcoal: { paper: () => C.paper, run: () => charcoal() },
  watercolour: { paper: () => color(...WC_PAPER), run: () => watercolour() },
  ink: { paper: () => C.inkPaper, run: () => inkDrawing() },
  pastel: { paper: () => pcPaper(), run: () => pastel() },
};

async function setup() {
  // ?seed=5 tries another attempt at the same painting
  const seedParam = new URLSearchParams(location.search).get("seed");
  if (seedParam !== null) SUBJECT.seed = Number(seedParam);
  // read the photo first: the canvas takes its proportions from it
  const base = await loadReference(SUBJECT.image);
  H = Math.round(W * GH / GW);
  S = W / SUBJECT.refWidth;
  FOCAL = SUBJECT.focal.map(([x, y, rx, ry]) => [x * S, y * S, rx * S, ry * S]);

  if (SHEET_STYLES.includes(STYLE)) pixelDensity(2);   // their layers and tooth need one density throughout
  createCanvas(W, H, WEBGL);
  pixelDensity(2);
  angleMode(DEGREES);
  randomSeed(SUBJECT.seed ?? 17);
  noiseSeed(SUBJECT.seed ?? 17);
  const style = STYLES[STYLE] || STYLES.oil;
  background(style.paper());
  brush.scaleBrushes(2);

  // flat bristle brushes: a row of hairs across the stroke, loaded at the
  // start and running dry towards the end
  brush.add("bristle", {
    type: "custom", weight: 10, scatter: 0.05, opacity: 235, spacing: 0.25,
    pressure: [1.15, 1, 0.55], rotate: "natural", markerTip: false, noise: 0.4,
    tip: (m) => {
      m.noStroke();
      m.fill(0);
      for (let i = 0; i < 22; i++) m.rect(-6, -46 + i * 4.3 + random(-1.5, 1.5), 12, random(2.5, 5));
    },
  });
  brush.add("dry", {
    type: "custom", weight: 10, scatter: 0.1, opacity: 150, spacing: 0.3,
    pressure: [1, 0.8, 0.4], rotate: "natural", markerTip: false, noise: 0.5,
    tip: (m) => {
      m.noStroke();
      m.fill(0);
      for (let i = 0; i < 11; i++) if (random() > 0.35) m.rect(-4, -45 + i * 9 + random(-3, 3), 8, random(1.5, 4));
    },
  });
  // a fine round liner for single hairs and accents
  brush.add("liner", {
    type: "custom", weight: 2.2, scatter: 0.02, opacity: 200, spacing: 0.3,
    pressure: [0.4, 1, 0.3], rotate: "none", markerTip: false, noise: 0.3,
    tip: (m) => { m.noStroke(); m.fill(0); m.circle(0, 0, 70); },
  });

  ref = {
    squint: blurRGB(base, 7),
    soft: blurRGB(base, 3),
    mid: blurRGB(base, 1),
    sharp: base,
  };
  tensor = structureTensor(lum(blurRGB(base, 2)), 6);
  figureMask();
  if (STYLE !== "oil") {
    flow = structureTensor(lum(blurRGB(ref.sharp, 3)), 14);
  }
  if (STYLE === "watercolour" || SHEET_STYLES.includes(STYLE)) wcLook();
  edges = edgeField(lum(ref.mid));
  // while recording, only the capture script advances a frame: p5's own loop would
  // paint frames that nobody captures
  if (RECORD) noLoop();
  if (SHEET_STYLES.includes(STYLE)) chSetup();
  if (STYLE === "ink") inkSetup();
  if (STYLE === "pastel") pastelSetup();
  steps = style.run();
}

function painted() {
  window.__painted = true;
  noLoop();
}

function draw() {
  if (!steps || (RECORD && !window.__stepping)) return;
  if (SHEET_STYLES.includes(STYLE)) return chFrame();
  // brush coordinates follow p5's WEBGL origin (centre); shift to top-left
  translate(-W / 2, -H / 2);
  if (steps.next().done) painted();
}

function keyPressed() {
  if (key === "s") saveCanvas("portrait", "png");
}
