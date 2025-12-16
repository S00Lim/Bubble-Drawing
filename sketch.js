/***********************
  Bubble Type Drawing (Square Stage)
  - JS builds: layout + styles + DOM
  - Anim modes: None / Bounce / Beat / Appear(loop)
  - No floating layer on pinch-close

  ✅ FIXED (hybrid smooth drawing + anti-jump):
    1) 손 선택 안정화 + 다른 손 오인 감소
       - 후보 손 필터링(너무 닫힌 핀치 제외) + 앵커 기반 선택 + 드로잉 중 lock
    2) 드로잉 끊김 감소 (예전처럼 “항상 찍는 느낌”)
       - 시간 gate 최소화(거리 gate 중심) + 제한적 gap-fill
    3) 핀치 on/off 안정화
       - 히스테리시스 + 연속 프레임 확인 + stop 후 쿨다운
    4) 사이즈 변화 부드럽게
       - r(브러시 크기) 스무딩
    ✅ NEW:
    5) “삐끗” 점프 프레임에서 제자리 왕복/폭발 방지
       - jump reset + gap-fill 금지 + short freeze
    6) 브러시 위치(cx,cy)도 스무딩 (핀치만 스무딩하던 문제 해결)
***********************/

// ===== Media / p5 =====
let video, hands, camera;
let handLandmarks = [];
let handHandedness = [];

// ===== UI (DOM) =====
let appEl, stageEl, gridEl;
let letterLabelEl, saveBtnEl, redrawBtnEl;

let fillNoneEl, strokeNoneEl;
let fillColorEl, strokeColorEl;
let fillSwatchEl, strokeSwatchEl;

let saveModeRadios = [];
let animModeRadios = [];

let exportFormatEl;

// ===== letters + grid =====
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const GRID_SLOTS = 28;
let selectedIndex = 0;

// ===== layout sizes =====
const STAGE_SIZE = 860;
const THUMB_SIZE = 120;

// ===== cover crop params =====
let cover = { x: 0, y: 0, w: 0, h: 0, s: 1, vw: 0, vh: 0 };

// ===== drawing data (dots) =====
let currentDots = [];
let savedDotsByLetter = Array(26).fill(null);

// per-letter anim state
let animModeByLetter = Array(26).fill("none");
let appearStartFrameByLetter = Array(26).fill(0);

// per-letter style state
let styleByLetter = Array(26).fill(null).map(() => ({
  fillNone: false,
  strokeNone: false,
  fill: "#DDE2FF",
  stroke: "#000000"
}));

// live thumbnail canvas refs
let thumbCanvasByLetter = Array(26).fill(null);
let thumbCtxByLetter = Array(26).fill(null);
let thumbHasData = Array(26).fill(false);
let thumbAnimStartMsByLetter = Array(26).fill(0);

// ===== drawing state =====
let wasDrawing = false;
let wasClearHandOpen = false;

// ================================
// ✅ PINCH + DRAWING TUNING (STABLE)
// ================================

// Normalized distances
const DRAW_ON_N   = 0.095;
const DRAW_OFF_N  = 0.070;
const DEAD_N      = 0.065;
const CLOSE_N     = 0.060;
const RAW_CLOSE_N = 0.058; // 더 “즉시 스탑” 강하게

// Anti jitter and sampling
const DIST_SMOOTHING_N = 0.18;

// ✅ 핵심: 끊김 줄이려고 “시간 gate” 거의 제거 (거리 gate 중심)
const MIN_POINT_INTERVAL_MS = 0; // 0으로 두고 거리 기준으로만 찍음
const MIN_POINT_DIST = 14;        // 촘촘하면 ↑, 듬성하면 ↓

// Stop then accidental tiny dots prevention
const STOP_COOLDOWN_FRAMES = 7;
let stopCooldown = 0;

// Debounce frames (drawing state stability)
const START_CONFIRM_FRAMES = 2;
const STOP_CONFIRM_FRAMES  = 2;
let startCount = 0;
let stopCount = 0;

// Gap fill limit
const MAX_GAP_STEPS = 18;

// Appear anim config
const APPEAR_SPEED = 1.6;
const APPEAR_HOLD_FRAMES = 24;

// internal helpers
let smoothedPinchN = null;
let lastDotTimeMs = 0;
let lastDotPos = null;

// ✅ 사이즈 스무딩
let smoothedR = null;
const R_SMOOTHING = 0.22;

// ✅ index-only pinch guard
const INDEX_ONLY = true;
const OTHER_FINGER_BLOCK_N = 0.060;

// ✅ hand selection + lock
let lockedHandIdx = -1;
let lockLostFrames = 0;
const LOCK_LOST_FRAMES_MAX = 8;

