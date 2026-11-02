// Everything painter.js needs to know about one sitter.
//
// Coordinates are in reference units: the photo scaled so its width is
// refWidth (height follows the photo's proportions). Measure them on the
// gridded crops that scripts/measure.py makes, using the same refWidth.
//
// This example is filled in for Vermeer's Girl with a Pearl Earring (c. 1665,
// public domain; 1920 x 2274): head turned over the shoulder against a
// near-black backdrop, blue and yellow turban whose cloth falls behind her,
// ochre coat, white collar. Replace every value for a new sitter.

// points round an ellipse, from angle a0 to a1 in degrees (y down), for
// accents.lines such as glasses rims
const ring = (cx, cy, rx, ry, a0 = 0, a1 = 360, step = 12) => {
  const pts = [];
  for (let a = a0; a <= a1; a += step) pts.push([cx + rx * Math.cos(a * Math.PI / 180), cy + ry * Math.sin(a * Math.PI / 180)]);
  return pts;
};

// Optional, and only needed for a sitter like this one. The engine masses dark
// hair; with none to anchor them the drawn styles mass the dark blue of the
// turban instead. For a sitter with dark hair, delete these two lines, use one
// hair.maxLum and one backdrop shade, and delete the block at the end of the file.
const STYLE_PARAM = new URLSearchParams(location.search).get("style");
const DRAWN = ["charcoal", "ink"].includes(STYLE_PARAM);

