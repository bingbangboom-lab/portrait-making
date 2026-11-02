---
name: portrait-making
description: Paint a portrait of a person from a reference photo in JavaScript (p5.js 2.x + p5.brush 3.0.0), in one of five styles (oil, graphite/charcoal, watercolour, pen and ink, soft pastel), then render the process as an MP4 timeline video, optionally with background music. Use when the user gives a subject/reference image and asks for a painted, painterly, brush, pencil, graphite, charcoal, watercolour, ink, pen, pastel, crayon or sketched portrait, a portrait drawn with code, or a video/timelapse of a portrait being painted or drawn.
---

# Portrait making

You paint or draw a portrait of the person in a reference photo the way an
artist works — ground, underdrawing, block-in, form, focal detail, a few
decisive accents, edges left unfinished — using p5.brush, and then record the
process as a paced video.

Five styles are built in:

| Style | Look | Process in the engine |
|---|---|---|
| `oil` (default) | alla prima oil study, bristle brushwork, broken colour | toned ground → sienna underdrawing → bristle block-in → form strokes → focal detail → hair lights → accents |
| `charcoal` | graphite and charcoal drawing on warm paper, monochrome, on a dark or a pale ground | sheet toned with the rag → construction → the ground, which cuts out the silhouette → hair and cloth massed, stopping short of their value → the skin rubbed coarse to fine with matched stumps → the seams between masses → marks along the forms, which carry the rest of the value → compressed darks → lights lifted with the eraser → the features from a close view of the photo → strands, sheen, catchlights |
| `watercolour` | transparent washes on white paper, light to dark, wet edges, clean separate colours | pencil → a pale wall first, if there is one → the skin in many thin wet glazes → hair and each cloth as its own mass, lightest first → a dark ground late, if there is one → corrections where the painting is still lighter than the photo → rigger strands → the features, glazed from a close view of the photo → pupils, catchlights, a little spatter |
| `ink` | pen and ink on white, black only, like an engraving | light pencil → solid blacks with a sable, inside the masses → the ground ruled in and crossed, if it is dark → evenly spaced lines along the form, each set only where the sheet is still too light, each line swelling with the value → white cut back into the blacks → fine lines round the skin, the lit side left bare → the features from a close view of the photo → contours, lost and found → accents and white gouache |
| `pastel` | soft pastel on toned paper, broken colour, lights laid on top | a box of sticks chosen from the sitter → quiet sanguine drawing → the ground, broken or nearly solid → each mass with the side of the stick, darkest first → the skin rubbed with a finger → the edge of the stick wherever the sheet disagrees with the sitter → the seams closed → pastel pencil in the features, from a close view of the photo → folds and strands → the lights, over everything → accents |

The engine in `template/` already encodes the painting process and every hard
lesson about p5.brush. Your job per subject is to **study the photo and fill in
`subject.js`**, then paint, critique, adjust, record and render.

## 0. Ask first (one AskUserQuestion call, three questions)

1. **Style** — AskUserQuestion allows four options, so offer `Oil painting
   (Recommended)`, `Watercolour`, `Graphite / charcoal`, `Pen and ink`, and put
   the other one in the question text: "…or type Pastel". Default: oil. Skip this
   question if the user already named a style.
2. **Aspect ratio of the video** — options: `Mobile 9:16 (Recommended)` → 1080×1920,
   `Portrait 4:5` → 1080×1350, `Square 1:1` → 1080×1080, `Landscape 16:9` → 1920×1080.
   Default if unanswered: mobile 9:16.
3. **Background audio** — options: `No audio (Recommended)`, `Yes, add music`.
   Default: no audio. If yes, ask for the audio file path (an audio file or a
   video whose soundtrack to use) unless they already gave it. Music starts from
   the beginning of the track and fades out at the end unless they say otherwise.

Also confirm you have the reference image path. Don't ask anything else up front.

## 1. Set up the working folder

Next to the reference image (or where the user wants it):

```
<work>/
  index.html     ← copy of template/index.html
  painter.js     ← copy of template/painter.js (the engine)
  subject.js     ← copy of template/subject.js, then rewrite for this sitter
  <photo>.jpg    ← the reference
```

Serve the folder over HTTP (the page reads the photo's pixels, so `file://` will
not work): run `python -m http.server 8123` from the work folder as a background
process, then open `http://127.0.0.1:8123/index.html` in the browser.