// ✅ 손 선택 안정화용 “앵커”(이전 프레임 index tip 위치)
let lastAnchorN = null; // {x,y} normalized
let anchorHoldFrames = 0;
const ANCHOR_HOLD_MAX = 10;

// ================================
// ✅ NEW: Anti-jump / Outlier guard
// ================================
const JUMP_RESET_DIST = 120;       // px: 갑자기 점프하면 선 끊기
const MAX_GAP_DIST    = 160;       // px: 이 이상이면 gap-fill 금지
const FREEZE_AFTER_JUMP_FRAMES = 2;
let freezeAfterJump = 0;

// ✅ NEW: Brush position smoothing
let smoothedPos = null;
const POS_SMOOTHING = 0.35;        // 0.25~0.45 추천

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
    handHandedness = results.multiHandedness || [];
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
// Color picker open
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
// Force camera HD
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
// per-letter style helpers
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
// ✅ Hand picking + lock (improved)
// ---------------------------
function pinchDistN(lm) {
  return dist(lm[8].x, lm[8].y, lm[4].x, lm[4].y);
}

function indexTipN(lm) {
  return { x: lm[8].x, y: lm[8].y };
}

function scoreHandForPick(lm) {
  // 1) 너무 닫힌 핀치 제외
  const dN = pinchDistN(lm);
  if (dN < DEAD_N) return -Infinity;

  // 2) 앵커에 가까울수록 점수 ↑
  let anchorScore = 0;
  if (lastAnchorN) {
    const it = indexTipN(lm);
    const dd = dist(it.x, it.y, lastAnchorN.x, lastAnchorN.y);
    anchorScore = -dd;
  }

  // 3) DRAW_ON 근처 선호
  const target = DRAW_ON_N;
  const dScore = -Math.abs(dN - target);

  return anchorScore * 2.2 + dScore * 0.8;
}

function pickBestHandIndex() {
  if (!handLandmarks || handLandmarks.length === 0) return -1;

  // 드로잉 중 lock 유지
  if (wasDrawing && lockedHandIdx >= 0 && lockedHandIdx < handLandmarks.length) {
    return lockedHandIdx;
  }

  let best = -1;
  let bestScore = -Infinity;
  for (let h = 0; h < handLandmarks.length; h++) {
    const lm = handLandmarks[h];
    const sc = scoreHandForPick(lm);
    if (sc > bestScore) {
      bestScore = sc;
      best = h;
    }
  }
  return best;
}

function updateHandLock(chosenIdx) {
  if (chosenIdx < 0) {
    lockLostFrames++;
    if (lockLostFrames > LOCK_LOST_FRAMES_MAX) lockedHandIdx = -1;
    return;
  }

  lockLostFrames = 0;

  // 드로잉 중에만 lock
  if (wasDrawing) lockedHandIdx = chosenIdx;
  else lockedHandIdx = -1;

  // 앵커 갱신
  const lm = handLandmarks[chosenIdx];
  const it = indexTipN(lm);
  lastAnchorN = { x: it.x, y: it.y };
  anchorHoldFrames = ANCHOR_HOLD_MAX;
}

