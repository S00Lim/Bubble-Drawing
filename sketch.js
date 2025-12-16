/***********************
  Bubble Type Drawing (Square Stage)
  - JS builds: layout + styles + DOM
  - Anim modes: None / Bounce / Beat / Appear(loop)
  - No floating layer on pinch-close

  ✅ NEW:
    - Recolor/edit saved letter by changing Fill/Stroke/None after selecting from gallery
    - Animation mode stored per-letter
    - Color/style stored per-letter + auto thumb update
    - Gallery thumbnails are LIVE animated (canvas preview)
    - Per-letter export button
    - Export formats: PNG / VIDEO(WebM)  (MP4 not native in-browser)
***********************/

// ===== Media / p5 =====
let video, hands, camera;
let handLandmarks = [];

// ===== UI (DOM) =====
let appEl, stageEl, gridEl;
let letterLabelEl, saveBtnEl, redrawBtnEl;

let fillNoneEl, strokeNoneEl;
let fillColorEl, strokeColorEl;
let fillSwatchEl, strokeSwatchEl;

let saveModeRadios = [];
let animModeRadios = [];

let exportFormatEl; // ✅ PNG / VIDEO(WebM)

// ===== letters + grid =====
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const GRID_SLOTS = 28;
let selectedIndex = 0;

// ===== layout sizes =====
const STAGE_SIZE = 860;         // square stage
const THUMB_SIZE = 120;

// ===== cover crop params (square, no distortion, no bars) =====
let cover = { x: 0, y: 0, w: 0, h: 0, s: 1, vw: 0, vh: 0 };

// ===== drawing data (dots) =====
let currentDots = [];
let savedDotsByLetter = Array(26).fill(null);

// ✅ per-letter anim state
let animModeByLetter = Array(26).fill("none");
let appearStartFrameByLetter = Array(26).fill(0);

// ✅ per-letter style state (컬러/none 상태도 알파벳별 저장)
let styleByLetter = Array(26).fill(null).map(() => ({
  fillNone: false,
  strokeNone: false,
  fill: "#DDE2FF",
  stroke: "#000000"
}));

// ✅ live thumbnail canvas refs
let thumbCanvasByLetter = Array(26).fill(null);
let thumbCtxByLetter = Array(26).fill(null);
let thumbHasData = Array(26).fill(false);
let thumbAnimStartMsByLetter = Array(26).fill(0);

// ===== drawing state =====
let wasDrawing = false;
let wasClearHandOpen = false;

// ================================
// ✅ DRAWING TUNING (CHANGED)
// ================================
const DRAW_ON_THRESHOLD  = 75;
const DRAW_OFF_THRESHOLD = 55;
const PINCH_DEADZONE = 35;
const MIN_POINT_INTERVAL_MS = 22;
const MIN_POINT_DIST = 9;
const DIST_SMOOTHING = 0.23;
const CLOSE_TRIGGER  = 25;

const APPEAR_SPEED = 1.6;
const APPEAR_HOLD_FRAMES = 24;

// ✅ internal helpers for anti-jitter
let smoothedPinchDist = null;
let lastDotTimeMs = 0;
let lastDotPos = null;

// ---------------------------
// p5 entry
// ---------------------------
function setup() {
  buildDOM();
  injectStyles();
  wireUI();
  buildGrid();
  selectLetter(0);

  const cnv = createCanvas(STAGE_SIZE, STAGE_SIZE);
  cnv.parent(stageEl);

  drawingContext.imageSmoothingEnabled = true;
  drawingContext.imageSmoothingQuality = "high";

  pixelDensity(1);

  video = createCapture({
    video: {
      width:  { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 60 },
      facingMode: "user"
    },
    audio: false
  });
  video.hide();

  video.elt.setAttribute("playsinline", "");
  video.elt.muted = true;

  forceCameraHD();

  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });
  hands.onResults((results) => {
    handLandmarks = results.multiHandLandmarks || [];
  });

  camera = new Camera(video.elt, {
    onFrame: async () => {
      await hands.send({ image: video.elt });
    },
    width:  STAGE_SIZE,
    height: STAGE_SIZE,
  });
  camera.start();

  appearStartFrameByLetter[selectedIndex] = frameCount;
  startThumbLoop();
}

function draw() {
  background(217);
  updateCoverRect();

  push();
  translate(width, 0);
  scale(-1, 1);

  drawVideoCover();

  const mode = getAnimMode();
  renderDots(currentDots, mode, frameCount, appearStartFrameByLetter[selectedIndex]);

  pop();

  drawFinger();
  checkClearGesture();
}

// ---------------------------
// ✅ Color picker open (Chrome showPicker first)
// ---------------------------
function openColorPicker(inputEl) {
  if (!inputEl) return;
  if (typeof inputEl.showPicker === "function") {
    inputEl.showPicker();
    return;
  }
  inputEl.focus({ preventScroll: true });
  inputEl.click();
}