const SUBJECT = {
  image: "girl-with-a-pearl-earring.jpg",
  refWidth: 1000,
  seed: 31,
  // "oil" (default), "charcoal", "watercolour", "ink" or "pastel";
  // ?style=charcoal in the page URL overrides it
  style: "oil",

  // Where attention goes, as [centreX, centreY, sigmaX, sigmaY].
  // face: centred between the eyes and the mouth, sigma ~ half the face's
  //       width and height. head: a wider, softer zone around the whole head.
  attention: {
    face: [440, 530, 150, 180],
    head: [570, 520, 340, 360],
  },

  // Ellipses [centreX, centreY, radiusX, radiusY] where the finest work goes:
  // each eye, each brow, the nose, the mouth. She has almost no brows; the
  // pearl earns a place of its own.
  focal: [
    [345, 445, 34, 22], [460, 467, 42, 24],     // eyes
    [385, 530, 45, 55],                         // nose
    [390, 628, 55, 32],                         // mouth
    [625, 648, 28, 32],                         // pearl
  ],

  // The backdrop is painted, not copied. detect: which photo colours count as
  // backdrop. colours: two tones it drifts between, plus a darker one for the
  // shade behind the head. shade: [cx, cy, sx, sy] of that shade.
  // For a light, neutral wall: detect { minBrightness: 200, maxChroma: 22 }.
  // This backdrop is a warm near-black, so maxChroma is wide. figure is a
  // polygon a little inside the silhouette, inside which nothing counts as
  // backdrop: the shadows in the coat are as dark as the backdrop.
  backdrop: {
    detect: { minBrightness: -1, maxBrightness: 62, maxChroma: 44 },
    colours: [[46, 42, 32], [38, 32, 24], STYLE_PARAM === "watercolour" ? [124, 104, 86] : [24, 22, 18]],
    shade: [540, 540, 420, 480],
    figure: [
      [340, 335], [385, 268], [445, 222], [505, 198], [555, 158], [620, 145], [688, 165], [752, 222],
      [795, 315], [843, 425], [872, 522], [902, 642], [932, 782], [945, 872], [880, 885], [858, 925],
      [790, 935], [800, 1005], [815, 1184], [310, 1184], [358, 1045], [418, 905], [458, 825], [482, 762],
      [492, 722], [440, 692], [400, 692], [366, 672], [345, 630], [346, 590], [342, 560], [322, 500],
      [324, 430], [334, 372],
    ],
  },

  // How far up the bottom of the canvas stays unfinished (fraction of height).
  unfinishedBottom: 0.25,

  // Optional per-style settings. Watercolour finds its masses by colour; these are
  // named because her coat is close to the colour of skin.
  watercolour: {
    textureBlur: 3,       // the craquelure is not form
    featureBlur: 2,
    skinDetail: 0.55,     // raking light: the form turns sharply
    reserve: [[[622, 620], [640, 626], [651, 645], [647, 668], [628, 680], [608, 672], [601, 650], [606, 630]]],   // the pearl
    regions: [
      { name: "skin", kind: "skin", poly: [[330, 342], [355, 333], [400, 345], [440, 365], [480, 395], [520, 430], [560, 480], [600, 530], [630, 558], [650, 590], [660, 640], [690, 662], [650, 677], [600, 697], [545, 712], [480, 728], [472, 705], [430, 706], [400, 696], [370, 676], [352, 650], [335, 600], [328, 575], [318, 525], [315, 475], [322, 425], [318, 400]] },
      { name: "turban", kind: "crisp", split: 2, poly: [[330, 340], [350, 280], [400, 235], [450, 205], [500, 205], [550, 175], [600, 140], [650, 140], [700, 160], [740, 210], [775, 280], [800, 360], [820, 420], [845, 470], [860, 540], [880, 620], [900, 680], [920, 740], [940, 800], [950, 855], [945, 895], [875, 930], [778, 945], [770, 900], [760, 800], [758, 662], [690, 662], [660, 640], [650, 590], [630, 558], [600, 530], [560, 480], [520, 430], [480, 395], [440, 365], [400, 345], [355, 333]] },
      { name: "collar", kind: "crisp", poly: [[478, 728], [545, 710], [600, 695], [650, 675], [700, 665], [755, 662], [760, 695], [680, 700], [620, 708], [570, 732], [520, 748], [480, 772], [452, 825], [450, 800], [462, 765]] },
      { name: "coat", kind: "soft", poly: [[452, 825], [480, 772], [520, 748], [570, 732], [620, 708], [680, 700], [760, 695], [770, 900], [778, 945], [790, 990], [830, 1000], [850, 1100], [865, 1184], [300, 1184], [320, 1120], [350, 1050], [385, 980], [405, 930], [420, 880], [440, 840]] },
    ],
  },

  // Hair: only regions darker than maxLum get light strokes, tinted towards
  // `light`. For fair hair raise maxLum (e.g. 170) and pick a paler light.
  // Optional `areas: [[[x, y], ...]]`: polygons that are hair even where it
  // is lighter than maxLum, such as a wispy fringe over the forehead; here the
  // turban's band and the long folds of the cloth falling from it.
  // `flyaways`: a few stray strands off the silhouette, as paths.
  hair: {
    maxLum: DRAWN ? 85 : STYLE_PARAM === "watercolour" ? 40 : 55,
    light: [226, 196, 140],
    areas: [[[340, 335], [385, 268], [445, 222], [505, 198], [555, 158], [620, 145], [640, 230], [710, 300], [745, 400], [745, 480], [690, 565], [610, 505], [540, 435], [470, 378], [400, 345]], [[625, 150], [700, 170], [765, 225], [805, 320], [850, 425], [880, 525], [910, 645], [940, 785], [950, 875], [875, 890], [860, 930], [790, 940], [780, 850], [770, 700], [755, 530], [745, 400], [710, 300], [640, 230]]],
    flyaways: [],
  },

  // Underdrawing: loose contour paths. Names starting with eye/nose/mouth are
  // drawn once, everything else twice with a little jitter.
  sketch: {
    turbanTop: [[335, 340], [370, 270], [440, 215], [510, 190], [560, 150], [620, 135], [690, 155], [760, 215], [800, 310]],
    bandTop: [[500, 205], [600, 240], [700, 310], [745, 400], [745, 480], [690, 570]],
    bandLow: [[335, 340], [400, 345], [470, 380], [540, 440], [610, 510], [690, 570]],
    tailR: [[800, 310], [850, 420], [880, 520], [910, 640], [950, 800], [955, 880]],
    tailL: [[745, 400], [755, 530], [770, 700], [780, 850], [780, 940]],
    tailEnd: [[780, 940], [865, 930], [880, 890], [955, 880]],
    face: [[325, 370], [315, 430], [312, 500], [335, 560], [338, 590], [335, 630], [360, 680], [400, 702], [470, 700], [540, 680], [600, 640]],
    eyeL: [[322, 440], [338, 432], [355, 436], [365, 450], [345, 456], [328, 450], [322, 440]],
    eyeR: [[425, 462], [445, 452], [470, 452], [492, 470], [470, 484], [445, 478], [425, 462]],
    nose: [[395, 470], [402, 520], [412, 545], [410, 570], [385, 575], [360, 565], [350, 555]],
    mouth: [[350, 608], [385, 618], [432, 630]],
    lipU: [[350, 608], [365, 600], [385, 605], [420, 622], [432, 630]],
    lipL: [[352, 612], [358, 640], [385, 650], [415, 645], [432, 630]],
    ear: [[605, 550], [640, 540], [655, 560], [640, 590], [610, 598]],
    pearl: ring(625, 645, 24, 30),
    collar: [[450, 825], [480, 760], [500, 720], [600, 695], [680, 670], [760, 665], [765, 690], [640, 725], [530, 760], [450, 825]],
    shoulderL: [[450, 825], [410, 900], [350, 1040], [300, 1184]],
    shoulderR: [[780, 940], [830, 1010], [860, 1184]],
    coatFold: [[430, 1080], [470, 1025], [500, 1100]],
  },

  // Construction lines [x1, y1, x2, y2]: the centre line of the face and the
  // line through both eyes.
  construction: [
    [405, 340, 385, 700],
    [310, 435, 500, 475],
  ],

  // The few decisive last marks. Paths may carry pressure as a third value.
  accents: {
    // upper lash lines, kept light: Vermeer's eyes have none to speak of
    lashes: [
      [[326, 438, 0.2], [338, 432, 0.5], [355, 436, 0.5], [363, 446, 0.2]],
      [[432, 458, 0.2], [445, 452, 0.5], [470, 452, 0.55], [488, 466, 0.25]],
    ],
    pupils: [[349, 445, 5], [465, 468, 6]],          // [x, y, r]
    catchlights: [[342, 440, 2.2], [453, 461, 2.6], ...(STYLE_PARAM === "watercolour" || STYLE_PARAM === "charcoal" ? [[611, 639, 3]] : [])], // up and towards the light
    nostrils: [
      [[360, 562], [368, 566], [378, 566]],
      [[400, 568], [408, 568], [414, 562]],
    ],
    // the darkest parts of the line between the lips, at the corners
    mouth: [
      [[352, 609, 0.8], [368, 612, 0.7], [385, 618, 0.4]],
      [[405, 623, 0.4], [420, 627, 0.8], [432, 630, 0.5]],
    ],
    // optional thin lines the analysis loses, such as glasses; here the pearl's
    // shadowed rim
    lines: [
      ...(STYLE_PARAM === "watercolour" ? [] : [{ path: ring(625, 645, 24, 30, 10, 190), colour: "#6d6a66", weight: 0.7 }]),
    ],
    lights: [
      { path: [[376, 641], [388, 643], [400, 640]], colour: "#f7d8d0", brush: "bristle" },   // lower lip
      { path: [[606, 630], [611, 640], [615, 650]], colour: "#fbf8f0" },                     // the pearl
      { path: [[610, 668], [628, 672], [642, 664]], colour: "#cfcac0" },                     // the collar in the pearl
    ],
  },
};