// ---------------------------
// Drawing (dots) - hybrid smooth + anti-jump
// ---------------------------
function drawFinger() {
  if (!handLandmarks || handLandmarks.length === 0) {
    hardResetFingerState();
    return;
  }

  if (anchorHoldFrames > 0) anchorHoldFrames--;
  else lastAnchorN = null;

  const hIdx = pickBestHandIndex();
  updateHandLock(hIdx);
  if (hIdx < 0) return;

  const landmarks = handLandmarks[hIdx];

  // index-only guard (normalized)
  if (INDEX_ONLY) {
    const thumb = landmarks[4];
    const idx   = landmarks[8];
    const mid   = landmarks[12];
    const ring  = landmarks[16];
    const pink  = landmarks[20];

    const dIdx  = dist(thumb.x, thumb.y, idx.x, idx.y);
    const dMid  = dist(thumb.x, thumb.y, mid.x, mid.y);
    const dRing = dist(thumb.x, thumb.y, ring.x, ring.y);
    const dPink = dist(thumb.x, thumb.y, pink.x, pink.y);

    const minOther = Math.min(dMid, dRing, dPink);

    if (minOther < dIdx && minOther < OTHER_FINGER_BLOCK_N) {
      wasDrawing = false;
      lastDotPos = null;
      startCount = 0;
      stopCount = 0;
      smoothedPos = null;
      return;
    }
  }

  // normalized pinch distance
  const rawN = pinchDistN(landmarks);
  if (smoothedPinchN == null) smoothedPinchN = rawN;
  smoothedPinchN = lerp(smoothedPinchN, rawN, DIST_SMOOTHING_N);
  const dN = smoothedPinchN;

  // 즉시 stop (raw 기준)
  if (rawN < RAW_CLOSE_N) {
    if (wasDrawing) stopDrawingNow();
    return;
  }

  if (stopCooldown > 0) stopCooldown--;

  // Hard stop if too close
  if (dN < CLOSE_N) {
    if (wasDrawing) stopDrawingNow();
    return;
  }

  // Dead zone
  if (dN < DEAD_N) {
    wasDrawing = false;
    lastDotPos = null;
    startCount = 0;
    stopCount = 0;
    smoothedPos = null;
    return;
  }

  // Debounced hysteresis
  let wantDraw = wasDrawing;

  if (!wasDrawing) {
    if (dN > DRAW_ON_N && stopCooldown === 0) {
      startCount++;
      if (startCount >= START_CONFIRM_FRAMES) {
        wantDraw = true;
        startCount = 0;
      }
    } else {
      startCount = 0;
    }
  } else {
    if (dN < DRAW_OFF_N) {
      stopCount++;
      if (stopCount >= STOP_CONFIRM_FRAMES) {
        wantDraw = false;
        stopCount = 0;
        stopCooldown = STOP_COOLDOWN_FRAMES;

        if (getAnimMode() === "appear") {
          appearStartFrameByLetter[selectedIndex] = frameCount;
        }
      }
    } else {
      stopCount = 0;
    }
  }

  // Pixel positions
  const Ipx = mapLandmarkToCanvas(landmarks[8]);
  const Tpx = mapLandmarkToCanvas(landmarks[4]);

  // Stable blend factor
  const w = constrain(map(dN, DEAD_N, DRAW_ON_N, 0.18, 0.48), 0.18, 0.48);
  const rawCx = lerp(Ipx.x, Tpx.x, w);
  const rawCy = lerp(Ipx.y, Tpx.y, w);

  // ✅ NEW: Position smoothing
  if (!smoothedPos) smoothedPos = { x: rawCx, y: rawCy };
  smoothedPos.x = lerp(smoothedPos.x, rawCx, POS_SMOOTHING);
  smoothedPos.y = lerp(smoothedPos.y, rawCy, POS_SMOOTHING);

  const cx = smoothedPos.x;
  const cy = smoothedPos.y;

  // Brush radius from pixel distance + smoothing
  const dPx = dist(Ipx.x, Ipx.y, Tpx.x, Tpx.y);
  const minDist = 90;
  const maxDist = 200;
  const minR = 15;
  const maxR = 50;

  const rawR = map(constrain(dPx, minDist, maxDist), minDist, maxDist, minR, maxR);
  if (smoothedR == null) smoothedR = rawR;
  smoothedR = lerp(smoothedR, rawR, R_SMOOTHING);
  const r = smoothedR;

  const style = getBrushStyle();
  if (style.fillNone && style.strokeNone) {
    wasDrawing = wantDraw;
    return;
  }

  if (wantDraw) {
    const nowMs = performance.now();

    // freeze after jump (prevents ping-pong explosion)
    if (freezeAfterJump > 0) {
      freezeAfterJump--;
      lastDotPos = { x: cx, y: cy };
      lastDotTimeMs = nowMs;
      wasDrawing = wantDraw;
      return;
    }

    let md = Infinity;
    if (lastDotPos) md = dist(cx, cy, lastDotPos.x, lastDotPos.y);

    // ✅ NEW: Jump reset (line break)
    if (lastDotPos && md > JUMP_RESET_DIST) {
      lastDotPos = { x: cx, y: cy };
      lastDotTimeMs = nowMs;
      freezeAfterJump = FREEZE_AFTER_JUMP_FRAMES;
      wasDrawing = wantDraw;
      return;
    }

    // ✅ NEW: Too far -> do NOT gap-fill
    if (lastDotPos && md > MAX_GAP_DIST) {
      lastDotPos = { x: cx, y: cy };
      lastDotTimeMs = nowMs;
      wasDrawing = wantDraw;
      return;
    }

    // time gate (0이면 사실상 항상 통과)
    const timeEnough = (nowMs - lastDotTimeMs) >= MIN_POINT_INTERVAL_MS;

    if (!lastDotPos) {
      pushDot(cx, cy, r, style);
      lastDotPos = { x: cx, y: cy };
      lastDotTimeMs = nowMs;
    } else {
      if (md >= MIN_POINT_DIST && timeEnough) {
        const steps = Math.min(MAX_GAP_STEPS, Math.max(1, Math.floor(md / MIN_POINT_DIST)));
        for (let s = 1; s <= steps; s++) {
          const tt = s / steps;
          const x = lerp(lastDotPos.x, cx, tt);
          const y = lerp(lastDotPos.y, cy, tt);
          pushDot(x, y, r, style);
        }
        lastDotPos = { x: cx, y: cy };
        lastDotTimeMs = nowMs;
      }
    }
  } else {
    lastDotPos = null;
  }

  wasDrawing = wantDraw;
}