// ---------------------------
// ✅ Force camera HD via track.applyConstraints
// ---------------------------
async function forceCameraHD() {
  try {
    await new Promise((res) => {
      if (video.elt.readyState >= 1) return res();
      video.elt.onloadedmetadata = () => res();
    });

    const stream = video.elt.srcObject;
    if (!stream) return;

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      await track.applyConstraints({
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 }
      });
    } catch (e1) {
      try {
        await track.applyConstraints({
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        });
      } catch (e2) {}
    }

    const s = track.getSettings();
    console.log("Camera settings:", s.width, s.height, s.frameRate);
  } catch (err) {
    console.log("forceCameraHD error:", err);
  }
}

// ---------------------------
// Cover crop (square)
// ---------------------------
function updateCoverRect() {
  const vw = video.elt.videoWidth;
  const vh = video.elt.videoHeight;
  if (!vw || !vh) return;

  const s = Math.max(width / vw, height / vh);
  const w = vw * s;
  const h = vh * s;
  const x = (width - w) / 2;
  const y = (height - h) / 2;

  cover = { x, y, w, h, s, vw, vh };
}

function drawVideoCover() {
  const vw = cover.vw;
  const vh = cover.vh;

  if (!vw || !vh) {
    image(video, 0, 0, width, height);
    return;
  }
  image(video, cover.x, cover.y, cover.w, cover.h);
}

function mapLandmarkToCanvas(lm) {
  const vw = cover.vw;
  const vh = cover.vh;
  if (!vw || !vh) return { x: lm.x * width, y: lm.y * height };

  return {
    x: cover.x + (lm.x * vw) * cover.s,
    y: cover.y + (lm.y * vh) * cover.s,
  };
}

// ---------------------------
// ✅ per-letter style helpers
// ---------------------------
function getBrushStyle() {
  const fillNone = !!fillNoneEl.input.checked;
  const strokeNone = !!strokeNoneEl.input.checked;
  return {
    fillNone,
    strokeNone,
    fill: fillColorEl.value,
    stroke: strokeColorEl.value
  };
}

function setStyleUIFromLetter(i) {
  const s = styleByLetter[i] || {
    fillNone:false, strokeNone:false, fill:"#DDE2FF", stroke:"#000000"
  };
  fillNoneEl.input.checked = !!s.fillNone;
  strokeNoneEl.input.checked = !!s.strokeNone;
  fillColorEl.value = s.fill || "#DDE2FF";
  strokeColorEl.value = s.stroke || "#000000";
  syncSwatches();
}

function saveStyleFromUIToLetter(i) {
  const s = getBrushStyle();
  styleByLetter[i] = { ...s };
}

function applyStyleToDots(dots, style) {
  if (!dots || dots.length === 0) return;
  for (let i = 0; i < dots.length; i++) {
    dots[i].fill = style.fillNone ? null : style.fill;
    dots[i].stroke = style.strokeNone ? null : style.stroke;
    dots[i].sw = style.strokeNone ? 0 : 3;
  }
}

function applyStyleToCurrentLetterAndPersist() {
  const style = getBrushStyle();
  styleByLetter[selectedIndex] = { ...style };
  applyStyleToDots(currentDots, style);

  if (savedDotsByLetter[selectedIndex] && savedDotsByLetter[selectedIndex].length) {
    savedDotsByLetter[selectedIndex] = cloneDots(currentDots);
    thumbHasData[selectedIndex] = true;
  }
}

// ---------------------------
// Drawing (dots)
// ---------------------------
function drawFinger() {
  if (!handLandmarks || handLandmarks.length === 0) {
    wasDrawing = false;
    smoothedPinchDist = null;
    lastDotPos = null;
    return;
  }

  const landmarks = handLandmarks[0];
  const I = mapLandmarkToCanvas(landmarks[8]);
  const T = mapLandmarkToCanvas(landmarks[4]);

  const rawD = dist(I.x, I.y, T.x, T.y);

  if (smoothedPinchDist == null) smoothedPinchDist = rawD;
  smoothedPinchDist = lerp(smoothedPinchDist, rawD, DIST_SMOOTHING);

  const d = smoothedPinchDist;

  if (d < PINCH_DEADZONE) {
    wasDrawing = false;
    return;
  }

  let isDrawing;
  if (!wasDrawing) {
    isDrawing = d > DRAW_ON_THRESHOLD;
  } else {
    isDrawing = d > DRAW_OFF_THRESHOLD;
  }

  if (wasDrawing && d < CLOSE_TRIGGER) {
    isDrawing = false;
    wasDrawing = false;

    if (getAnimMode() === "appear") {
      appearStartFrameByLetter[selectedIndex] = frameCount;
    }
    return;
  }

  if (isDrawing) {
    const cx = (I.x + T.x) / 2;
    const cy = (I.y + T.y) / 2;

    const nowMs = performance.now();

    let movedEnough = true;
    if (lastDotPos) {
      const md = dist(cx, cy, lastDotPos.x, lastDotPos.y);
      movedEnough = md >= MIN_POINT_DIST;
    }

    const timeEnough = (nowMs - lastDotTimeMs) >= MIN_POINT_INTERVAL_MS;

    if (movedEnough && timeEnough) {
      const minDist = 90;
      const maxDist = 200;
      const minR = 15;
      const maxR = 50;
      const r = map(constrain(d, minDist, maxDist), minDist, maxDist, minR, maxR);

      const style = getBrushStyle();

      if (!(style.fillNone && style.strokeNone)) {
        currentDots.push({
          x: cx,
          y: cy,
          r,
          fill: style.fillNone ? null : style.fill,
          stroke: style.strokeNone ? null : style.stroke,
          sw: style.strokeNone ? 0 : 3,
          order: currentDots.length,
          phase: random(TWO_PI)
        });

        lastDotTimeMs = nowMs;
        lastDotPos = { x: cx, y: cy };
      }
    }
  } else {
    lastDotPos = null;
  }

  wasDrawing = isDrawing;
}

