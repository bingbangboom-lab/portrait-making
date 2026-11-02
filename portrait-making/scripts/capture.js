// Paste this whole file into the page (the browser's run-JavaScript tool) once the
// painting page has loaded and `steps` is defined (see SKILL.md). It adds
// window.pc with three helpers. Captures go to capture_server.py.
//
//   await pc.ready()              // waits until the photo is analysed
//   await pc.finish()             // paints to the end, driving frames itself
//   await pc.still("v1.png")      // saves the current canvas (full resolution)
//   pc.record({ width: 1600 })    // on index.html?record: one JPEG per frame,
//   pc.status()                   //   runs in the background; poll this
//
// Why it drives frames with redraw(): a hidden or background browser tab
// throttles requestAnimationFrame, so p5's own loop may barely advance. On ?record
// p5's own loop is off altogether, so every frame painted is a frame captured.
// If capture_server.py runs on another --port, add ?capturePort=<port> to the page's URL.

window.pc = (() => {
  const PORT = Number(new URLSearchParams(location.search).get("capturePort")) || 8124;   // the same as capture_server.py --port
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rec = { n: 0, done: false, err: null };
  const painting = () => !window.__painted;

  // one frame, and only one: on ?record the page draws nothing except through this
  async function step() {
    window.__stepping = true;
    await redraw();
    window.__stepping = false;
  }

  async function upload(name, dataUrl) {
    for (let k = 0; k < 6; k++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/${name}`, { method: "POST", body: dataUrl });
        if (r.ok) return;
      } catch (e) { /* server busy: retry */ }
      await wait(300);
    }
    throw new Error("upload failed: " + name);
  }

  // p5's get() reads the WEBGL canvas reliably; canvas.toDataURL() can come back blank
  function frameCanvas(width) {
    const im = get();
    if (!width || width === im.canvas.width) return im.canvas;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = Math.round(width * im.canvas.height / im.canvas.width);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(im.canvas, 0, 0, out.width, out.height);
    return out;
  }

  return {
    async ready(timeoutMs = 40000) {
      const t = performance.now();
      while (typeof steps === "undefined" || !steps) {
        if (performance.now() - t > timeoutMs) return "not ready (take a screenshot so the page renders, then retry)";
        await wait(200);
      }
      return "ready";
    },

    // paints until done or until the time budget runs out; call again if it returns looping=true
    async finish(budgetMs = 38000) {
      const t = performance.now();
      while (painting() && performance.now() - t < budgetMs) await step();
      return { frame: frameCount, looping: painting() };
    },

    async still(name = "still.png") {
      await upload(name, frameCanvas().toDataURL("image/png"));
      return name;
    },

    record({ width = 1600, quality = 0.93, prefix = "f" } = {}) {
      const grab = async () => {
        const url = frameCanvas(width).toDataURL("image/jpeg", quality);
        await upload(prefix + String(rec.n).padStart(5, "0") + ".jpg", url);
        rec.n++;
      };
      (async () => {
        try {
          await grab();                       // the bare canvas, before anything is painted
          while (painting()) { await step(); await grab(); }
          rec.done = true;
        } catch (e) { rec.err = String(e); }
      })();
      return "recording";
    },

    status() { return { frames: rec.n, done: rec.done, err: rec.err, frame: frameCount }; },
  };
})();