Needs: Python 3 with Pillow and numpy, ffmpeg on PATH, a shell that can run
background processes, a way to view image files, and a browser the agent can
drive that can **run JavaScript in the page and return the result** (a
built-in browser pane, Claude in Chrome, or a browser MCP server such as
Playwright's `@playwright/mcp`, whose `browser_evaluate` runs page code). Use
a visible (headed) browser: the painting is WebGL, which headless Chromium may
render slowly or not at all.

## 2. Study the sitter and fill in subject.js

Pick a `refWidth` (1000 is a good default) and use it everywhere.

```
python scripts/measure.py photo.jpg --ref-width 1000 --out work/            # overview, grid every 100
python scripts/measure.py photo.jpg --ref-width 1000 --out work/ --crop X0 Y0 X1 Y1 --step 50 --zoom 2
python scripts/measure.py photo.jpg --ref-width 1000 --sample bg:60,100 skin:500,700 hair:250,600
```

Look at the gridded images and read coordinates off them. Make a close crop of
the face (step 50, zoom 2) for the features, and one of the hair and one of the
body. Then write every field of `subject.js` — the template documents each one
and contains a complete worked example:

- `image`, `refWidth`, `seed`, `style` (`oil`, `charcoal`, `watercolour`, `ink`, `pastel`)
- `attention.face` / `attention.head` — where the eye goes (face: centred between
  eyes and mouth, sigma ≈ half face width/height; head ≈ 1.8× wider, 1.5× taller)
- `focal` — ellipses for each eye, each brow, nose, mouth
- `backdrop` — `detect` thresholds for what counts as backdrop in the photo,
  three painted backdrop colours, and the shade behind the head.
  The default detection assumes a **light, neutral wall**. For a dark or colourful
  backdrop, sample it and set `detect` to match it (or the engine will paint the
  background as figure) and choose backdrop colours that suit the sitter.
  For a **black backdrop**: `detect: { minBrightness: -1, maxBrightness: ~11,
  maxChroma: ~7 }` (just above the sampled backdrop). The deepest hair shadows
  are then as black as the backdrop, so also give `backdrop.figure`: a polygon
  traced a little inside the silhouette of hair and body (check it drawn over
  the photo); nothing inside it is backdrop. The paper styles then treat the
  backdrop as bare paper, not as the deepest shadow.
- `hair` — `maxLum` (raise to ~170 for blond/light hair), the `light` tint for
  highlights, and a few `flyaways` off the silhouette. Optional `areas`:
  polygons that are hair even where it is too light for `maxLum`, such as a
  wispy fringe with the forehead showing through (drawn as hair, not skin). On a
  pale wall, wispy hair edges are close to skin in colour and come out as brown haloes
  outside the hair: mark them here too
- `sketch` — loose underdrawing paths: head outline, face, eyes, brows, nose,
  mouth, ears, neck, shoulders, clothing edges. ~10–25 paths.
  Note: its number of paths + 2 = the underdrawing frame count for the video.
- `construction` — face centre line and the eye line
- `accents` — lash lines (heavier at the outer corners), pupils, catchlights,
  nostrils, the darkest bits of the line between the lips, and 1–3 lights
  (bridge of the nose, lower lip). Keep them few and broken — not outlines.
  Optional `lines: [{ path, colour, weight }]` for thin things the photo
  analysis loses, such as **glasses frames** (rims, bridge, temple); they are
  drawn in broken runs. The template's `ring()` helper makes ellipse paths;
  leave out the arc where a rim passes behind hair.

Optional `watercolour` settings, needed only if the automatic result is wrong:

- `regions: [{ name, kind, poly, split }]`: named masses, in reference units. By
  default the engine finds them: skin by the colour of the middle of the face,
  hair by `hair.maxLum`, the rest split by colour into `cloths` (default 2) masses.
  Name them when that goes wrong, for example when a coat is the colour of skin.
  `kind` is `skin`, `hair`, `crisp` (folds, locks) or `soft`. `split: 2` divides a
  region by colour, such as a blue and yellow turban. Naming any `skin` region turns off
  skin detection for the whole sitter, so name all of the skin: what is left over is
  painted as cloth.
- `reserve`: polygons kept nearly free of paint, such as a pearl.
- `textureBlur` and `featureBlur`: raise them to remove craquelure or film grain,
  which are not form (defaults 2 and 2).
- `skinDetail` (0.5): raise it towards 0.6 under raking light. `skinTolerance`
  (16): how close a colour must be to the face to count as skin.
- `reach` (0.58): lower for stronger glazes, higher for paler ones.

The same `subject.js` serves all styles, so a sitter measured once can be
painted and drawn. Charcoal, ink and pastel use the same masses as watercolour, so
`watercolour.regions` and `hair.maxLum` steer all four. `palette.pastelPaper` sets the
pastel paper; otherwise it is chosen from the backdrop. The ground of the charcoal
and the ink follows `backdrop.detect` (dark or pale) and `sketch` paths are its block-in. Optional
`charcoal: { halo, hairCap }` set the tone behind the head on a pale ground (0.13)
and the lightest value of hair (0.62). In the watercolour style a pale backdrop's colours are its washes, while a dark one is
sampled from the photo; `sketch` paths named `eye…` are the reserved eye shapes.

Measuring is for placing the painter's decisions, **not for tracing**. All
colour and form comes from the photo analysis in the engine; the landmarks only
steer underdrawing, attention, focal detail and the last accents.

## 3. Paint, look, critique, adjust

Load the page (add `?style=<name>` to try another style without editing
`subject.js`). Copy `scripts/capture.js` into the work folder and load it into
the page with the browser's run-JavaScript tool —
`eval(await (await fetch('capture.js')).text())` — then drive it (a hidden or
background browser tab barely advances on its own). Each `await pc.…` line is
one JavaScript call in the page; if the tool takes a function rather than
top-level `await`, wrap it, e.g. `async () => await pc.finish()`:

```
python scripts/capture_server.py --out work/stills      # run in the background
await pc.ready()          // if "not ready", take one screenshot so the page renders, retry
await pc.finish()         // repeat while it returns looping: true (≈80 frames, ~15 s)
await pc.still("v1.png")
python scripts/review.py work/stills/v1.png photo.jpg --ref-width 1000 --face X0 Y0 X1 Y1 --out work/v1
```

If the run-JavaScript tool has a time limit (often under a minute), some styles
outlast it. Start the work without awaiting it and wait for the file instead:
`(async () => { await pc.ready(60000); while (isLooping()) await pc.finish(3000); await pc.still("v1.png"); })()`.
A tab can freeze after about three or four paintings, whatever the settings.
Paint each style in a fresh tab, and if no file appears within a couple of
minutes, close the tab and retry in a new one before changing anything.

Open `work/v1_full.jpg` and `work/v1_face.jpg` as image files (your file-reading
tool, not a browser screenshot, which is too small to judge) and critique
like a painter. Check:

- **Likeness and drawing**: eyes level and the right size, features where they
  belong — if not, fix the `focal`/`accents` coordinates.
- **Value and colour vs the photo**: skin should not go grey, olive or muddy;
  values should not be much darker than the photo (see pitfalls below).
- **Edges**: no pale halo around the hair; some edges lost, some found.
- **Brushwork**: strokes follow the form; no circular swirl patterns in flat
  areas; backdrop calm, not busy.
- **Focus**: most detail in the eyes, nose and mouth; edges and bottom loose
  and unfinished, with the toned ground and underdrawing showing.
- **Accents**: no mark that reads as drawn with a pen (outlines, "^" nostrils,
  hard white dashes). Soften or remove them.

For the **charcoal** style also check:

- **`window.__ch`** reports each mass after drawing: `lighterBy` (average levels
  lighter than the study, negative means darker) and `rms`. Around 5-12 rms is normal.
  Numbers can't judge likeness, so always look at the face next to a grey photo.
- **Look at the study before tuning marks**: `chT` (0 black, 1 paper) is the target of
  every pass, and `chRegion` the masses. A blurred study can't give a sharp drawing.
- **Value study**: skin takes extra weight on red, and values aren't stretched to fit.
  Plain luminance bruises sockets and lips; lips go only part of the way towards it.
  A sitter with `watercolour.textureBlur` gets a softer study, to lose a painting's
  cracks; a photo should leave it unset, or the whole drawing goes out of focus.
- **Filtered-photo look**: the drawing is right but shows no marks. Rubs stop short of
  the value, so that sticks have the rest to carry. If tone is too light, rub closer.
- **Cloudy skin**: dark strokes on skin. Skin is rubbed with matched strokes, loaded
  with the grey they correct towards, so they can't overshoot.
- **Dotted pale lines round a shape**: bare paper in a seam every tip stayed inside of;
  the seam pass fills them, including against a dark ground.
- **Stick marks raining along a rim**: a blur across the margin reads as an error. The
  margin has its own label, and the ground's scrub is even rather than chasing errors.
- **Mark counts** scale with the mass (`scaled`): hair that fills the sheet stays too
  light on a fixed count.
- **Features**: `chCloseLook` compares a fine view of the photo with the sheet. Its
  credit decides overshoot: too low and lips go black, too high and eyes go soft.
- **Hair** has no error left to ask for strands, because its study follows the flow:
  they are drawn anyway, dark in its shadows and lifted in its upper values.

For the **watercolour** style also check:

- **`window.__wc`** reports each mass after painting: `lighterBy` (average levels
  lighter than the photo, negative means darker) and `rms`. Around 15–25 rms is
  normal. Far lighter than that means the glazes are too thin; lower `reach`.
- **Masses**: `WCM.masses` in the page lists them. If skin and a cloth merged, or
  hair lost its bottom half, name the regions rather than tuning colours.
- **Colour stays clean**: blue stays blue beside yellow, skin stays warm. A glaze
  takes the photo's hue and only its depth and strength are measured from the canvas;
  never correct each colour channel on its own, which swings into wild colours.
- **Grey or orange skin**: a thin glaze moves the sheet only part of the way, so over a
  pale wash it must be stronger than its target, or it greys the wash. Skin glazes measure
  this along the photo's hue (`tune` in `wcMix`). A fixed warm tint fixes the lights by
  turning the shadows orange. A trace of Lab per value band, session by session, finds it.
- **No terraces or islands in the skin**: a glaze covers everything darker than its
  level, in many small steps. Limiting glazes to where the canvas is too light
  gives contour-map plateaus. Skin corrections stay few, soft and one shape at a time.
- **Darks**: pigment is never mixed much darker than its target, since dark pigment
  over a light wash goes grey. Darks build up over several glazes.
- **Water dilutes**: only skin is glazed wet. Large cloth washes built wet never
  reach their value, so they are built dry in very soft patches.
- **A dark ground** breathes: warm under-washes show through, and it is laid in
  overlapping sectors, since one wash wrapped round the figure thins out on its far
  side. Straight seams mean the sector edges have lost their noise.
- **Features**: painted from the photo's own shapes, not outlines. Lashes, the mouth
  line and nostrils use the dilute brush; thin dark lines read as vector art.
- **Seeds**: results vary, so compare 3 with `?seed=5` (fresh tab each) and set the
  best as `seed` in `subject.js`. A given seed repeats exactly, but `?record` breaks
  frames differently, so take the final still from a normal run, not the recording.

For the **ink** style also check:

- **Lines, not grey**: a value is a family of evenly spaced lines (`inLines`) and how
  much each swells. If it looks like a mesh, too many sets are crossing; if it looks
  timid, the pen is too thin for the spacing.
- **`window.__ch`** reads higher here than in charcoal (ground and coat 40-70 rms is
  normal): a pen stops short of the study's darkest values, so judge by eye.
- **Value before detail**: `chT` is the study; lights go to bare paper. Raising the
  divisor in `inkSetup` keeps more half-tones on the skin; lowering it opens the lights.
- **Lines follow the form** (`inField`): long shapes run along the flow and are never
  hatched across, except a slight angle in the deepest darks. Skin takes two sets at most.
- **Blacks** stay off the rim of a mass, where they read as a row of sausages, and take
  a few white strands, or they read as a hole.
- `subject.js` is plain JavaScript, so it can read `?style=` and vary settings by style:
  for example a higher `hair.maxLum` so charcoal and ink mass dark cloth. Cloth with long
  folds, such as a turban, can be marked with `hair.areas` so it is drawn along its flow.

For the **pastel** style also check:

- **`window.__ch`** reports each mass against the target in colour; 5-15 rms is normal
  on the figure. Ground 20-25 is fine: strokes break, and that is the look.
- **Grain belongs to the sheet**: the shader shows paper from the valleys of the tooth.
  Strong or coarse grain reads as freckles on skin, and sparse grain as digital noise.
- **Dashed dark outline round the figure**: a stick working the seam between ground and
  figure. Seams are closed with a finger, and strokes never leave their own mass.
- **Pale seams** at the ear or jaw: the seam pass has not reached them; raise its looks.
- **Lights look dim**: the box keeps its lightest sticks on purpose, and the lights pass
  goes last, with a strong push. Colour can stay close while value is off, so compare
  the collar and the catchlights by eye.
- **Stray drawing**: sanguine lines are dropped where the sheet stays bare; a red line
  crossing a lit cheek means it is too strong.

Adjust `subject.js` first. Change `painter.js` only for problems that would
affect any sitter. Repaint and look again until it holds up as a painting — two
or three rounds is normal. Save the approved still as the final PNG.

## 4. Record the process

```
python scripts/capture_server.py --out work/frames      # background; stop the stills server first (same port)
```

The server only accepts images, from pages on this machine. If you run it with another
`--port`, add `?capturePort=<port>` to the page's URL.

Open `index.html?record` (add `&style=<name>` if that is the style and it
is not set in `subject.js`). Record mode paints 30 strokes per frame instead of
160 and draws the underdrawing one contour per frame. Nothing paints until `pc.record()`
drives it, in a visible tab or a hidden one, so `pc.status().frames` should equal
`.frame` when it finishes. Load `capture.js` as
before, then:

```
await pc.ready()
pc.record({ width: 1600 })     // background loop: one JPEG per frame, f00000.jpg …
pc.status()                    // poll (wait ~40 s between polls) until done: true
```

Expect ~250–400 frames for oil, ~100 for watercolour (one per session, since paint
has to stay wet within a frame; render it with `--dissolve 6`), ~210-270 for
charcoal, ~130 for ink and ~220 for pastel, which all end on exactly the still a
normal run makes. Check the pacing on the contact sheet the first time. If `err` reports a failed upload, check the
server is up and paint the rest from where it stopped: reload `?record`, or keep
the page and call `pc.record()` again — numbering continues from
`pc.status().frames`. Only one capture server may listen on the port; stopping
the background shell does not always stop Python on Windows, so make sure the
process is gone (e.g. find `capture_server` in the process list) before starting
the next one, and when you are done.

## 5. Render the video

```
python scripts/render_video.py work/frames --out portrait-process.mp4 --aspect mobile
# with music, from the start of the track, faded out at the end:
python scripts/render_video.py work/frames --out portrait-process.mp4 --aspect mobile \
       --audio "song.mp4" --save-audio "song.m4a"
```

- `--aspect`: mobile/9:16 (default), 4:5, 1:1, 16:9, original.
- `--fit fill` (default) zooms in and crops so there are **no bars**; `--focus FX FY`
  keeps the face in frame (default 0.5 0.4; for 16:9 from a portrait painting,
  set FY to where the face is, e.g. 0.35). `--fit pad` letterboxes instead.
- `--underdrawing-frames` = number of `sketch` paths + 2 (default 22).
- `--dissolve 6` lets each frame bleed into the next, so a watercolour's wet
  sessions spread in rather than appear at once.
- Pacing is automatic: frames stay on screen in proportion to how much they
  change the painting; bare canvas 0.8 s at the start, finished painting held 3.5 s.
- Audio: `--audio-start S` to start later in the track, `--fade S` for the fade-out.

Verify, then hand over:

```
ffprobe -v error -show_entries stream=codec_type,width,height -show_entries format=duration -of default=nw=1 portrait-process.mp4
ffmpeg -y -loglevel error -i portrait-process.mp4 -vf "select='not(mod(n\,64))',scale=216:384,tile=5x2" -frames:v 1 work/contact.jpg
```

Look at the contact sheet: bare ground → underdrawing → block-in → forms →
detail → finished, no bars, face in frame. Deliver the final PNG and the MP4.

## Adding another style

Styles share everything except the process: photo analysis, direction fields,
attention, focal areas, `finish()` for unfinished edges, the underdrawing,
accents, recording and rendering. A new style is a new generator like
`painting()` or `charcoal()` that `setup()` picks from `STYLE`, plus any brushes
it needs (added after `brush.scaleBrushes()`). Prototype the marks on a scratch
page first, then iterate with the critique loop above. Charcoal lessons that
carry over: read the sheet back after every pass and mark only where it disagrees
with a value study; compare values within a shape, never across its edge; keep separate
layers for pigments that behave differently; and look at features on a finer
grid than the rest. Watercolour lessons: wash shapes come from photo regions (value
thresholds, traced as polygons, with a slit cut to
any highlight they enclose so the wash goes round it); paint them light to
dark, and draw brush strokes that must look wet as thin tapered fills.

Each style is an entry in `STYLES` in painter.js (its paper colour and its
generator). Brushes a new style needs go in a function of their own, registered
**only for that style**: a custom tip that calls
`random()` shifts the seeded sequence, and every other style's marks with it.
For the same reason never add an unconditional `random()` call to shared code
(`paintLayer`, `traceStroke`…). A style drawn on layers and read back goes in
`SHEET_STYLES`, and can use `chCommit`, `chTrace`, `chCredit` and `chWithinBlur`.

## p5.brush 3.0.0 pitfalls (all already handled in painter.js — don't undo them)

- **Fills settle at the end of the frame.** A line drawn over a still-wet fill in
  the same frame is buried under it. The painting is a generator; each `yield`
  ends a frame and lets the paint dry. Put a `yield` between any fill and the
  lines that go on top of it.
- **`brush.spline()` fills its path whenever a fill is active.** Call
  `brush.noFill()` after any fill, or every hair/contour spline becomes a
  ground-coloured blob.
- **Strokes mix like real pigment (spectral).** Layers darken, cool blue-violet
  over peach turns olive, and light colours drift yellow. The engine mixes paint
  lighter per layer (`lift`), adds back blue, and makes skin shadows rose rather
  than blue. The backdrop is painted with `lift: 0`.
- **WEBGL origin is the canvas centre** — `draw()` translates by (−W/2, −H/2).
- **Custom brushes are added after `brush.scaleBrushes()`** so their weights are
  in canvas pixels. Built-in pencils are thin at small weights; the custom
  `bristle`, `dry` and `liner` brushes do the painting.
- **p5 global mode**: never name your own globals after p5 functions
  (`stroke`, `shape`, `path`…) — "Cannot redefine property" errors.
- **Reading pixels back**: use p5 `get()`; `canvas.toDataURL()` on the WEBGL
  canvas can return a blank image.
- **The page needs to render once before `await img.decode()` resolves** in a
  hidden or background tab — take one screenshot if `pc.ready()` stalls.
- **Watercolour fills mix spectrally**: thin yellowish washes read olive and
  pink glazes go violet; the built-in `marker` stroke over a fill also drifts.
  Lean pigment towards red, and mix stroke colours straight, not thinned.
  Built-in brushes in 3.0: pen, rotring, 2B, HB, 2H, cpencil, pastel, crayon,
  charcoal, spray, marker (no `marker2` or `watercolor`).
- **Layers (`createFramebuffer`)**, in charcoal, ink and pastel: a colour composites only when the next
  colour arrives, so draw an off-sheet stroke before `layer.end()`, or the last colour
  lands on the canvas. Mask alpha above 0.7 darkens pigment, even white, so land pale
  rubs every 6 strokes. Custom-tip opacity is divided by `min(weight, 1.3)`: thin
  tips get stronger. `scaleBrushes()` only scales brushes added before it.
- **Thin custom tips** break into dashes at some angles unless `spacing` is small
  (about 0.12), and spacing that small makes the line wider than its weight suggests:
  calibrate the width on the sheet. Stamps have stair-stepped edges; the ink shader
  averages four taps to smooth them. Point-sampling lines says nothing about their
  value, so `inLook` counts every pixel.
- **Colour changes are costly**: each one composites. Pastel uses a box of about 50
  sticks and sorts strokes by colour, which keeps thousands of strokes quick.
- **Angles are in canvas coordinates (y down)**: 60° is nearly vertical; the
  natural right-handed "/" hatching diagonal is about 120°.
- **Background detection**: a figure stroke on the hair's edge that samples the
  light wall makes a pale halo; backdrop is detected if either the blurred or the
  sharp sample looks like backdrop.