function checkClearGesture() {
  if (!handLandmarks || handLandmarks.length < 2) {
    wasClearHandOpen = false;
    return;
  }

  const clearHand = handLandmarks[1];
  const I = mapLandmarkToCanvas(clearHand[8]);
  const T = mapLandmarkToCanvas(clearHand[4]);
  const d = dist(I.x, I.y, T.x, T.y);

  const OPEN_DIST = 80;
  const CLOSE_DIST = 20;

  if (d > OPEN_DIST) wasClearHandOpen = true;

  if (wasClearHandOpen && d < CLOSE_DIST) {
    currentDots = [];
    wasClearHandOpen = false;
    appearStartFrameByLetter[selectedIndex] = frameCount;
    lastDotPos = null;
    lastDotTimeMs = 0;
  }
}

// ---------------------------
// Anim render (main stage)
// ---------------------------
function renderDots(dots, mode, fc, appearStartFc) {
  if (!dots || dots.length === 0) return;

  let bounceY = 0;
  if (mode === "bounce") bounceY = sin(fc * 0.06) * 12;

  let visibleCount = dots.length;
  if (mode === "appear") {
    const appearFrames = Math.ceil(dots.length / APPEAR_SPEED);
    const loopLen = appearFrames + APPEAR_HOLD_FRAMES;
    const t = (fc - (appearStartFc || 0)) % Math.max(1, loopLen);
    visibleCount = Math.min(dots.length, Math.floor(t * APPEAR_SPEED));
  }

  for (let i = 0; i < dots.length; i++) {
    if (mode === "appear" && i >= visibleCount) continue;

    const p = dots[i];

    let beatScale = 1;
    if (mode === "beat") beatScale = 1 + 0.18 * sin(fc * 0.10 + p.phase);

    const rr = p.r * beatScale;

    if (p.fill) {
      noStroke();
      fill(p.fill);
    } else {
      noFill();
    }

    if (p.stroke) {
      stroke(p.stroke);
      strokeWeight(p.sw || 3);
    } else {
      noStroke();
    }

    circle(p.x, p.y + bounceY, rr);
  }
}

// ---------------------------
// Save / Redraw
// ---------------------------
function redrawCurrent() {
  currentDots = [];
  appearStartFrameByLetter[selectedIndex] = frameCount;

  savedDotsByLetter[selectedIndex] = null;
  thumbHasData[selectedIndex] = false;

  lastDotPos = null;
  lastDotTimeMs = 0;
}

function saveCurrent() {
  if (!currentDots || currentDots.length === 0) return;

  savedDotsByLetter[selectedIndex] = cloneDots(currentDots);
  saveStyleFromUIToLetter(selectedIndex);
  thumbHasData[selectedIndex] = true;

  thumbAnimStartMsByLetter[selectedIndex] = performance.now();
}

// ---------------------------
// Letter select / load saved
// ---------------------------
function selectLetter(i) {
  selectedIndex = i;
  updateLetterLabel();
  updateGridSelection();

  currentDots = [];
  appearStartFrameByLetter[selectedIndex] = frameCount;

  setAnimUIFromLetter(i);
  setStyleUIFromLetter(i);

  lastDotPos = null;
  lastDotTimeMs = 0;

  const saved = savedDotsByLetter[i];
  if (saved && saved.length) {
    currentDots = cloneDots(saved);
    applyStyleToCurrentLetterAndPersist();
    appearStartFrameByLetter[selectedIndex] = frameCount;
  }
}

function updateLetterLabel() {
  letterLabelEl.textContent = LETTERS[selectedIndex];
}

function updateGridSelection() {
  for (let i = 0; i < 26; i++) {
    const cell = gridEl.children[i];
    if (!cell) continue;
    cell.classList.toggle("selected", i === selectedIndex);
  }
}

