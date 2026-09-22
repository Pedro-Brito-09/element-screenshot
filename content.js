// Injected on demand by background.js. Running it again toggles the picker.
(() => {
  if (window.__elementShot) {
    window.__elementShot.toggle();
    return;
  }

  // Canvas limit in Chromium is 32767 px per side; the area cap keeps the three
  // pass canvases plus their pixel buffers within a sane amount of memory.
  const MAX_DIM = 32767;
  const MAX_AREA = 90_000_000;
  const MIN_SCALE = 2;      // output device pixels per CSS pixel (never below the screen's own)
  const TILE_OVERLAP = 4;   // CSS px shared between stitched tiles, so rounding never leaves a gap
  const BG_ATTR = 'data-element-shot-bg';
  const TARGET_ATTR = 'data-element-shot-target';
  const PATH_ATTR = 'data-element-shot-path'; // ancestors of the target (kept for the backdrop pass)
  const BOX_ATTR = 'data-element-shot-box';   // set while capturing with the background option on
  const MAX_INK_NODES = 5000; // above this, measuring every descendant costs more than it is worth

  let host, box, label, hint, bgState, focusState, focusSink, gate, toastEl, toastTimer;
  let active = false;
  let gateOpen = false;  // waiting for the page to get keyboard focus before picking
  let busy = false;
  let hovered = null;   // element under the cursor
  let selected = null;  // hovered, or an ancestor/descendant chosen with wheel / arrows
  let childTrail = [];  // path back down after going up to parents
  let lastWheelAt = 0;
  let boxMode = false;  // B: fill the element's whole box with the background behind it

  // ---------- UI (shadow DOM so page CSS cannot touch it) ----------

  function ensureUi() {
    if (host && host.isConnected) return;
    host = document.createElement('element-shot-ui');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .box { position: fixed; display: none; border: 2px solid #1a73e8; background: rgba(26,115,232,.15);
               border-radius: 2px; transition: all 60ms ease-out; }
        .label { position: fixed; display: none; padding: 2px 6px; border-radius: 3px; background: #1a73e8;
                 color: #fff; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
        .hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none;
                padding: 6px 12px; border-radius: 6px; background: rgba(32,33,36,.92); color: #fff; white-space: nowrap; }
        .hint b { font-weight: 600; }
        .gate { position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
                background: rgba(32,33,36,.55); pointer-events: auto; cursor: pointer; }
        .gate .card { padding: 20px 28px; border-radius: 10px; background: #fff; color: #202124;
                      text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: 90vw; }
        .gate .title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
        .gate .sub { color: #5f6368; }
        .toast { position: fixed; right: 16px; bottom: 16px; display: none; padding: 8px 14px; border-radius: 6px;
                 background: #1e8e3e; color: #fff; max-width: 420px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
        .toast.error { background: #d93025; }
      </style>
      <div class="box"></div>
      <div class="label"></div>
      <div class="hint"><b>Click</b> capture &middot; <b>Wheel / &uarr;&darr;</b> parent / child &middot;
        <b>Enter</b> capture &middot; <b>Esc</b> / middle-click cancel &middot;
        <b>B</b> / right-click background: <span class="bg"></span><span class="focus"></span></div>
      <div class="gate"><div class="card">
        <div class="title">Click anywhere to start picking</div>
        <div class="sub">Opened from the toolbar icon, Chrome keeps the keyboard on its own UI,
          so the page has to be focused first.</div>
      </div></div>
      <div class="toast"></div>`;
    box = shadow.querySelector('.box');
    label = shadow.querySelector('.label');
    hint = shadow.querySelector('.hint');
    bgState = shadow.querySelector('.bg');
    focusState = shadow.querySelector('.focus');
    gate = shadow.querySelector('.gate');
    gate.addEventListener('mousedown', onGateClick, true);
    gate.addEventListener('click', onGateClick, true);
    // Focusing this moves keyboard focus into the page when the picker was started from the
    // toolbar icon, where focus otherwise stays in Chrome's UI and no key ever reaches us.
    focusSink = document.createElement('div');
    focusSink.tabIndex = -1;
    focusSink.style.cssText = 'position: fixed; width: 0; height: 0; opacity: 0;';
    shadow.appendChild(focusSink);
    toastEl = shadow.querySelector('.toast');
    document.documentElement.appendChild(host);
  }

  function removeUiIfIdle() {
    if (!active && !busy && host && toastEl.style.display === 'none') host.remove();
  }

  function toast(text, isError = false, ms = 3500) {
    ensureUi();
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.className = 'toast' + (isError ? ' error' : '');
    toastEl.style.display = 'block';
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none';
      removeUiIfIdle();
    }, ms);
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 3).join('.');
    return s;
  }

  function render() {
    if (!selected || !active) {
      box.style.display = label.style.display = 'none';
      return;
    }
    const r = selected.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px',
    });
    label.textContent = `${describe(selected)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    label.style.display = 'block';
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = (r.top >= 22 ? r.top - 22 : Math.max(0, r.top) + 2) + 'px';
  }

  // ---------- Picker ----------

  function start() {
    ensureUi();
    try { window.focus(); } catch {}
    focusSink.focus({ preventScroll: true });
    if (!document.hasFocus()) {
      // Started from the toolbar icon: no key ever reaches the page until it is focused.
      gateOpen = true;
      gate.style.display = 'flex';
      window.addEventListener('focus', onWindowFocus, true);
      return;
    }
    beginPicking();
  }

  function onGateClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return; // the mousedown only focuses the page
    closeGate();
    beginPicking();
  }

  function onWindowFocus() {
    if (gateOpen && document.hasFocus()) {
      closeGate();
      beginPicking();
    }
  }

  function closeGate() {
    gateOpen = false;
    gate.style.display = 'none';
    window.removeEventListener('focus', onWindowFocus, true);
    focusSink.focus({ preventScroll: true });
  }

  function beginPicking() {
    active = true;
    hint.style.display = 'block';
    bgState.textContent = boxMode ? 'on' : 'off';
    showFocusState();
    window.addEventListener('focus', showFocusState, true);
    window.addEventListener('blur', showFocusState, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', render, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', onKey, true);
    for (const t of BLOCKED) window.addEventListener(t, onPointer, true);
  }

  function stop() {
    if (gateOpen) closeGate();
    active = false;
    hovered = selected = null;
    childTrail = [];
    window.removeEventListener('focus', showFocusState, true);
    window.removeEventListener('blur', showFocusState, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('scroll', render, true);
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('keydown', onKey, true);
    for (const t of BLOCKED) window.removeEventListener(t, onPointer, true);
    if (host) {
      hint.style.display = 'none';
      render();
      removeUiIfIdle();
    }
  }

  function toggle() {
    if (busy) return;
    active || gateOpen ? stop() : start();
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hovered || el === host) return;
    hovered = selected = el;
    childTrail = [];
    render();
  }

  function goUp() {
    if (!selected || selected === document.documentElement || !selected.parentElement) return;
    childTrail.push(selected);
    selected = selected.parentElement;
    render();
  }

  function goDown() {
    if (!selected) return;
    const next = childTrail.pop() ||
      [...selected.children].find((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    if (next) {
      selected = next;
      render();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastWheelAt < 120) return; // trackpads fire many wheel events per gesture
    lastWheelAt = now;
    e.deltaY < 0 ? goUp() : goDown();
  }

  function onKey(e) {
    const handlers = {
      Escape: stop,
      ArrowUp: goUp,
      ArrowDown: goDown,
      Enter: () => capture(),
      b: toggleBoxMode,
      B: toggleBoxMode,
    };
    const fn = handlers[e.key];
    if (!fn) return; // let PageUp/PageDown/etc. scroll the page
    e.preventDefault();
    e.stopImmediatePropagation();
    fn();
  }

  // Keys only reach the page once it has focus; say so instead of looking broken.
  function showFocusState() {
    focusState.textContent = document.hasFocus() ? '' : 'click the page for keys';
  }

  function toggleBoxMode() {
    boxMode = !boxMode;
    bgState.textContent = boxMode ? 'on' : 'off';
  }

  // Swallow clicks so the page does not react (follow links, open menus...).
  const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick',
    'auxclick', 'contextmenu'];

  function onPointer(e) {
    const de = document.documentElement;
    if (e.clientX >= de.clientWidth || e.clientY >= de.clientHeight) return; // scrollbar
    e.preventDefault();
    e.stopImmediatePropagation();
    showFocusState();
    // Mouse equivalents of the keys, for when the page has no keyboard focus.
    if (e.type === 'click' && e.button === 0) capture();
    else if (e.type === 'auxclick' && e.button === 1) stop();
    else if (e.type === 'contextmenu') toggleBoxMode();
  }

  // ---------- Capture ----------

  async function capture() {
    if (!selected || busy) return;
    busy = true;
    const el = selected;
    const filename = `element-${el.tagName.toLowerCase()}-${timestamp()}.png`;

    // The clipboard write must start while we still have the user gesture;
    // ClipboardItem accepts a promise, so the PNG is filled in when ready.
    let resolveBlob, rejectBlob;
    const blobPromise = new Promise((res, rej) => { resolveBlob = res; rejectBlob = rej; });
    let clipboardDone;
    try {
      clipboardDone = navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    } catch (err) {
      clipboardDone = Promise.reject(err);
    }
    clipboardDone.catch(() => {});

    stop();
    try {
      const canvas = await captureElement(el);
      const blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
      resolveBlob(blob);

      const [dl, clip] = await Promise.allSettled([download(blob, filename), clipboardDone]);
      const size = `${canvas.width} × ${canvas.height}`;
      if (dl.status === 'fulfilled' && clip.status === 'fulfilled') {
        toast(`Saved ${filename} (${size}) · copied to clipboard`);
      } else if (dl.status === 'fulfilled') {
        toast(`Saved ${filename} (${size}) · clipboard failed: ${clip.reason?.message || clip.reason}`, true, 6000);
      } else if (clip.status === 'fulfilled') {
        toast(`Copied to clipboard (${size}) · download failed: ${dl.reason?.message || dl.reason}`, true, 6000);
      } else {
        toast(`Download and clipboard failed: ${dl.reason?.message || dl.reason}`, true, 6000);
      }
    } catch (err) {
      rejectBlob(err);
      toast('Capture failed: ' + (err.message || err), true, 6000);
    } finally {
      busy = false;
    }
  }

  // Viewport-space box covering the element and its descendants, so children that overflow it
  // (dropdowns, tooltips, absolutely positioned bits) are not cut off. Descendants are first
  // clipped by any scroll/overflow ancestor that would cut them on screen anyway.
  function inkBox(el) {
    const base = el.getBoundingClientRect();
    const box = { left: base.left, top: base.top, right: base.right, bottom: base.bottom };
    const nodes = el.querySelectorAll('*');
    if (nodes.length > MAX_INK_NODES) return box;

    const clipsOf = new Map([[el, clipsFor(el, [], base)]]);
    for (const node of nodes) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const inherited = clipsOf.get(node.parentElement) || [];
      // Absolute children escape clippers that are not positioned; fixed ones escape all.
      const applicable = style.position === 'fixed' ? []
        : style.position === 'absolute' ? inherited.filter((c) => c.positioned)
        : inherited;
      let rect = node.getBoundingClientRect();
      for (const c of applicable) rect = intersect(rect, c.rect);
      if (!rect) continue;
      box.left = Math.min(box.left, rect.left);
      box.top = Math.min(box.top, rect.top);
      box.right = Math.max(box.right, rect.right);
      box.bottom = Math.max(box.bottom, rect.bottom);
      clipsOf.set(node, clipsFor(node, applicable, rect, style));
    }
    return box;
  }

  function clipsFor(node, inherited, rect, style = getComputedStyle(node)) {
    const clips = /visible/.test(style.overflow) && style.clipPath === 'none' ? inherited
      : [...inherited, { rect, positioned: style.position !== 'static' }];
    return clips;
  }

  function intersect(a, b) {
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  }

  // Drop fully transparent margins, e.g. when a child overflows on one side only.
  function trim(canvas) {
    const { width, height } = canvas;
    const d = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (d[row + x * 4 + 3]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          maxY = y;
        }
      }
    }
    if (maxX < 0) throw new Error('the element painted nothing');
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return canvas;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = newCanvas(w, h);
    out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
    return out;
  }

  function inFixedLayer(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).position === 'fixed') return true;
    }
    return false;
  }

  async function captureElement(el) {
    const de = document.documentElement;
    const startX = window.scrollX;
    const startY = window.scrollY;
    const scale = Math.max(MIN_SCALE, window.devicePixelRatio || 1);
    const prevScrollBehavior = de.style.scrollBehavior;

    const passes = boxMode ? ['black', 'white', 'backdrop'] : ['black', 'white'];
    el.setAttribute(TARGET_ATTR, '');
    if (boxMode) el.setAttribute(BOX_ATTR, '');
    const ancestors = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      n.setAttribute(PATH_ATTR, '');
      ancestors.push(n);
    }
    de.style.scrollBehavior = 'auto';
    if (host) host.style.display = 'none';

    let canvases; // one per pass
    try {
      await send('begin', { scale });
      await waitForStableViewport(); // the "debugging" bar shrinks the viewport when it appears
      await waitForImages(el);       // srcset images may switch to their high-res versions

      // Geometry is measured only now, after the viewport settled. Everything here is CSS px.
      const vw = de.clientWidth || window.innerWidth;
      const vh = document.compatMode === 'CSS1Compat' ? de.clientHeight : window.innerHeight;
      const sx0 = window.scrollX;
      const sy0 = window.scrollY;
      const r = inkBox(el); // the element plus any children painting outside it

      // Element box in document CSS px. Elements in a fixed layer do not move with scrolling,
      // so they are limited to the current viewport and captured without scrolling.
      const fixed = inFixedLayer(el);
      let left = r.left + sx0, top = r.top + sy0, right = r.right + sx0, bottom = r.bottom + sy0;
      if (fixed) {
        left = Math.max(left, sx0); top = Math.max(top, sy0);
        right = Math.min(right, sx0 + vw); bottom = Math.min(bottom, sy0 + vh);
      } else {
        const docW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
        const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
        left = Math.max(0, left); top = Math.max(0, top);
        right = Math.min(docW, right); bottom = Math.min(docH, bottom);
      }
      if (right - left < 1 || bottom - top < 1) throw new Error('the element has no visible size');

      // Scroll positions to visit; null = keep the current scroll.
      const w = right - left, h = bottom - top;
      const fullyVisible = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
      let tiles;
      if (fixed || fullyVisible) {
        tiles = [null];
      } else {
        const xs = w <= vw ? [left - (vw - w) / 2] : range(left, right, vw - TILE_OVERLAP);
        const ys = h <= vh ? [top - (vh - h) / 2] : range(top, bottom, vh - TILE_OVERLAP);
        tiles = ys.flatMap((y) => xs.map((x) => [x, y]));
      }

      // Set up from the first screenshot: the scale is measured from the image itself, so
      // browser zoom, Windows display scaling or CSS zoom cannot throw the crop off.
      let s, L, T, R, B, k;
      const init = (img) => {
        s = measureScale(img, vw, vh);
        // Snap inward to whole device pixels: partially covered edge pixels (where the page
        // behind or the element's own box-shadow bleeds in) are left out.
        L = Math.ceil(left * s - 0.01); T = Math.ceil(top * s - 0.01);
        R = Math.floor(right * s + 0.01); B = Math.floor(bottom * s + 0.01);
        if (R - L < 1 || B - T < 1) throw new Error('the element has no visible size');
        // Output size; only shrinks if the element would exceed the canvas limits.
        const W = R - L, H = B - T;
        k = Math.min(1, MAX_DIM / W, MAX_DIM / H, Math.sqrt(MAX_AREA / (W * H)));
        const cw = Math.max(1, Math.round(W * k)), ch = Math.max(1, Math.round(H * k));
        canvases = Object.fromEntries(passes.map((p) => [p, newCanvas(cw, ch)]));
      };

      for (const tile of tiles) {
        if (tile) window.scrollTo(tile[0], tile[1]);
        await settle();
        const sx = window.scrollX, sy = window.scrollY; // the browser may clamp our scroll

        for (const bg of passes) {
          de.setAttribute(BG_ATTR, bg);
          await settle();
          const img = await captureViewport(bg);
          try {
            if (!s) init(img);
            // Part of the element visible in this screenshot, in device px of the document.
            const x0 = Math.max(L, Math.ceil(sx * s - 0.01)), y0 = Math.max(T, Math.ceil(sy * s - 0.01));
            // Limit to the viewport's content area so a scrollbar in the image is never used.
            const x1 = Math.min(R, Math.floor(sx * s + Math.min(img.width, vw * s) + 0.01));
            const y1 = Math.min(B, Math.floor(sy * s + Math.min(img.height, vh * s) + 0.01));
            if (x1 <= x0 || y1 <= y0) continue;
            const ctx = canvases[bg].getContext('2d');
            ctx.imageSmoothingEnabled = k < 1;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img,
              Math.round(x0 - sx * s), Math.round(y0 - sy * s), x1 - x0, y1 - y0,
              (x0 - L) * k, (y0 - T) * k, (x1 - x0) * k, (y1 - y0) * k);
          } finally {
            img.close();
          }
        }
      }
    } finally {
      de.removeAttribute(BG_ATTR);
      el.removeAttribute(TARGET_ATTR);
      el.removeAttribute(BOX_ATTR);
      for (const n of ancestors) n.removeAttribute(PATH_ATTR);
      window.scrollTo(startX, startY);
      de.style.scrollBehavior = prevScrollBehavior;
      if (host) host.style.display = '';
      await send('end').catch(() => {});
    }

    return trim(combine(canvases));
  }

  // Over black a pixel reads B = a*C, over white W = a*C + (1-a)*255, so a = 1 - (W - B)/255
  // is the element's exact coverage.
  // Without the background option the color comes from those same two captures (the element's
  // own color, un-premultiplied). With it, the shape is the element's whole box and the color
  // comes from the backdrop pass: what you see on screen, over the real background behind it.
  function combine({ black, white, backdrop }) {
    const { width, height } = black;
    const target = backdrop || black;
    const ctx = target.getContext('2d');
    const out = ctx.getImageData(0, 0, width, height);
    const c = out.data;
    // Without a backdrop pass `b` is `c` itself; safe, as every index is read before it is written.
    const b = backdrop ? black.getContext('2d').getImageData(0, 0, width, height).data : c;
    const w = white.getContext('2d').getImageData(0, 0, width, height).data;
    for (let i = 0; i < c.length; i += 4) {
      let a = 1 - ((w[i] - b[i]) + (w[i + 1] - b[i + 1]) + (w[i + 2] - b[i + 2])) / 765;
      if (a < 0.5 / 255) {
        c[i] = c[i + 1] = c[i + 2] = c[i + 3] = 0;
        continue;
      }
      if (a > 1) a = 1;
      if (!backdrop) {
        // Recover the element's own color from the two captures (both estimates averaged).
        const bgPart = 255 * (1 - a);
        const inv = 1 / (2 * a);
        // Uint8ClampedArray clamps and rounds on assignment.
        c[i] = (b[i] + w[i] - bgPart) * inv;
        c[i + 1] = (b[i + 1] + w[i + 1] - bgPart) * inv;
        c[i + 2] = (b[i + 2] + w[i + 2] - bgPart) * inv;
      }
      c[i + 3] = a * 255;
    }
    ctx.putImageData(out, 0, 0);
    return target;
  }

  function newCanvas(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d', { willReadFrequently: true });
    return c;
  }

  function range(from, to, step) {
    const out = [];
    for (let v = from; v < to; v += step) out.push(v);
    return out;
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Two frames for style/paint to reach the screen, plus a moment for lazy content.
  async function settle() {
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await sleep(40);
  }

  // Wait until the viewport size stops changing (the infobar may animate in), max 1.5 s.
  async function waitForStableViewport() {
    const size = () => `${window.innerWidth}x${window.innerHeight}`;
    const deadline = Date.now() + 1500;
    let last = size(), stableSince = Date.now();
    await sleep(100);
    while (Date.now() < deadline) {
      const now = size();
      if (now !== last) { last = now; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 250) break;
      await sleep(50);
    }
    await settle();
  }

  // Images inside the element (e.g. srcset switching to 2x); lazy ones may never load, hence the cap.
  async function waitForImages(el) {
    const imgs = [...el.querySelectorAll('img')];
    if (el instanceof HTMLImageElement) imgs.push(el);
    if (!imgs.length) return;
    await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), sleep(1500)]);
  }

  // Device px per CSS px, from the screenshot. The image may or may not include the scrollbars,
  // so try both viewport sizes and keep the pair where width and height agree.
  function measureScale(img, vw, vh) {
    const ws = [img.width / window.innerWidth, img.width / vw];
    const hs = [img.height / window.innerHeight, img.height / vh];
    let best = null;
    for (const a of ws) for (const b of hs) {
      if (!best || Math.abs(a - b) < best.diff) best = { diff: Math.abs(a - b), value: (a + b) / 2 };
    }
    if (!best.value || !isFinite(best.value)) {
      throw new Error(`cannot measure the screenshot scale (image ${img.width}×${img.height}, viewport ${vw}×${vh})`);
    }
    return best.value;
  }

  async function captureViewport(bg) {
    const { dataUrl } = await send('capture');
    try {
      const img = await dataUrlToBitmap(dataUrl);
      if (img.width < 1 || img.height < 1) throw new Error('empty image');
      return img;
    } catch (err) {
      throw new Error(`the ${bg} screenshot could not be read (${err.message}; ${dataUrl.length} bytes, ` +
        `viewport ${window.innerWidth}×${window.innerHeight}, zoom ${window.devicePixelRatio})`);
    }
  }

  async function send(type, payload = {}) {
    const resp = await chrome.runtime.sendMessage({ type, ...payload });
    if (!resp || resp.error) throw new Error(resp ? resp.error : 'no response from the extension');
    return resp;
  }

  // Decode without fetch/<img> so the page's CSP cannot block it.
  function dataUrlToBitmap(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  async function download(blob, filename) {
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = () => rej(reader.error);
      reader.readAsDataURL(blob);
    });
    try {
      await send('download', { dataUrl, filename });
    } catch (err) {
      // Fallback (e.g. image too large for extension messaging): save through a link in the page.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  window.__elementShot = { toggle };
  start();
})();