function stopDrawingNow() {
  wasDrawing = false;
  lastDotPos = null;
  startCount = 0;
  stopCount = 0;
  stopCooldown = STOP_COOLDOWN_FRAMES;
  freezeAfterJump = 0;
  smoothedPos = null;

  if (getAnimMode() === "appear") {
    appearStartFrameByLetter[selectedIndex] = frameCount;
  }
}

function hardResetFingerState() {
  wasDrawing = false;
  smoothedPinchN = null;
  lastDotPos = null;
  lastDotTimeMs = 0;
  startCount = 0;
  stopCount = 0;
  stopCooldown = 0;
  lockedHandIdx = -1;
  smoothedR = null;
  lastAnchorN = null;
  anchorHoldFrames = 0;

  freezeAfterJump = 0;
  smoothedPos = null;
}

function pushDot(x, y, r, style) {
  currentDots.push({
    x,
    y,
    r,
    fill: style.fillNone ? null : style.fill,
    stroke: style.strokeNone ? null : style.stroke,
    sw: style.strokeNone ? 0 : 3,
    order: currentDots.length,
    phase: random(TWO_PI)
  });
}

function checkClearGesture() {
  if (!handLandmarks || handLandmarks.length < 2) {
    wasClearHandOpen = false;
    return;
  }

  const clearHand = handLandmarks[1];
  const dN = dist(clearHand[8].x, clearHand[8].y, clearHand[4].x, clearHand[4].y);

  const OPEN_N  = 0.10;
  const CLOSE_N2 = 0.05;

  if (dN > OPEN_N) wasClearHandOpen = true;

  if (wasClearHandOpen && dN < CLOSE_N2) {
    currentDots = [];
    wasClearHandOpen = false;
    appearStartFrameByLetter[selectedIndex] = frameCount;

    lastDotPos = null;
    lastDotTimeMs = 0;
    smoothedPinchN = null;
    smoothedR = null;
    smoothedPos = null;
    freezeAfterJump = 0;

    wasDrawing = false;
    startCount = 0;
    stopCount = 0;
    stopCooldown = STOP_COOLDOWN_FRAMES;
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
  smoothedPinchN = null;
  smoothedR = null;
  smoothedPos = null;
  freezeAfterJump = 0;

  wasDrawing = false;
  startCount = 0;
  stopCount = 0;
  stopCooldown = STOP_COOLDOWN_FRAMES;
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
  smoothedPinchN = null;
  smoothedR = null;
  smoothedPos = null;
  freezeAfterJump = 0;

  wasDrawing = false;
  startCount = 0;
  stopCount = 0;
  stopCooldown = STOP_COOLDOWN_FRAMES;

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

// per-letter anim getter + UI setter
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
// LIVE thumbnail animation loop
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
// Export (PNG / VIDEO WebM)
// ---------------------------
function getExportFormat() {
  return exportFormatEl ? exportFormatEl.value : "png";
}

function exportLetter(i) {
  const fmt = getExportFormat();
  if (fmt === "png") exportPNG(i);
  else exportVideoWebM(i);
}

function exportAllLetters() {
  for (let i = 0; i < 26; i++) {
    const dots = savedDotsByLetter[i];
    if (!dots || !dots.length) continue;
    exportLetter(i);
  }
}

// PNG = transparent when saveMode === "type"
function exportPNG(i) {
  const dots = savedDotsByLetter[i];
  if (!dots || !dots.length) return;

  const modeSave = getSaveMode(); // type | camera

  const out = document.createElement("canvas");
  out.width = STAGE_SIZE;
  out.height = STAGE_SIZE;

  const ctx = out.getContext("2d", { alpha: true });
  ctx.clearRect(0, 0, STAGE_SIZE, STAGE_SIZE);

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

async function exportVideoWebM(i) {
  const dots = savedDotsByLetter[i];
  if (!dots || !dots.length) return;

  const modeSave = getSaveMode(); // type | camera
  const mode = animModeByLetter[i] || "none";

  const out = document.createElement("canvas");
  out.width = STAGE_SIZE;
  out.height = STAGE_SIZE;

  const ctx = out.getContext("2d", { alpha: true });

  const FPS = 30;
  const stream = out.captureStream(FPS);

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

    ctx.clearRect(0, 0, STAGE_SIZE, STAGE_SIZE);

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

    drawDotsToExportCtx(ctx, dots, mode, tSec);
    await waitMs(1000 / FPS);
  }

  rec.stop();

  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

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

  // Export format selector
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

  const expBtn = button("EXPORT CURRENT LETTER", "exportBtn");
  expBtn.addEventListener("click", () => exportLetter(selectedIndex));
  exportGroup.appendChild(expBtn);

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