// ---------------------------
// Grid (LIVE thumbnail canvas)
// ---------------------------
function buildGrid() {
  gridEl.innerHTML = "";

  for (let i = 0; i < GRID_SLOTS; i++) {
    const cell = div("cell");

    if (i >= 26) {
      cell.classList.add("empty");
      gridEl.appendChild(cell);
      continue;
    }

    const letter = div("letter");
    letter.textContent = LETTERS[i];

    const c = document.createElement("canvas");
    c.width = THUMB_SIZE;
    c.height = THUMB_SIZE;
    c.className = "thumbCanvas";

    const ctx = c.getContext("2d", { alpha: false });
    thumbCanvasByLetter[i] = c;
    thumbCtxByLetter[i] = ctx;
    thumbAnimStartMsByLetter[i] = performance.now();

    const expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.className = "cellExportBtn";
    expBtn.textContent = "EXPORT";

    expBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      exportLetter(i);
    });

    cell.appendChild(letter);
    cell.appendChild(c);
    cell.appendChild(expBtn);

    cell.addEventListener("click", () => selectLetter(i));
    gridEl.appendChild(cell);

    renderThumbOnce(i);
  }
}

function renderThumbOnce(i) {
  const ctx = thumbCtxByLetter[i];
  if (!ctx) return;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = "rgb(217,217,217)";
  ctx.fillRect(0,0,THUMB_SIZE,THUMB_SIZE);
}

// ---------------------------
// ✅ per-letter anim getter + UI setter
// ---------------------------
function getAnimMode() {
  return animModeByLetter[selectedIndex] || "none";
}

function setAnimUIFromLetter(i) {
  const target = animModeByLetter[i] || "none";
  for (const r of animModeRadios) {
    r.checked = (r.value === target);
  }
}

// ---------------------------
// Swatches sync
// ---------------------------
function syncSwatches() {
  if (fillNoneEl.input.checked) {
    fillColorEl.disabled = true;
    fillSwatchEl.classList.add("none");
    fillSwatchEl.style.background = "transparent";
  } else {
    fillColorEl.disabled = false;
    fillSwatchEl.classList.remove("none");
    fillSwatchEl.style.background = fillColorEl.value;
  }

  if (strokeNoneEl.input.checked) {
    strokeColorEl.disabled = true;
    strokeSwatchEl.classList.add("none");
    strokeSwatchEl.style.background = "transparent";
  } else {
    strokeColorEl.disabled = false;
    strokeSwatchEl.classList.remove("none");
    strokeSwatchEl.style.background = strokeColorEl.value;
  }
}

// ---------------------------
// ✅ LIVE thumbnail animation loop
// ---------------------------
function startThumbLoop() {
  const FPS = 24;
  const frameMs = 1000 / FPS;

  let last = 0;
  function tick(now) {
    if (now - last >= frameMs) {
      last = now;
      drawAllThumbs(now);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function drawAllThumbs(nowMs) {
  for (let i = 0; i < 26; i++) {
    const ctx = thumbCtxByLetter[i];
    if (!ctx) continue;

    const dots = savedDotsByLetter[i];
    const has = !!(dots && dots.length);
    thumbHasData[i] = has;

    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = "rgb(217,217,217)";
    ctx.fillRect(0,0,THUMB_SIZE,THUMB_SIZE);

    if (!has) continue;

    const mode = animModeByLetter[i] || "none";
    const t = (nowMs - (thumbAnimStartMsByLetter[i] || nowMs)) / 1000;

    drawDotsToThumbCtx(ctx, dots, mode, t);
  }

  for (let i = 0; i < 26; i++) {
    const cell = gridEl.children[i];
    if (!cell) continue;
    const letterEl = cell.querySelector(".letter");
    if (!letterEl) continue;
    letterEl.style.display = thumbHasData[i] ? "none" : "block";
  }
}

function drawDotsToThumbCtx(ctx, dots, mode, tSec) {
  const scale = Math.min(THUMB_SIZE / STAGE_SIZE, THUMB_SIZE / STAGE_SIZE);
  const ox = (THUMB_SIZE - STAGE_SIZE * scale) / 2;
  const oy = (THUMB_SIZE - STAGE_SIZE * scale) / 2;

  ctx.save();
  ctx.translate(THUMB_SIZE, 0);
  ctx.scale(-1, 1);

  let bounceY = 0;
  if (mode === "bounce") bounceY = Math.sin(tSec * 2.8) * 12;

  let visibleCount = dots.length;
  if (mode === "appear") {
    const fc = tSec * 60;
    const appearFrames = Math.ceil(dots.length / APPEAR_SPEED);
    const loopLen = appearFrames + APPEAR_HOLD_FRAMES;
    const tt = (fc % Math.max(1, loopLen));
    visibleCount = Math.min(dots.length, Math.floor(tt * APPEAR_SPEED));
  }

  for (let i = 0; i < dots.length; i++) {
    if (mode === "appear" && i >= visibleCount) continue;

    const p = dots[i];

    let beatScale = 1;
    if (mode === "beat") beatScale = 1 + 0.18 * Math.sin(tSec * 6.0 + (p.phase || 0));

    const rr = p.r * beatScale;

    const x = ox + p.x * scale;
    const y = oy + (p.y + bounceY) * scale;
    const r = rr * scale;

    if (p.fill) {
      ctx.fillStyle = p.fill;
      ctx.beginPath();
      ctx.arc(x, y, r/2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (p.stroke && (p.sw || 0) > 0) {
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = (p.sw || 3) * scale;
      ctx.beginPath();
      ctx.arc(x, y, r/2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------
// ✅ Export (PNG / VIDEO WebM)
// ---------------------------
function getExportFormat() {
  return exportFormatEl ? exportFormatEl.value : "png";
}

function exportLetter(i) {
  const fmt = getExportFormat();
  if (fmt === "png") {
    exportPNG(i);
  } else {
    exportVideoWebM(i);
  }
}

// ✅ CHANGED: export all
function exportAllLetters() {
  for (let i = 0; i < 26; i++) {
    const dots = savedDotsByLetter[i];
    if (!dots || !dots.length) continue;
    exportLetter(i);
  }
}

// ✅ CHANGED: PNG = transparent when saveMode === "type"
function exportPNG(i) {
  const dots = savedDotsByLetter[i];
  if (!dots || !dots.length) return;

  const modeSave = getSaveMode(); // type | camera

  const out = document.createElement("canvas");
  out.width = STAGE_SIZE;
  out.height = STAGE_SIZE;

  // ✅ alpha true for transparency
  const ctx = out.getContext("2d", { alpha: true });

  // ✅ clear canvas (transparent)
  ctx.clearRect(0, 0, STAGE_SIZE, STAGE_SIZE);

  // camera background stays as-is (drawn image becomes background)
  if (modeSave === "camera") {
    const vw = cover.vw || video.elt.videoWidth;
    const vh = cover.vh || video.elt.videoHeight;
    if (vw && vh) {
      const s = Math.max(STAGE_SIZE / vw, STAGE_SIZE / vh);
      const w = vw * s;
      const h = vh * s;
      const x = (STAGE_SIZE - w) / 2;
      const y = (STAGE_SIZE - h) / 2;

      ctx.save();
      ctx.translate(STAGE_SIZE, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video.elt, x, y, w, h);
      ctx.restore();
    }
  }
  // ✅ type-only: no gray fill at all => transparent PNG

  const mode = animModeByLetter[i] || "none";
  const tSec = (performance.now() - (thumbAnimStartMsByLetter[i] || performance.now())) / 1000;

  drawDotsToExportCtx(ctx, dots, mode, tSec);

  const url = out.toDataURL("image/png");
  downloadDataURL(url, `${LETTERS[i]}_bubble.png`);
}

function drawDotsToExportCtx(ctx, dots, mode, tSec) {
  ctx.save();
  ctx.translate(STAGE_SIZE, 0);
  ctx.scale(-1, 1);

  let bounceY = 0;
  if (mode === "bounce") bounceY = Math.sin(tSec * 2.8) * 12;

  let visibleCount = dots.length;
  if (mode === "appear") {
    const fc = tSec * 60;
    const appearFrames = Math.ceil(dots.length / APPEAR_SPEED);
    const loopLen = appearFrames + APPEAR_HOLD_FRAMES;
    const tt = (fc % Math.max(1, loopLen));
    visibleCount = Math.min(dots.length, Math.floor(tt * APPEAR_SPEED));
  }

  for (let i = 0; i < dots.length; i++) {
    if (mode === "appear" && i >= visibleCount) continue;

    const p = dots[i];
    let beatScale = 1;
    if (mode === "beat") beatScale = 1 + 0.18 * Math.sin(tSec * 6.0 + (p.phase || 0));
    const rr = p.r * beatScale;

    const x = p.x;
    const y = p.y + bounceY;
    const r = rr;

    if (p.fill) {
      ctx.fillStyle = p.fill;
      ctx.beginPath();
      ctx.arc(x, y, r/2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (p.stroke && (p.sw || 0) > 0) {
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = (p.sw || 3);
      ctx.beginPath();
      ctx.arc(x, y, r/2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ✅ NOTE: video export는 그대로(배경 회색 유지) 원하면 다음에 투명 WebM도 가능
async function exportVideoWebM(i) {
  const dots = savedDotsByLetter[i];
  if (!dots || !dots.length) return;

  const modeSave = getSaveMode(); // type | camera
  const mode = animModeByLetter[i] || "none";

  const out = document.createElement("canvas");
  out.width = STAGE_SIZE;
  out.height = STAGE_SIZE;

  // ✅ alpha:true so canvas can carry transparency
  const ctx = out.getContext("2d", { alpha: true });

  const FPS = 30;
  const stream = out.captureStream(FPS);

  // ✅ Prefer VP9 (best chance for alpha)
  let mime = "";
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) mime = "video/webm;codecs=vp9";
  else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) mime = "video/webm;codecs=vp8";
  else mime = "video/webm";

  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000
  });

  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const DURATION_SEC = 3.0;
  const totalFrames = Math.floor(DURATION_SEC * FPS);
  const startMs = performance.now();

  rec.start();

  for (let f = 0; f < totalFrames; f++) {
    const tSec = (performance.now() - startMs) / 1000;

    // ✅ Always clear to transparent each frame
    ctx.clearRect(0, 0, STAGE_SIZE, STAGE_SIZE);

    // ✅ If camera mode, draw camera (no transparency because pixels exist)
    if (modeSave === "camera") {
      const vw = cover.vw || video.elt.videoWidth;
      const vh = cover.vh || video.elt.videoHeight;
      if (vw && vh) {
        const s = Math.max(STAGE_SIZE / vw, STAGE_SIZE / vh);
        const w = vw * s;
        const h = vh * s;
        const x = (STAGE_SIZE - w) / 2;
        const y = (STAGE_SIZE - h) / 2;

        ctx.save();
        ctx.translate(STAGE_SIZE, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video.elt, x, y, w, h);
        ctx.restore();
      }
    }
    // ✅ type-only: leave background transparent

    drawDotsToExportCtx(ctx, dots, mode, tSec);
    await waitMs(1000 / FPS);
  }

  rec.stop();

  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  // ✅ optional: quick warning if browser likely stripped alpha
  console.log("Recorded:", mime, "size:", blob.size);

  const url = URL.createObjectURL(blob);
  const suffix = (modeSave === "type") ? "_alpha" : "";
  downloadURL(url, `${LETTERS[i]}_bubble${suffix}.webm`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function waitMs(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function downloadDataURL(dataURL, filename) {
  const a = document.createElement("a");
  a.href = dataURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadURL(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------
// Save mode getter
// ---------------------------
function getSaveMode() {
  for (const r of saveModeRadios) if (r.checked) return r.value;
  return "type";
}

// ---------------------------
// DOM build
// ---------------------------
function buildDOM() {
  appEl = document.getElementById("app");
  appEl.innerHTML = "";

  const page = div("page");

  // LEFT PANEL
  const panel = div("side");
  panel.appendChild(divText("title", "BUBBLE TYPE DRAWING"));

  const desc = div("desc");
  desc.innerHTML =
    "Draw your own typeface using two fingers. Choose a letter on the right and draw with your thumb and index finger." +
    " Adjust the circle size by moving your fingers closer together or farther apart." +
    " When finished, bring your fingers together and click Save or Redraw.";
  panel.appendChild(desc);

  panel.appendChild(hr("rule"));

  // Save mode
  const saveGroup = div("group");
  const sm1 = radioRowBare("saveMode", "type", true, "Save Type Only");
  const sm2 = radioRowBare("saveMode", "camera", false, "Save with Camera");
  saveModeRadios = [sm1.input, sm2.input];
  saveGroup.appendChild(sm1.row);
  saveGroup.appendChild(sm2.row);
  panel.appendChild(saveGroup);

  panel.appendChild(hr("rule"));

  // Color group + None UI
  const colorGroup = div("group2");

  const fillRow = div("row");
  fillRow.appendChild(divText("rowLabel", "Fill"));

  const fillNoneWrap = div("noneWrap");
  const fillNoneLabel = document.createElement("span");
  fillNoneLabel.textContent = "None";
  fillNoneEl = checkboxBare("fillNone");
  fillNoneWrap.appendChild(fillNoneLabel);
  fillNoneWrap.appendChild(fillNoneEl.input);
  fillRow.appendChild(fillNoneWrap);

  fillSwatchEl = document.createElement("button");
  fillSwatchEl.type = "button";
  fillSwatchEl.className = "swatch";
  fillRow.appendChild(fillSwatchEl);

  fillColorEl = document.createElement("input");
  fillColorEl.type = "color";
  fillColorEl.value = "#DDE2FF";
  fillColorEl.className = "color-hidden";
  fillRow.appendChild(fillColorEl);

  const strokeRow = div("row");
  strokeRow.appendChild(divText("rowLabel", "Stroke"));

  const strokeNoneWrap = div("noneWrap");
  const strokeNoneLabel = document.createElement("span");
  strokeNoneLabel.textContent = "None";
  strokeNoneEl = checkboxBare("strokeNone");
  strokeNoneWrap.appendChild(strokeNoneLabel);
  strokeNoneWrap.appendChild(strokeNoneEl.input);
  strokeRow.appendChild(strokeNoneWrap);

  strokeSwatchEl = document.createElement("button");
  strokeSwatchEl.type = "button";
  strokeSwatchEl.className = "swatch swatch-stroke";
  strokeRow.appendChild(strokeSwatchEl);

  strokeColorEl = document.createElement("input");
  strokeColorEl.type = "color";
  strokeColorEl.value = "#000000";
  strokeColorEl.className = "color-hidden";
  strokeRow.appendChild(strokeColorEl);

  colorGroup.appendChild(fillRow);
  colorGroup.appendChild(strokeRow);
  panel.appendChild(colorGroup);

  panel.appendChild(hr("rule"));

  // Anim group
  const animGroup = div("group");
  const am0 = radioRowBare("animMode", "none", true, "None");
  const am1 = radioRowBare("animMode", "bounce", false, "Bounce");
  const am2 = radioRowBare("animMode", "beat", false, "Beat");
  const am3 = radioRowBare("animMode", "appear", false, "Appear");
  animModeRadios = [am0.input, am1.input, am2.input, am3.input];

  animGroup.appendChild(am0.row);
  animGroup.appendChild(am1.row);
  animGroup.appendChild(am2.row);
  animGroup.appendChild(am3.row);
  panel.appendChild(animGroup);

  panel.appendChild(hr("rule"));

  // ✅ Export format selector (panel)
  const exportGroup = div("group");
  const expRow = div("exportRow");
  const expLabel = document.createElement("span");
  expLabel.textContent = "Export format";

  exportFormatEl = document.createElement("select");
  exportFormatEl.className = "exportSelect";
  const opt1 = document.createElement("option");
  opt1.value = "png";
  opt1.textContent = "PNG";
  const opt2 = document.createElement("option");
  opt2.value = "video";
  opt2.textContent = "VIDEO (WebM → MP4)";
  exportFormatEl.appendChild(opt1);
  exportFormatEl.appendChild(opt2);

  expRow.appendChild(expLabel);
  expRow.appendChild(exportFormatEl);
  exportGroup.appendChild(expRow);

  // current letter export button
  const expBtn = button("EXPORT CURRENT LETTER", "exportBtn");
  expBtn.addEventListener("click", () => exportLetter(selectedIndex));
  exportGroup.appendChild(expBtn);

  // ✅ CHANGED: export all letters button
  const expAllBtn = button("EXPORT EVERY LETTER", "exportBtn");
  expAllBtn.addEventListener("click", exportAllLetters);
  exportGroup.appendChild(expAllBtn);

  panel.appendChild(exportGroup);

  // CENTER
  const center = div("center");
  const stageWrap = div("stageWrap");

  stageEl = div("stage");
  letterLabelEl = div("letterLabel");
  letterLabelEl.textContent = "A";

  const topBtns = div("topBtns");
  redrawBtnEl = button("REDRAW", "pillBtn");
  saveBtnEl = button("SAVE", "pillBtn");
  topBtns.appendChild(redrawBtnEl);
  topBtns.appendChild(saveBtnEl);

  stageWrap.appendChild(topBtns);
  stageWrap.appendChild(letterLabelEl);
  stageWrap.appendChild(stageEl);
  center.appendChild(stageWrap);

  // RIGHT GRID
  const right = div("right");
  gridEl = div("grid");
  right.appendChild(gridEl);

  page.appendChild(panel);
  page.appendChild(center);
  page.appendChild(right);
  appEl.appendChild(page);

  document.body.appendChild(fillColorEl);
  document.body.appendChild(strokeColorEl);
}

// ---------------------------
// Styles
// ---------------------------
function injectStyles() {
  const css = `
    *{ box-sizing:border-box; }
    html,body{ height:100%; }
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background:#fff;
    }

    .page{
      display:flex;
      gap:28px;
      padding:26px;
      align-items:flex-start;
      background:#fff;
      margin:0;
      outline:none;
    }

    /* LEFT */
    .side{
      width:320px;
      padding:22px 18px;
    }
    .title{
      font-size:12px;
      font-weight:700;
      margin-bottom:10px;
    }
    .desc{
      font-size:10px;
      line-height:1.35;
      max-width:280px;
    }
    .rule{
      border:none;
      border-top:1px solid #888;
      margin:16px 0;
    }

    .group{
      display:flex;
      flex-direction:column;
      gap:10px;
      font-size:10px;
      max-width:260px;
    }
    .radioRow{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    .radioRow input{ transform: translateY(1px); }

    .group2{
      display:flex;
      flex-direction:column;
      gap:12px;
      max-width:260px;
      font-size:10px;
    }
    .row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .rowLabel{ width:54px; }

    .noneWrap{
      display:flex;
      align-items:center;
      gap:8px;
      margin-left:auto;
      margin-right:10px;
      color:#111;
    }
    .noneWrap input{ transform: translateY(1px); }

    .swatch{
      width:18px; height:18px;
      border-radius:999px;
      border:1px solid #111;
      background:#DDE2FF;
      padding:0;
      cursor:pointer;
    }
    .swatch-stroke{ background:#000; }

    .swatch.none{
      background:transparent !important;
      position:relative;
    }
    .swatch.none::after{
      content:"";
      position:absolute;
      left:2px; top:8px;
      width:14px; height:2px;
      background:#111;
      transform:rotate(-35deg);
      opacity:0.75;
    }

    .color-hidden{
      position:fixed;
      left:0; top:0;
      width:1px; height:1px;
      opacity:0.001;
      z-index:-1;
    }

    .exportRow{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    .exportSelect{
      border:1px solid #111;
      background:#fff;
      font-size:10px;
      padding:4px 8px;
      border-radius:999px;
      cursor:pointer;
    }
    .exportBtn{
      border:1px solid #111;
      background:#fff;
      border-radius:999px;
      padding:8px 12px;
      font-size:10px;
      cursor:pointer;
    }
    .exportBtn:hover{ background:#f2f2f2; }

    /* CENTER */
    .center{ width:${STAGE_SIZE}px; }
    .stageWrap{
      position:relative;
      width:${STAGE_SIZE}px;
      height:${STAGE_SIZE}px;
      background:#d9d9d9;
      outline:1px solid #111;
      overflow:hidden;
    }
    .stage canvas{ display:block; }

    .topBtns{
      position:absolute;
      top:18px;
      left:50%;
      transform:translateX(-50%);
      display:flex;
      gap:18px;
      z-index:20;
    }
    .pillBtn{
      border:1px solid #111;
      background:#fff;
      border-radius:999px;
      padding:6px 16px;
      font-size:12px;
      cursor:pointer;
    }
    .pillBtn:hover{ background:#f2f2f2; }

    .letterLabel{
      position:absolute;
      top:18px;
      left:50%;
      transform:translateX(-50%);
      color:#fff;
      font-size:16px;
      letter-spacing:0.6px;
      pointer-events:none;
      z-index:10;
      text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      display:none;
    }

    /* RIGHT GRID */
    .right{
      width:420px;
      padding:10px 0 0 0;
    }
    .grid{
      display:grid;
      grid-template-columns: repeat(4, 86px);
      gap:16px;
      justify-content:flex-end;
    }
    .cell{
      width:86px; height:86px;
      background:#d9d9d9;
      border:3px solid transparent;
      position:relative;
      overflow:hidden;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .cell.empty{ background:#f3f3f3; cursor:default; }
    .cell.selected{ border-color:#111; }

    .cell .letter{
      position:absolute;
      font-size:14px;
      font-weight:700;
      color:rgba(0,0,0,0.25);
      pointer-events:none;
      z-index:3;
    }

    .thumbCanvas{
      width:100%;
      height:100%;
      display:block;
      z-index:1;
      background:#d9d9d9;
    }

    /* ✅ CHANGED: center align export button horizontally inside the cell */
    .cellExportBtn{
      position:absolute;
      left:50%;
      transform:translateX(-50%);
      bottom:6px;
      z-index:4;
      border:1px solid #111;
      background:#fff;
      font-size:9px;
      padding:3px 6px;
      border-radius:999px;
      cursor:pointer;
      opacity:0.9;
      white-space:nowrap;
    }
    .cellExportBtn:hover{ background:#f2f2f2; }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

// ---------------------------
// Wire UI
// ---------------------------
function wireUI() {
  fillSwatchEl.addEventListener("click", () => {
    if (!fillNoneEl.input.checked) openColorPicker(fillColorEl);
  });
  strokeSwatchEl.addEventListener("click", () => {
    if (!strokeNoneEl.input.checked) openColorPicker(strokeColorEl);
  });

  fillColorEl.addEventListener("input", () => {
    syncSwatches();
    applyStyleToCurrentLetterAndPersist();
  });
  strokeColorEl.addEventListener("input", () => {
    syncSwatches();
    applyStyleToCurrentLetterAndPersist();
  });
  fillNoneEl.input.addEventListener("change", () => {
    syncSwatches();
    applyStyleToCurrentLetterAndPersist();
  });
  strokeNoneEl.input.addEventListener("change", () => {
    syncSwatches();
    applyStyleToCurrentLetterAndPersist();
  });

  for (const r of animModeRadios) {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      animModeByLetter[selectedIndex] = r.value;
      appearStartFrameByLetter[selectedIndex] = frameCount;
      thumbAnimStartMsByLetter[selectedIndex] = performance.now();
    });
  }

  syncSwatches();

  saveBtnEl.addEventListener("click", saveCurrent);
  redrawBtnEl.addEventListener("click", redrawCurrent);
}

// ---------------------------
// Helpers
// ---------------------------
function cloneDots(dots) {
  return dots.map(d => ({ ...d }));
}

function div(className) {
  const d = document.createElement("div");
  if (className) d.className = className;
  return d;
}
function divText(className, text) {
  const d = div(className);
  d.textContent = text;
  return d;
}
function button(text, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className || "";
  b.textContent = text;
  return b;
}
function hr(className) {
  const h = document.createElement("hr");
  h.className = className || "";
  return h;
}
function radioRowBare(name, value, checked, labelText) {
  const row = div("radioRow");

  const label = document.createElement("span");
  label.textContent = labelText;

  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = !!checked;

  row.appendChild(label);
  row.appendChild(input);

  return { row, input };
}
function checkboxBare(id) {
  const wrapper = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  wrapper.appendChild(input);
  return { wrapper, input };
}