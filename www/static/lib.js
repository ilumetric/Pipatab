"use strict";
// Pipatab — Stylus-first wireless tablet client
// Apple Pencil drives pen input. When the Pencil is away, touch can act as a trackpad.
// Hover, pressure, tilt, twist, barrel button, eraser — all forwarded.
// ─── State ────────────────────────────────────────────────────────────────────
let ws = null;
let canvas;
let ctx;
let statusDot;
let connectionOverlay;
let connectionTitle;
let connectionStateText;
let connectionDetailText;
let connectionAttemptText;
let connectionHostText;
let monitorSelect;
let pressurePreview;
let pressurePreviewCtx;
let pencilSqueezeSelect;
let settingsPanel;
let btnTrackpadMode;
let btnTrackpadZoom;
let btnTrackpadDragHold;
let btnTrackpadDragDoubleTap;
let trackpadDragModeControl;
let trackpadHoldDelayGroup;
let trackpadHoldDelayInput;
let trackpadHoldDelayValue;
let pressureReadoutStart;
let pressureReadoutMiddle;
let pressureReadoutEnd;
let reconnectTimer = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let heartbeatConsecutiveMisses = 0;
let pendingPenBatch = [];
let penBatchFlushFrame = null;
let pressurePreviewFrame = null;
let pressurePreviewResizeObserver = null;
let activePressureHandle = null;
let lastServerActivityAt = 0;
let selectedMonitorId = null;
let livePressureIndicator = {
    raw: 0,
    mapped: 0,
    visible: false,
};
let pressurePreviewMetrics = {
    width: 256,
    height: 176,
    dpr: 1,
};
// Pen active area (pixel coords on canvas, accounting for monitor aspect ratio)
let penArea = { x: 0, y: 0, w: 0, h: 0 };
let currentMonitor = null;
let monitorList = [];
const PEN_AREA_PADDING = 20; // px padding from screen edges
const ACTIVE_AREA_RADIUS = 16;
const ACTIVE_AREA_GRID_SPACING = 22;
const ACTIVE_AREA_GRID_INSET = 18;
const ACTIVE_AREA_TONE = "#48484a";
const ACTIVE_AREA_LABEL_FONT = "11px -apple-system, sans-serif";
const ACTIVE_AREA_LABEL_PADDING_X = 8;
const ACTIVE_AREA_LABEL_PADDING_Y = 4;
const ACTIVE_AREA_LABEL_BACKGROUND = "#000";
const PRESSURE_CURVE_STORAGE_KEY = "pipatab.pressureCurve.v3";
const TRACKPAD_MODE_STORAGE_KEY = "pipatab.trackpad.v4";
const PENCIL_SQUEEZE_STORAGE_KEY = "pipatab.pencilSqueeze.v1";
const MONITOR_SELECTION_STORAGE_KEY = "pipatab.monitorSelection.v1";
const LEGACY_TRACKPAD_MODE_STORAGE_KEY = "pipatab.trackpad.v3";
const LEGACY_TRACKPAD_MODE_STORAGE_KEY_V2 = "pipatab.trackpad.v2";
const LEGACY_TOUCH_INPUT_STORAGE_KEY = "pipatab.touchInput.v1";
const PRESSURE_CURVE_LUT_SIZE = 256;
const PRESSURE_CURVE_START_X = 0;
const PRESSURE_CURVE_POINT_GAP = 0.08;
const PRESSURE_CURVE_HANDLE_RADIUS = 18;
const PRESSURE_PREVIEW_ASPECT_RATIO = 16 / 11;
const PRESSURE_PREVIEW_MAX_DPR = 3;
const PEN_TOUCH_BLOCK_TIMEOUT_MS = 180;
const TRACKPAD_HOLD_DELAY_MIN_MS = 120;
const TRACKPAD_HOLD_DELAY_MAX_MS = 420;
const TRACKPAD_HOLD_DELAY_STEP_MS = 10;
const TRACKPAD_CURSOR_BASE_GAIN = 1.15;
const TRACKPAD_CURSOR_MAX_GAIN = 2.8;
const TRACKPAD_ACCELERATION_TARGET_VELOCITY = 1.4;
const TRACKPAD_MOVE_START_TRAVEL = 2;
const TRACKPAD_SCROLL_START_TRAVEL = 4;
const TRACKPAD_SCROLL_UNITS_PER_PIXEL = 10;
const TRACKPAD_ZOOM_START_DISTANCE = 18;
const TRACKPAD_ZOOM_UNITS_PER_PIXEL = 8;
const TRACKPAD_TAP_MAX_TRAVEL = 12;
const TRACKPAD_TAP_MAX_DURATION_MS = 220;
const TRACKPAD_TWO_FINGER_TAP_MAX_DURATION_MS = 260;
const TRACKPAD_DRAG_HOLD_MAX_TRAVEL = 6;
const TRACKPAD_DOUBLE_TAP_MAX_DELAY_MS = 280;
const TRACKPAD_DOUBLE_TAP_MAX_DISTANCE = 32;
const TRACKPAD_MOMENTUM_DECAY_PER_FRAME = 0.92;
const TRACKPAD_MOMENTUM_MIN_SPEED = 0.04;
const TRACKPAD_MOMENTUM_BOOST = 1.22;
const TRACKPAD_MOMENTUM_MAX_SPEED = 1.8;
const TRACKPAD_MOMENTUM_MAX_SAMPLE_AGE_MS = 72;
const PEN_SQUEEZE_TANGENTIAL_PRESSURE_THRESHOLD = 0.12;
const WS_HEARTBEAT_INTERVAL_MS = 5000;
const WS_HEARTBEAT_TIMEOUT_MS = 15000;
const WS_HEARTBEAT_MAX_CONSECUTIVE_MISSES = 2;
const WS_POINTER_BACKPRESSURE_LIMIT_BYTES = 256 * 1024;
const WS_CONTROL_BACKPRESSURE_LIMIT_BYTES = 192 * 1024;
const WS_RECONNECT_BASE_DELAY_MS = 300;
const WS_RECONNECT_MAX_DELAY_MS = 5000;
const WS_VISIBLE_STALE_GRACE_MS = 6000;
const PEN_BATCH_MAX_EVENTS = 255;
const DEFAULT_PRESSURE_CURVE = {
    startY: 0,
    middleX: 0.5,
    middleY: 0.5,
    endX: 1,
};
const DEFAULT_TOUCH_INPUT_SETTINGS = {
    enabled: true,
    zoomEnabled: true,
    dragMode: "double-tap",
    longPressDelayMs: 180,
};
// Binary protocol constants
const BINARY_MSG_POINTER_EVENT = 0x01;
const BINARY_MSG_POINTER_EVENTS = 0x02;
const BINARY_EVENT_SIZE = 18;
const BINARY_EVENT_TYPE_MAP = {
    "pointerdown": 0,
    "pointerup": 1,
    "pointercancel": 2,
    "pointermove": 3,
    "pointerenter": 4,
    "pointerleave": 5,
};
let pressureCurve = { ...DEFAULT_PRESSURE_CURVE };
let pressureCurveLut = buildPressureCurveLut(pressureCurve);
let touchInputSettings = { ...DEFAULT_TOUCH_INPUT_SETTINGS };
let pencilSqueezeModifier = "off";
let penIsInRange = false;
let penSqueezeSignalActive = false;
let activePencilSqueezeModifier = null;
let lastPenActivityAt = 0;
const trackpadTouches = new Map();
let trackpadMoveRemainder = { x: 0, y: 0 };
let trackpadWheelRemainder = { x: 0, y: 0 };
let trackpadZoomRemainder = 0;
let trackpadGestureMode = "idle";
let trackpadGestureStartedAt = 0;
let trackpadGestureMaxTouches = 0;
let trackpadPrimaryTapEligible = false;
let trackpadSecondaryTapEligible = false;
let trackpadSecondaryTouchStartedAt = 0;
let trackpadScrollOrigin = null;
let trackpadPinchOriginDistance = null;
let trackpadZoomGestureActive = false;
let trackpadScrollVelocity = { x: 0, y: 0 };
let trackpadMomentumVelocity = { x: 0, y: 0 };
let trackpadLastScrollSampleAt = 0;
let trackpadHoldTimer = null;
let trackpadPrimaryButtonDown = false;
let trackpadDraggingPointerId = null;
let trackpadMomentumFrame = null;
let trackpadMomentumTimestamp = 0;
let lastPrimaryTapAt = 0;
let lastPrimaryTapPosition = null;
// ─── Entry ────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    canvas = document.getElementById("tablet");
    ctx = canvas.getContext("2d");
    statusDot = document.getElementById("status-dot");
    connectionOverlay = document.getElementById("connection-overlay");
    connectionTitle = document.getElementById("connection-title");
    connectionStateText = document.getElementById("connection-state");
    connectionDetailText = document.getElementById("connection-detail");
    connectionAttemptText = document.getElementById("connection-attempt");
    connectionHostText = document.getElementById("connection-host");
    monitorSelect = document.getElementById("monitor-select");
    pressurePreview = document.getElementById("pressure-preview");
    pressurePreviewCtx = pressurePreview.getContext("2d");
    pressureCurve = loadPressureCurveSettings();
    pressureCurveLut = buildPressureCurveLut(pressureCurve);
    touchInputSettings = loadTouchInputSettings();
    pencilSqueezeModifier = loadPencilSqueezeModifier();
    selectedMonitorId = loadSelectedMonitorSelection();
    connectionHostText.textContent = window.location.host;
    setupCanvas();
    setupUI();
    setupConnectionLifecycle();
    setConnectionVisualState("connecting");
    connect();
});
function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function normalizeTrackpadHoldDelay(delayMs) {
    const clamped = clampNumber(delayMs, TRACKPAD_HOLD_DELAY_MIN_MS, TRACKPAD_HOLD_DELAY_MAX_MS);
    return Math.round(clamped / TRACKPAD_HOLD_DELAY_STEP_MS) * TRACKPAD_HOLD_DELAY_STEP_MS;
}
function normalizePressureCurve(curve) {
    const startYRaw = typeof curve?.startY === "number" ? curve.startY : DEFAULT_PRESSURE_CURVE.startY;
    const startY = clampNumber(startYRaw, 0, 0.72);
    const middleXMin = PRESSURE_CURVE_START_X + PRESSURE_CURVE_POINT_GAP;
    const middleXRaw = typeof curve?.middleX === "number" ? curve.middleX : DEFAULT_PRESSURE_CURVE.middleX;
    const endXRaw = typeof curve?.endX === "number" ? curve.endX : DEFAULT_PRESSURE_CURVE.endX;
    const middleXMax = clampNumber(endXRaw - PRESSURE_CURVE_POINT_GAP, middleXMin, 1 - PRESSURE_CURVE_POINT_GAP);
    const middleX = clampNumber(middleXRaw, middleXMin, middleXMax);
    const endX = clampNumber(endXRaw, middleX + PRESSURE_CURVE_POINT_GAP, 1);
    const middleYRaw = typeof curve?.middleY === "number" ? curve.middleY : DEFAULT_PRESSURE_CURVE.middleY;
    const middleY = clampNumber(middleYRaw, startY + 0.04, 0.96);
    return { startY, middleX, middleY, endX };
}
function loadPressureCurveSettings() {
    try {
        const raw = window.localStorage.getItem(PRESSURE_CURVE_STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_PRESSURE_CURVE };
        }
        return normalizePressureCurve(JSON.parse(raw));
    }
    catch {
        return { ...DEFAULT_PRESSURE_CURVE };
    }
}
function savePressureCurveSettings() {
    try {
        window.localStorage.setItem(PRESSURE_CURVE_STORAGE_KEY, JSON.stringify(pressureCurve));
    }
    catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}
function normalizeTouchInputSettings(settings) {
    const longPressDelayRaw = typeof settings?.longPressDelayMs === "number"
        ? settings.longPressDelayMs
        : DEFAULT_TOUCH_INPUT_SETTINGS.longPressDelayMs;
    return {
        enabled: settings?.enabled !== false,
        zoomEnabled: settings?.zoomEnabled !== false,
        dragMode: settings?.dragMode === "double-tap" ? "double-tap" : "hold",
        longPressDelayMs: normalizeTrackpadHoldDelay(longPressDelayRaw),
    };
}
function loadTouchInputSettings() {
    try {
        const currentRaw = window.localStorage.getItem(TRACKPAD_MODE_STORAGE_KEY);
        if (currentRaw) {
            return normalizeTouchInputSettings(JSON.parse(currentRaw));
        }
        const legacyRaw = window.localStorage.getItem(LEGACY_TRACKPAD_MODE_STORAGE_KEY) ??
            window.localStorage.getItem(LEGACY_TRACKPAD_MODE_STORAGE_KEY_V2) ??
            window.localStorage.getItem(LEGACY_TOUCH_INPUT_STORAGE_KEY);
        if (!legacyRaw) {
            return { ...DEFAULT_TOUCH_INPUT_SETTINGS };
        }
        const legacySettings = JSON.parse(legacyRaw);
        const normalized = normalizeTouchInputSettings(legacySettings);
        return {
            ...normalized,
            dragMode: DEFAULT_TOUCH_INPUT_SETTINGS.dragMode,
        };
    }
    catch {
        return { ...DEFAULT_TOUCH_INPUT_SETTINGS };
    }
}
function saveTouchInputSettings() {
    try {
        window.localStorage.setItem(TRACKPAD_MODE_STORAGE_KEY, JSON.stringify(touchInputSettings));
    }
    catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}
function normalizePencilSqueezeModifier(value) {
    return value === "shift" || value === "control" || value === "alt" ? value : "off";
}
function loadPencilSqueezeModifier() {
    try {
        return normalizePencilSqueezeModifier(window.localStorage.getItem(PENCIL_SQUEEZE_STORAGE_KEY));
    }
    catch {
        return "off";
    }
}
function savePencilSqueezeModifier() {
    try {
        window.localStorage.setItem(PENCIL_SQUEEZE_STORAGE_KEY, pencilSqueezeModifier);
    }
    catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}
function syncPencilSqueezeControls() {
    if (!pencilSqueezeSelect) {
        return;
    }
    pencilSqueezeSelect.value = pencilSqueezeModifier;
}
function syncTouchInputControls() {
    btnTrackpadMode.classList.toggle("enabled", touchInputSettings.enabled);
    btnTrackpadMode.setAttribute("aria-pressed", touchInputSettings.enabled ? "true" : "false");
    btnTrackpadZoom.classList.toggle("enabled", touchInputSettings.enabled && touchInputSettings.zoomEnabled);
    btnTrackpadZoom.setAttribute("aria-pressed", touchInputSettings.enabled && touchInputSettings.zoomEnabled ? "true" : "false");
    btnTrackpadDragHold.classList.toggle("active", touchInputSettings.dragMode === "hold");
    btnTrackpadDragDoubleTap.classList.toggle("active", touchInputSettings.dragMode === "double-tap");
    btnTrackpadZoom.disabled = !touchInputSettings.enabled;
    btnTrackpadDragHold.disabled = !touchInputSettings.enabled;
    btnTrackpadDragDoubleTap.disabled = !touchInputSettings.enabled;
    trackpadDragModeControl.style.opacity = touchInputSettings.enabled ? "1" : "0.45";
    trackpadDragModeControl.style.pointerEvents = touchInputSettings.enabled ? "" : "none";
    trackpadHoldDelayInput.disabled = !touchInputSettings.enabled || touchInputSettings.dragMode !== "hold";
    trackpadHoldDelayGroup.style.display = touchInputSettings.dragMode === "hold" ? "grid" : "none";
    trackpadHoldDelayValue.textContent = `${touchInputSettings.longPressDelayMs} ms`;
    trackpadHoldDelayInput.value = `${touchInputSettings.longPressDelayMs}`;
}
function setTouchInputSettings(nextSettings, persist) {
    const next = normalizeTouchInputSettings(nextSettings);
    const changed = next.enabled !== touchInputSettings.enabled ||
        next.zoomEnabled !== touchInputSettings.zoomEnabled ||
        next.dragMode !== touchInputSettings.dragMode ||
        next.longPressDelayMs !== touchInputSettings.longPressDelayMs;
    touchInputSettings = next;
    if (changed) {
        cancelActiveTouchInteractions();
    }
    syncTouchInputControls();
    if (persist) {
        saveTouchInputSettings();
    }
}
function updatePencilSqueezeModifierBinding(timeStamp) {
    const nextModifier = penSqueezeSignalActive && pencilSqueezeModifier !== "off" ? pencilSqueezeModifier : null;
    if (activePencilSqueezeModifier === nextModifier) {
        return;
    }
    if (activePencilSqueezeModifier) {
        sendModifierState(activePencilSqueezeModifier, false, timeStamp);
        activePencilSqueezeModifier = null;
    }
    if (nextModifier) {
        sendModifierState(nextModifier, true, timeStamp);
        activePencilSqueezeModifier = nextModifier;
    }
}
function setPencilSqueezeModifier(nextModifier, persist) {
    const normalized = normalizePencilSqueezeModifier(nextModifier);
    if (pencilSqueezeModifier === normalized) {
        syncPencilSqueezeControls();
        return;
    }
    pencilSqueezeModifier = normalized;
    syncPencilSqueezeControls();
    updatePencilSqueezeModifierBinding(performance.now());
    if (persist) {
        savePencilSqueezeModifier();
    }
}
function resendActiveModifierStates() {
    if (activePencilSqueezeModifier) {
        sendModifierState(activePencilSqueezeModifier, true, performance.now());
    }
}
function getPressureCurvePoints(curve) {
    const points = [
        { x: PRESSURE_CURVE_START_X, y: curve.startY },
        { x: curve.middleX, y: curve.middleY },
    ];
    if (curve.endX < 0.999) {
        points.push({ x: curve.endX, y: 1 });
    }
    points.push({ x: 1, y: 1 });
    return points;
}
function buildMonotoneTangents(points) {
    const tangents = new Array(points.length).fill(0);
    if (points.length < 2) {
        return tangents;
    }
    const secants = new Array(points.length - 1).fill(0);
    for (let i = 0; i < points.length - 1; i++) {
        secants[i] = (points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x);
    }
    tangents[0] = secants[0];
    tangents[tangents.length - 1] = secants[secants.length - 1];
    for (let i = 1; i < tangents.length - 1; i++) {
        tangents[i] = (secants[i - 1] + secants[i]) / 2;
    }
    for (let i = 0; i < secants.length; i++) {
        if (Math.abs(secants[i]) < 0.000001) {
            tangents[i] = 0;
            tangents[i + 1] = 0;
            continue;
        }
        const alpha = tangents[i] / secants[i];
        const beta = tangents[i + 1] / secants[i];
        const magnitude = alpha * alpha + beta * beta;
        if (magnitude > 9) {
            const scale = 3 / Math.sqrt(magnitude);
            tangents[i] = scale * alpha * secants[i];
            tangents[i + 1] = scale * beta * secants[i];
        }
    }
    return tangents;
}
function sampleMonotoneCurve(points, tangents, x) {
    const clampedX = clampNumber(x, 0, 1);
    if (clampedX <= points[0].x) {
        return points[0].y;
    }
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        if (clampedX > p1.x) {
            continue;
        }
        const span = p1.x - p0.x;
        const t = span <= 0 ? 0 : (clampedX - p0.x) / span;
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        return clampNumber(h00 * p0.y + h10 * span * tangents[i] + h01 * p1.y + h11 * span * tangents[i + 1], 0, 1);
    }
    return points[points.length - 1].y;
}
function buildPressureCurveLut(curve) {
    const points = getPressureCurvePoints(curve);
    const tangents = buildMonotoneTangents(points);
    const lut = [];
    for (let i = 0; i <= PRESSURE_CURVE_LUT_SIZE; i++) {
        const x = i / PRESSURE_CURVE_LUT_SIZE;
        lut.push(sampleMonotoneCurve(points, tangents, x));
    }
    return lut;
}
function applyPressureCurve(rawPressure) {
    const pressure = clampNumber(rawPressure, 0, 1);
    if (pressure <= 0 || pressureCurveLut.length === 0) {
        return 0;
    }
    if (pressure >= 1) {
        return 1;
    }
    const scaled = pressure * PRESSURE_CURVE_LUT_SIZE;
    const left = Math.floor(scaled);
    const right = Math.min(PRESSURE_CURVE_LUT_SIZE, left + 1);
    const frac = scaled - left;
    return pressureCurveLut[left] + (pressureCurveLut[right] - pressureCurveLut[left]) * frac;
}
function syncPressureCurveEditor() {
    updatePressureCurveReadouts();
    resizePressurePreviewCanvas();
    const previewVisible = !settingsPanel || !settingsPanel.classList.contains("hidden");
    schedulePressureCurvePreviewDraw(previewVisible);
}
function formatCurvePercent(value) {
    return `${Math.round(clampNumber(value, 0, 1) * 100)}%`;
}
function updatePressureCurveReadouts() {
    if (!pressureReadoutStart || !pressureReadoutMiddle || !pressureReadoutEnd) {
        return;
    }
    pressureReadoutStart.textContent = formatCurvePercent(pressureCurve.startY);
    pressureReadoutMiddle.textContent = `${formatCurvePercent(pressureCurve.middleX)} -> ${formatCurvePercent(pressureCurve.middleY)}`;
    pressureReadoutEnd.textContent = formatCurvePercent(pressureCurve.endX);
}
function resizePressurePreviewCanvas(force = false) {
    const rect = pressurePreview.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width <= 1 || height <= 1) {
        return false;
    }
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), PRESSURE_PREVIEW_MAX_DPR);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    pressurePreviewMetrics = {
        width,
        height,
        dpr,
    };
    if (!force && pressurePreview.width === pixelWidth && pressurePreview.height === pixelHeight) {
        return false;
    }
    pressurePreview.width = pixelWidth;
    pressurePreview.height = pixelHeight;
    pressurePreviewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pressurePreviewCtx.imageSmoothingEnabled = true;
    return true;
}
function schedulePressureCurvePreviewDraw(force = false) {
    if (!force && settingsPanel.classList.contains("hidden")) {
        return;
    }
    if (pressurePreviewFrame !== null) {
        return;
    }
    pressurePreviewFrame = window.requestAnimationFrame(() => {
        pressurePreviewFrame = null;
        if (force || !settingsPanel.classList.contains("hidden")) {
            drawPressureCurvePreview();
        }
    });
}
function setPressureCurve(nextCurve, persist) {
    pressureCurve = normalizePressureCurve(nextCurve);
    pressureCurveLut = buildPressureCurveLut(pressureCurve);
    syncPressureCurveEditor();
    if (persist) {
        savePressureCurveSettings();
    }
}
function setLivePressureIndicator(raw, mapped, visible) {
    livePressureIndicator = {
        raw: clampNumber(raw, 0, 1),
        mapped: clampNumber(mapped, 0, 1),
        visible,
    };
    schedulePressureCurvePreviewDraw();
}
function interpolateMiddlePoint() {
    const nextMiddleX = pressureCurve.endX / 2;
    const nextMiddleY = pressureCurve.endX <= 0
        ? pressureCurve.startY
        : pressureCurve.startY +
            ((1 - pressureCurve.startY) * nextMiddleX) / pressureCurve.endX;
    setPressureCurve({
        ...pressureCurve,
        middleX: nextMiddleX,
        middleY: nextMiddleY,
    }, true);
}
function getPressurePreviewLayout() {
    const width = pressurePreviewMetrics.width || Math.round(pressurePreview.clientWidth || 256);
    const height = pressurePreviewMetrics.height || Math.round(width / PRESSURE_PREVIEW_ASPECT_RATIO);
    const padLeft = Math.round(Math.max(44, width * 0.14));
    const padRight = Math.round(Math.max(22, width * 0.08));
    const padTop = Math.round(Math.max(22, height * 0.12));
    const padBottom = Math.round(Math.max(40, height * 0.18));
    const innerWidth = Math.max(1, width - padLeft - padRight);
    const innerHeight = Math.max(1, height - padTop - padBottom);
    const plotLeft = padLeft;
    const plotTop = padTop;
    const plotRight = plotLeft + innerWidth;
    const plotBottom = plotTop + innerHeight;
    return {
        width,
        height,
        padLeft,
        padRight,
        padTop,
        padBottom,
        innerWidth,
        innerHeight,
        plotLeft,
        plotTop,
        plotRight,
        plotBottom,
        mapX(value) {
            return plotLeft + clampNumber(value, 0, 1) * innerWidth;
        },
        mapY(value) {
            return plotBottom - clampNumber(value, 0, 1) * innerHeight;
        },
        unmapX(pixelX) {
            return clampNumber((pixelX - plotLeft) / innerWidth, 0, 1);
        },
        unmapY(pixelY) {
            return clampNumber((plotBottom - pixelY) / innerHeight, 0, 1);
        },
    };
}
function getPressureHandlePositions() {
    const layout = getPressurePreviewLayout();
    return {
        start: {
            x: layout.mapX(PRESSURE_CURVE_START_X),
            y: layout.mapY(pressureCurve.startY),
        },
        middle: {
            x: layout.mapX(pressureCurve.middleX),
            y: layout.mapY(pressureCurve.middleY),
        },
        end: {
            x: layout.mapX(pressureCurve.endX),
            y: layout.mapY(1),
        },
    };
}
function getPreviewPixelPosition(event) {
    const rect = pressurePreview.getBoundingClientRect();
    const scaleX = rect.width > 0 ? pressurePreviewMetrics.width / rect.width : 1;
    const scaleY = rect.height > 0 ? pressurePreviewMetrics.height / rect.height : 1;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
    };
}
function buildPressureCurvePreviewPaths(layout) {
    const curvePath = new Path2D();
    const areaPath = new Path2D();
    const baseY = layout.mapY(0);
    areaPath.moveTo(layout.mapX(0), baseY);
    for (let i = 0; i <= PRESSURE_CURVE_LUT_SIZE; i++) {
        const x = i / PRESSURE_CURVE_LUT_SIZE;
        const y = pressureCurveLut[i];
        const px = layout.mapX(x);
        const py = layout.mapY(y);
        if (i === 0) {
            curvePath.moveTo(px, py);
            areaPath.lineTo(px, py);
        }
        else {
            curvePath.lineTo(px, py);
            areaPath.lineTo(px, py);
        }
    }
    areaPath.lineTo(layout.mapX(1), baseY);
    areaPath.closePath();
    return {
        curvePath,
        areaPath,
    };
}
function drawPressureCurveBubble(text, anchorX, anchorY, layout, background, border, textColor) {
    const paddingX = 10;
    const bubbleHeight = 28;
    pressurePreviewCtx.save();
    pressurePreviewCtx.font = '600 11px "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';
    const metrics = pressurePreviewCtx.measureText(text);
    const bubbleWidth = Math.ceil(metrics.width) + paddingX * 2;
    const bubbleX = clampNumber(anchorX + 12, layout.plotLeft + 8, layout.plotRight - bubbleWidth - 8);
    const bubbleY = clampNumber(anchorY - bubbleHeight - 12, layout.plotTop + 8, layout.plotBottom - bubbleHeight - 8);
    traceRoundedRectPath(pressurePreviewCtx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, 10);
    pressurePreviewCtx.fillStyle = background;
    pressurePreviewCtx.fill();
    pressurePreviewCtx.strokeStyle = border;
    pressurePreviewCtx.lineWidth = 1;
    pressurePreviewCtx.stroke();
    pressurePreviewCtx.fillStyle = textColor;
    pressurePreviewCtx.textAlign = "center";
    pressurePreviewCtx.textBaseline = "middle";
    pressurePreviewCtx.fillText(text, bubbleX + bubbleWidth / 2, bubbleY + bubbleHeight / 2);
    pressurePreviewCtx.restore();
}
function getPressureHandleTooltip(handle) {
    if (handle === "start") {
        return `Start ${formatCurvePercent(pressureCurve.startY)}`;
    }
    if (handle === "middle") {
        return `Mid ${formatCurvePercent(pressureCurve.middleX)} -> ${formatCurvePercent(pressureCurve.middleY)}`;
    }
    return `Full ${formatCurvePercent(pressureCurve.endX)}`;
}
function pickPressureHandle(event) {
    const pos = getPreviewPixelPosition(event);
    const handles = getPressureHandlePositions();
    let bestHandle = null;
    let bestDistanceSq = PRESSURE_CURVE_HANDLE_RADIUS * PRESSURE_CURVE_HANDLE_RADIUS;
    for (const handle of ["start", "middle", "end"]) {
        const dx = pos.x - handles[handle].x;
        const dy = pos.y - handles[handle].y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq <= bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestHandle = handle;
        }
    }
    return bestHandle;
}
function updatePressureHandleFromEvent(handle, event) {
    const layout = getPressurePreviewLayout();
    const pos = getPreviewPixelPosition(event);
    const pressureX = layout.unmapX(pos.x);
    const pressureY = layout.unmapY(pos.y);
    const nextCurve = { ...pressureCurve };
    if (handle === "start") {
        nextCurve.startY = clampNumber(pressureY, 0, nextCurve.middleY - 0.04);
    }
    else if (handle === "middle") {
        nextCurve.middleX = clampNumber(pressureX, PRESSURE_CURVE_START_X + PRESSURE_CURVE_POINT_GAP, nextCurve.endX - PRESSURE_CURVE_POINT_GAP);
        nextCurve.middleY = clampNumber(pressureY, nextCurve.startY + 0.04, 0.96);
    }
    else {
        nextCurve.endX = clampNumber(pressureX, nextCurve.middleX + PRESSURE_CURVE_POINT_GAP, 1);
    }
    setPressureCurve(nextCurve, true);
}
function onPressurePreviewPointerDown(event) {
    event.preventDefault();
    const handle = pickPressureHandle(event);
    if (!handle) {
        return;
    }
    activePressureHandle = handle;
    pressurePreview.setPointerCapture(event.pointerId);
    updatePressureHandleFromEvent(handle, event);
}
function onPressurePreviewPointerMove(event) {
    if (!activePressureHandle) {
        return;
    }
    event.preventDefault();
    updatePressureHandleFromEvent(activePressureHandle, event);
}
function endPressurePreviewInteraction(event) {
    if (!activePressureHandle) {
        return;
    }
    if (pressurePreview.hasPointerCapture(event.pointerId)) {
        pressurePreview.releasePointerCapture(event.pointerId);
    }
    activePressureHandle = null;
}
function drawPressureCurvePreview() {
    resizePressurePreviewCanvas();
    const layout = getPressurePreviewLayout();
    const { width, height, padLeft, padTop, padBottom } = layout;
    const handles = getPressureHandlePositions();
    if (width <= 1 || height <= 1) {
        return;
    }
    pressurePreviewCtx.clearRect(0, 0, width, height);
    pressurePreviewCtx.save();
    pressurePreviewCtx.lineCap = "round";
    pressurePreviewCtx.lineJoin = "round";
    const backgroundGradient = pressurePreviewCtx.createLinearGradient(0, 0, 0, height);
    backgroundGradient.addColorStop(0, "#15181d");
    backgroundGradient.addColorStop(1, "#060709");
    pressurePreviewCtx.fillStyle = backgroundGradient;
    pressurePreviewCtx.fillRect(0, 0, width, height);
    const glowGradient = pressurePreviewCtx.createRadialGradient(width * 0.24, height * 0.12, 0, width * 0.24, height * 0.12, width * 0.9);
    glowGradient.addColorStop(0, "rgba(240, 180, 92, 0.18)");
    glowGradient.addColorStop(0.45, "rgba(240, 180, 92, 0.05)");
    glowGradient.addColorStop(1, "rgba(240, 180, 92, 0)");
    pressurePreviewCtx.fillStyle = glowGradient;
    pressurePreviewCtx.fillRect(0, 0, width, height);
    const plotRadius = 18;
    traceRoundedRectPath(pressurePreviewCtx, layout.plotLeft, layout.plotTop, layout.innerWidth, layout.innerHeight, plotRadius);
    pressurePreviewCtx.fillStyle = "rgba(8, 10, 14, 0.84)";
    pressurePreviewCtx.fill();
    pressurePreviewCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    pressurePreviewCtx.lineWidth = 1;
    pressurePreviewCtx.stroke();
    pressurePreviewCtx.save();
    traceRoundedRectPath(pressurePreviewCtx, layout.plotLeft, layout.plotTop, layout.innerWidth, layout.innerHeight, plotRadius);
    pressurePreviewCtx.clip();
    for (let i = 0; i <= 8; i++) {
        const ratio = i / 8;
        const x = layout.mapX(ratio);
        const y = layout.mapY(ratio);
        const isMajor = i % 2 === 0;
        if (i > 0 && i < 8) {
            pressurePreviewCtx.strokeStyle = isMajor
                ? "rgba(255, 255, 255, 0.085)"
                : "rgba(255, 255, 255, 0.035)";
            pressurePreviewCtx.lineWidth = 1;
            pressurePreviewCtx.beginPath();
            pressurePreviewCtx.moveTo(x, layout.plotTop);
            pressurePreviewCtx.lineTo(x, layout.plotBottom);
            pressurePreviewCtx.stroke();
            pressurePreviewCtx.beginPath();
            pressurePreviewCtx.moveTo(layout.plotLeft, y);
            pressurePreviewCtx.lineTo(layout.plotRight, y);
            pressurePreviewCtx.stroke();
        }
    }
    pressurePreviewCtx.setLineDash([7, 8]);
    pressurePreviewCtx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    pressurePreviewCtx.lineWidth = 1.25;
    pressurePreviewCtx.beginPath();
    pressurePreviewCtx.moveTo(layout.mapX(0), layout.mapY(0));
    pressurePreviewCtx.lineTo(layout.mapX(1), layout.mapY(1));
    pressurePreviewCtx.stroke();
    pressurePreviewCtx.setLineDash([]);
    const { curvePath, areaPath } = buildPressureCurvePreviewPaths(layout);
    const areaGradient = pressurePreviewCtx.createLinearGradient(0, layout.plotTop, 0, layout.plotBottom);
    areaGradient.addColorStop(0, "rgba(240, 180, 92, 0.34)");
    areaGradient.addColorStop(1, "rgba(240, 180, 92, 0.03)");
    pressurePreviewCtx.fillStyle = areaGradient;
    pressurePreviewCtx.fill(areaPath);
    const sheenGradient = pressurePreviewCtx.createLinearGradient(layout.plotLeft, 0, layout.plotRight, 0);
    sheenGradient.addColorStop(0, "rgba(255, 255, 255, 0.08)");
    sheenGradient.addColorStop(0.65, "rgba(255, 255, 255, 0)");
    pressurePreviewCtx.fillStyle = sheenGradient;
    pressurePreviewCtx.fill(areaPath);
    pressurePreviewCtx.shadowBlur = 22;
    pressurePreviewCtx.shadowColor = "rgba(240, 180, 92, 0.42)";
    pressurePreviewCtx.strokeStyle = "rgba(240, 180, 92, 0.26)";
    pressurePreviewCtx.lineWidth = 7;
    pressurePreviewCtx.stroke(curvePath);
    pressurePreviewCtx.shadowBlur = 0;
    pressurePreviewCtx.strokeStyle = "#f0c27a";
    pressurePreviewCtx.lineWidth = 3.2;
    pressurePreviewCtx.stroke(curvePath);
    pressurePreviewCtx.strokeStyle = "rgba(255, 248, 236, 0.86)";
    pressurePreviewCtx.lineWidth = 1.15;
    pressurePreviewCtx.stroke(curvePath);
    if (livePressureIndicator.visible) {
        const liveX = layout.mapX(livePressureIndicator.raw);
        const liveY = layout.mapY(livePressureIndicator.mapped);
        pressurePreviewCtx.setLineDash([5, 7]);
        pressurePreviewCtx.strokeStyle = "rgba(111, 227, 255, 0.34)";
        pressurePreviewCtx.lineWidth = 1.25;
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(liveX, layout.plotTop);
        pressurePreviewCtx.lineTo(liveX, layout.plotBottom);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(layout.plotLeft, liveY);
        pressurePreviewCtx.lineTo(layout.plotRight, liveY);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.setLineDash([]);
        pressurePreviewCtx.fillStyle = "rgba(111, 227, 255, 0.18)";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(liveX, liveY, 14, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
        pressurePreviewCtx.strokeStyle = "rgba(111, 227, 255, 0.42)";
        pressurePreviewCtx.lineWidth = 1.5;
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(liveX, liveY, 8, 0, Math.PI * 2);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.fillStyle = "#7be7ff";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(liveX, liveY, 4.5, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
        drawPressureCurveBubble(`${formatCurvePercent(livePressureIndicator.raw)} -> ${formatCurvePercent(livePressureIndicator.mapped)}`, liveX, liveY, layout, "rgba(7, 17, 22, 0.94)", "rgba(111, 227, 255, 0.34)", "#b6f6ff");
    }
    pressurePreviewCtx.restore();
    const axisTicks = width < 300 ? [0, 1] : [0, 0.5, 1];
    const axisTickY = layout.plotBottom + 18;
    pressurePreviewCtx.font = '600 10px "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';
    pressurePreviewCtx.fillStyle = "rgba(255, 255, 255, 0.52)";
    pressurePreviewCtx.textBaseline = "middle";
    pressurePreviewCtx.textAlign = "right";
    for (const tick of axisTicks) {
        pressurePreviewCtx.fillText(formatCurvePercent(tick), padLeft - 10, layout.mapY(tick));
    }
    pressurePreviewCtx.textAlign = "center";
    for (const tick of axisTicks) {
        pressurePreviewCtx.fillText(formatCurvePercent(tick), layout.mapX(tick), axisTickY);
    }
    for (const handle of ["start", "middle", "end"]) {
        const point = handles[handle];
        const isActive = activePressureHandle === handle;
        pressurePreviewCtx.fillStyle = isActive ? "rgba(240, 180, 92, 0.32)" : "rgba(255, 255, 255, 0.08)";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, isActive ? 13 : 11, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
        pressurePreviewCtx.fillStyle = "rgba(10, 12, 16, 0.94)";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, isActive ? 8 : 7, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
        pressurePreviewCtx.strokeStyle = isActive ? "rgba(255, 242, 219, 0.95)" : "rgba(240, 180, 92, 0.58)";
        pressurePreviewCtx.lineWidth = isActive ? 2.4 : 1.8;
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, isActive ? 8 : 7, 0, Math.PI * 2);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.fillStyle = isActive ? "#fff4dd" : "#f0b45c";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
    }
    if (activePressureHandle) {
        const point = handles[activePressureHandle];
        drawPressureCurveBubble(getPressureHandleTooltip(activePressureHandle), point.x, point.y, layout, "rgba(23, 16, 9, 0.94)", "rgba(240, 180, 92, 0.34)", "#fff3db");
    }
    pressurePreviewCtx.restore();
}
// ─── Canvas ───────────────────────────────────────────────────────────────────
function setupCanvas() {
    resizeCanvas();
    // Prevent all default touch/gesture behaviour
    canvas.addEventListener("touchstart", e => e.preventDefault(), { passive: false });
    canvas.addEventListener("touchmove", e => e.preventDefault(), { passive: false });
    canvas.addEventListener("touchend", e => e.preventDefault(), { passive: false });
    canvas.addEventListener("gesturestart", e => e.preventDefault());
    canvas.addEventListener("gesturechange", e => e.preventDefault());
    // Pointer events — pen plus optional touch fallback modes.
    canvas.addEventListener("pointerdown", onPointer);
    canvas.addEventListener("pointerup", onPointer);
    canvas.addEventListener("pointercancel", onPointer);
    canvas.addEventListener("pointermove", onPointer);
    canvas.addEventListener("pointerrawupdate", onPenPointerRawUpdate);
    canvas.addEventListener("pointerenter", onPointer);
    canvas.addEventListener("pointerleave", onPointer);
    window.addEventListener("resize", () => {
        resizeCanvas();
        drawPenArea();
    });
}
function resizeCanvas() {
    const dpr = window.devicePixelRatio;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    recalcPenArea();
}
function recalcPenArea() {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const pad = PEN_AREA_PADDING;
    const availW = sw - pad * 2;
    const availH = sh - pad * 2;
    if (!currentMonitor || availW <= 0 || availH <= 0) {
        // No monitor info yet — use full area
        penArea = { x: pad, y: pad, w: availW, h: availH };
        return;
    }
    const monAspect = currentMonitor.width / currentMonitor.height;
    const screenAspect = availW / availH;
    let w, h;
    if (monAspect > screenAspect) {
        // Monitor is wider — fit to width
        w = availW;
        h = availW / monAspect;
    }
    else {
        // Monitor is taller — fit to height
        h = availH;
        w = availH * monAspect;
    }
    penArea = {
        x: pad + (availW - w) / 2,
        y: pad + (availH - h) / 2,
        w: w,
        h: h,
    };
}
function traceRoundedRectPath(context, x, y, width, height, radius) {
    const limitedRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + limitedRadius, y);
    context.lineTo(x + width - limitedRadius, y);
    context.arcTo(x + width, y, x + width, y + limitedRadius, limitedRadius);
    context.lineTo(x + width, y + height - limitedRadius);
    context.arcTo(x + width, y + height, x + width - limitedRadius, y + height, limitedRadius);
    context.lineTo(x + limitedRadius, y + height);
    context.arcTo(x, y + height, x, y + height - limitedRadius, limitedRadius);
    context.lineTo(x, y + limitedRadius);
    context.arcTo(x, y, x + limitedRadius, y, limitedRadius);
    context.closePath();
}
function drawPenAreaDotGrid(radius) {
    const inset = Math.min(ACTIVE_AREA_GRID_INSET, penArea.w * 0.08, penArea.h * 0.08);
    const left = penArea.x + inset;
    const right = penArea.x + penArea.w - inset;
    const top = penArea.y + inset;
    const bottom = penArea.y + penArea.h - inset;
    const centerX = penArea.x + penArea.w / 2;
    const centerY = penArea.y + penArea.h / 2;
    if (right <= left || bottom <= top) {
        return;
    }
    ctx.save();
    traceRoundedRectPath(ctx, penArea.x, penArea.y, penArea.w, penArea.h, radius);
    ctx.clip();
    ctx.fillStyle = ACTIVE_AREA_TONE;
    for (let y = centerY; y <= bottom; y += ACTIVE_AREA_GRID_SPACING) {
        for (let x = centerX; x <= right; x += ACTIVE_AREA_GRID_SPACING) {
            ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        for (let x = centerX - ACTIVE_AREA_GRID_SPACING; x >= left; x -= ACTIVE_AREA_GRID_SPACING) {
            ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
    }
    for (let y = centerY - ACTIVE_AREA_GRID_SPACING; y >= top; y -= ACTIVE_AREA_GRID_SPACING) {
        for (let x = centerX; x <= right; x += ACTIVE_AREA_GRID_SPACING) {
            ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        for (let x = centerX - ACTIVE_AREA_GRID_SPACING; x >= left; x -= ACTIVE_AREA_GRID_SPACING) {
            ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
    }
    ctx.restore();
}
function drawPenAreaLabel(label, textRight, textBottom) {
    const fallbackFontSize = parseInt(ACTIVE_AREA_LABEL_FONT, 10) || 11;
    ctx.save();
    ctx.font = ACTIVE_AREA_LABEL_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    const metrics = ctx.measureText(label);
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fallbackFontSize);
    const descent = Math.ceil(metrics.actualBoundingBoxDescent || Math.max(3, Math.round(fallbackFontSize * 0.35)));
    const textWidth = Math.ceil(metrics.width);
    const backgroundX = Math.round(textRight - textWidth - ACTIVE_AREA_LABEL_PADDING_X);
    const backgroundY = Math.round(textBottom - ascent - descent - ACTIVE_AREA_LABEL_PADDING_Y);
    const backgroundWidth = textWidth + ACTIVE_AREA_LABEL_PADDING_X * 2;
    const backgroundHeight = ascent + descent + ACTIVE_AREA_LABEL_PADDING_Y * 2;
    const backgroundRadius = Math.min(8, backgroundHeight / 2);
    ctx.fillStyle = ACTIVE_AREA_LABEL_BACKGROUND;
    traceRoundedRectPath(ctx, backgroundX, backgroundY, backgroundWidth, backgroundHeight, backgroundRadius);
    ctx.fill();
    ctx.fillStyle = ACTIVE_AREA_TONE;
    ctx.fillText(label, textRight, textBottom - descent);
    ctx.restore();
}
function drawPenArea() {
    // Clear to pure black
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    const radius = Math.min(ACTIVE_AREA_RADIUS, penArea.w * 0.05, penArea.h * 0.05);
    drawPenAreaDotGrid(radius);
    // Draw pen area border
    ctx.strokeStyle = ACTIVE_AREA_TONE;
    ctx.lineWidth = 1;
    traceRoundedRectPath(ctx, penArea.x + 0.5, penArea.y + 0.5, penArea.w - 1, penArea.h - 1, radius);
    ctx.stroke();
    if (currentMonitor) {
        const labelInsetX = Math.max(18, radius + 10);
        const labelInsetY = Math.max(14, radius * 0.75);
        drawPenAreaLabel(`${currentMonitor.name}  ${currentMonitor.width}×${currentMonitor.height}`, penArea.x + penArea.w - labelInsetX, penArea.y + penArea.h - labelInsetY);
    }
}
// ─── Pointer Handler ──────────────────────────────────────────────────────────
function onPointer(e) {
    if (e.pointerType === "pen") {
        onPenPointer(e);
        return;
    }
    if (e.pointerType === "touch") {
        onTouchPointer(e);
    }
}
function onPenPointerRawUpdate(event) {
    const e = event;
    if (e.pointerType !== "pen") {
        return;
    }
    syncPenSqueezeModifierState(e);
    penIsInRange = true;
    lastPenActivityAt = performance.now();
    cancelActiveTouchInteractions();
    // Apple Pencil samples at up to 240Hz but the engine batches multiple
    // samples into one PointerEvent, exposing the intermediate ones via
    // getCoalescedEvents(). Without unpacking those, strokes lose 50–75% of
    // sub-samples and look polyline-y.
    queueCoalescedMoveSamples(e);
}
function getPointerTangentialPressure(e) {
    const tangentialPressure = e
        .tangentialPressure;
    return typeof tangentialPressure === "number" ? Math.abs(tangentialPressure) : 0;
}
function isPenBarrelButtonActive(e) {
    return (e.buttons & 0x02) !== 0;
}
function shouldConsumePenBarrelEvent(e) {
    return pencilSqueezeModifier !== "off" && (isPenBarrelButtonActive(e) || e.button === 2);
}
function getPenSqueezeSignalState(e) {
    return (isPenBarrelButtonActive(e) ||
        getPointerTangentialPressure(e) >= PEN_SQUEEZE_TANGENTIAL_PRESSURE_THRESHOLD);
}
function syncPenSqueezeModifierState(e) {
    const nextSignalActive = e.type === "pointerleave" || e.type === "pointercancel"
        ? false
        : getPenSqueezeSignalState(e);
    if (penSqueezeSignalActive === nextSignalActive) {
        return;
    }
    penSqueezeSignalActive = nextSignalActive;
    updatePencilSqueezeModifierBinding(e.timeStamp);
}
function onPenPointer(e) {
    e.preventDefault();
    syncPenSqueezeModifierState(e);
    if (e.type === "pointerleave" || e.type === "pointercancel") {
        penIsInRange = false;
        lastPenActivityAt = 0;
    }
    else {
        penIsInRange = true;
        lastPenActivityAt = performance.now();
    }
    if (penIsInRange) {
        cancelActiveTouchInteractions();
    }
    // pointermove is normally handled by onPenPointerRawUpdate (with coalesced
    // sub-sample expansion). On browsers that don't dispatch pointerrawupdate,
    // fall through and route pointermove through the same batched path so we
    // still capture all sub-samples via getCoalescedEvents().
    if (e.type === "pointermove") {
        if (supportsPointerRawUpdate()) {
            return;
        }
        queueCoalescedMoveSamples(e);
        return;
    }
    updatePenPressureIndicator(e, e.type);
    const payload = buildPenPointerPayload(e, e.type);
    if (payload === null) {
        return;
    }
    // Down/up/cancel/leave are state-critical: flush any queued moves first
    // so the terminal event arrives strictly after them.
    flushPenBatch();
    sendPointerPayload(payload);
}
let cachedSupportsPointerRawUpdate = null;
function supportsPointerRawUpdate() {
    if (cachedSupportsPointerRawUpdate === null) {
        cachedSupportsPointerRawUpdate = "onpointerrawupdate" in HTMLElement.prototype;
    }
    return cachedSupportsPointerRawUpdate;
}
function queueCoalescedMoveSamples(e) {
    const eventsWithSubSamples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
    const samples = eventsWithSubSamples && eventsWithSubSamples.length > 0
        ? eventsWithSubSamples
        : [e];
    let lastSample = null;
    for (const sample of samples) {
        const payload = buildPenPointerPayload(sample, "pointermove");
        if (payload === null)
            continue;
        queuePenBatchPayload(payload);
        lastSample = sample;
    }
    if (lastSample !== null) {
        updatePenPressureIndicator(lastSample, "pointermove");
    }
}
function updatePenPressureIndicator(e, eventType) {
    const hovering = e.pressure === 0 && eventType !== "pointerdown";
    const pressure = hovering ? 0 : applyPressureCurve(e.pressure);
    const pressureIndicatorVisible = eventType !== "pointerleave" && eventType !== "pointercancel" && eventType !== "pointerup";
    setLivePressureIndicator(e.pressure, pressure, pressureIndicatorVisible);
}
function buildPenPointerPayload(e, eventType) {
    const normX = (e.clientX - penArea.x) / penArea.w;
    const normY = (e.clientY - penArea.y) / penArea.h;
    const x = clampNumber(normX, 0, 1);
    const y = clampNumber(normY, 0, 1);
    const hovering = e.pressure === 0 && eventType !== "pointerdown";
    const pressure = hovering ? 0 : applyPressureCurve(e.pressure);
    const consumeBarrelEvent = shouldConsumePenBarrelEvent(e);
    const squeezeOnlyHoverTransition = consumeBarrelEvent &&
        e.button === 2 &&
        (eventType === "pointerdown" || eventType === "pointerup") &&
        (e.buttons & 0x01) === 0;
    if (squeezeOnlyHoverTransition) {
        return null;
    }
    let btn = 0;
    let buttons = e.buttons;
    const rawBtn = e.button;
    if (rawBtn === 0)
        btn = 1;
    else if (rawBtn === 2 && !consumeBarrelEvent)
        btn = 2;
    else if (rawBtn === 5)
        btn = 32;
    if (consumeBarrelEvent) {
        buttons &= ~0x02;
    }
    return {
        event_type: eventType,
        pointer_id: e.pointerId,
        timestamp: Math.round(e.timeStamp * 1000),
        is_primary: e.isPrimary,
        x,
        y,
        pressure,
        tilt_x: e.tiltX,
        tilt_y: e.tiltY,
        twist: e.twist,
        button: btn,
        buttons,
        hovering,
    };
}
function onTouchPointer(e) {
    e.preventDefault();
    if (!touchInputSettings.enabled || isPenBlockingTouch()) {
        return;
    }
    onTrackpadPointer(e);
}
function pointInPenArea(clientX, clientY) {
    return (clientX >= penArea.x &&
        clientX <= penArea.x + penArea.w &&
        clientY >= penArea.y &&
        clientY <= penArea.y + penArea.h);
}
function isPenBlockingTouch() {
    return (penIsInRange ||
        (lastPenActivityAt > 0 && performance.now() - lastPenActivityAt < PEN_TOUCH_BLOCK_TIMEOUT_MS));
}
function releasePointerCaptureIfHeld(pointerId) {
    if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
    }
}
function cancelActiveTouchInteractions() {
    clearTrackpadHoldTimer();
    stopTrackpadMomentum();
    setTrackpadZoomGestureActive(false, performance.now());
    if (trackpadPrimaryButtonDown) {
        sendMouseButton(1, false, performance.now());
        trackpadPrimaryButtonDown = false;
        trackpadDraggingPointerId = null;
    }
    for (const pointerId of trackpadTouches.keys()) {
        releasePointerCaptureIfHeld(pointerId);
    }
    trackpadTouches.clear();
    trackpadMoveRemainder = { x: 0, y: 0 };
    trackpadWheelRemainder = { x: 0, y: 0 };
    resetTrackpadGestureSession();
}
function clearTrackpadHoldTimer() {
    if (trackpadHoldTimer !== null) {
        window.clearTimeout(trackpadHoldTimer);
        trackpadHoldTimer = null;
    }
}
function stopTrackpadMomentum() {
    if (trackpadMomentumFrame !== null) {
        window.cancelAnimationFrame(trackpadMomentumFrame);
        trackpadMomentumFrame = null;
    }
    trackpadMomentumTimestamp = 0;
    trackpadMomentumVelocity = { x: 0, y: 0 };
    trackpadScrollVelocity = { x: 0, y: 0 };
}
function resetTrackpadGestureSession() {
    trackpadGestureMode = "idle";
    trackpadGestureStartedAt = 0;
    trackpadGestureMaxTouches = 0;
    trackpadPrimaryTapEligible = false;
    trackpadSecondaryTapEligible = false;
    trackpadSecondaryTouchStartedAt = 0;
    trackpadScrollOrigin = null;
    trackpadPinchOriginDistance = null;
    trackpadZoomGestureActive = false;
    trackpadLastScrollSampleAt = 0;
    trackpadZoomRemainder = 0;
    clearTrackpadHoldTimer();
}
function setTrackpadZoomGestureActive(active, timeStamp) {
    if (trackpadZoomGestureActive === active) {
        return;
    }
    trackpadZoomGestureActive = active;
    const msg = {
        ZoomState: {
            active,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    sendJsonMessage(msg);
}
function clearTrackpadPrimaryTap() {
    lastPrimaryTapAt = 0;
    lastPrimaryTapPosition = null;
}
function rememberTrackpadPrimaryTap(clientX, clientY, timeStamp) {
    lastPrimaryTapAt = timeStamp;
    lastPrimaryTapPosition = { x: clientX, y: clientY };
}
function isTrackpadDoubleTapDragCandidate(clientX, clientY, timeStamp) {
    if (touchInputSettings.dragMode !== "double-tap" || !lastPrimaryTapPosition) {
        return false;
    }
    return (timeStamp - lastPrimaryTapAt <= TRACKPAD_DOUBLE_TAP_MAX_DELAY_MS &&
        Math.hypot(clientX - lastPrimaryTapPosition.x, clientY - lastPrimaryTapPosition.y) <=
            TRACKPAD_DOUBLE_TAP_MAX_DISTANCE);
}
function clampVectorMagnitude(x, y, maxMagnitude) {
    const magnitude = Math.hypot(x, y);
    if (magnitude <= maxMagnitude || magnitude === 0) {
        return { x, y };
    }
    const scale = maxMagnitude / magnitude;
    return {
        x: x * scale,
        y: y * scale,
    };
}
function getTrackpadCentroid() {
    let totalX = 0;
    let totalY = 0;
    let count = 0;
    for (const point of trackpadTouches.values()) {
        totalX += point.x;
        totalY += point.y;
        count += 1;
    }
    if (count === 0) {
        return { x: 0, y: 0 };
    }
    return {
        x: totalX / count,
        y: totalY / count,
    };
}
function getTrackpadDistance() {
    const points = Array.from(trackpadTouches.values());
    if (points.length < 2) {
        return 0;
    }
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}
function takeWholeUnits(value) {
    return value < 0 ? Math.ceil(value) : Math.floor(value);
}
function getTrackpadTouchTravel(point) {
    return Math.hypot(point.x - point.startX, point.y - point.startY);
}
function applyTrackpadAcceleration(deltaX, deltaY, dt) {
    const distance = Math.hypot(deltaX, deltaY);
    const velocity = distance / Math.max(dt, 1);
    const normalizedVelocity = clampNumber(velocity / TRACKPAD_ACCELERATION_TARGET_VELOCITY, 0, 1);
    const gain = TRACKPAD_CURSOR_BASE_GAIN +
        (TRACKPAD_CURSOR_MAX_GAIN - TRACKPAD_CURSOR_BASE_GAIN) * normalizedVelocity * normalizedVelocity;
    return {
        x: deltaX * gain,
        y: deltaY * gain,
    };
}
function sendRelativeMouseMove(dx, dy, timeStamp) {
    if (dx === 0 && dy === 0) {
        return true;
    }
    const msg = {
        RelativeMouseMove: {
            dx,
            dy,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    return sendJsonMessage(msg, false);
}
function sendWheelEvent(dx, dy, timeStamp) {
    if (dx === 0 && dy === 0) {
        return true;
    }
    const msg = {
        WheelEvent: {
            dx,
            dy,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    return sendJsonMessage(msg, false);
}
function sendZoomEvent(delta, timeStamp) {
    if (delta === 0) {
        return true;
    }
    const msg = {
        ZoomEvent: {
            delta,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    return sendJsonMessage(msg, false);
}
function sendMouseClick(button, timeStamp) {
    const msg = {
        MouseClick: {
            button,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    sendJsonMessage(msg);
}
function sendMouseButton(button, pressed, timeStamp) {
    const msg = {
        MouseButton: {
            button,
            pressed,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    sendJsonMessage(msg);
}
function sendModifierState(modifier, active, timeStamp) {
    const msg = {
        ModifierState: {
            modifier,
            active,
            timestamp: Math.round(timeStamp * 1000),
        },
    };
    sendJsonMessage(msg);
}
function sendTrackpadMove(deltaX, deltaY, dt, timeStamp) {
    if (!currentMonitor || penArea.w <= 0 || penArea.h <= 0) {
        return;
    }
    const acceleratedDelta = applyTrackpadAcceleration(deltaX, deltaY, dt);
    const cursorScale = (currentMonitor.width / penArea.w + currentMonitor.height / penArea.h) / 2;
    trackpadMoveRemainder.x += acceleratedDelta.x * cursorScale;
    trackpadMoveRemainder.y += acceleratedDelta.y * cursorScale;
    const dx = takeWholeUnits(trackpadMoveRemainder.x);
    const dy = takeWholeUnits(trackpadMoveRemainder.y);
    if (sendRelativeMouseMove(dx, dy, timeStamp)) {
        trackpadMoveRemainder.x -= dx;
        trackpadMoveRemainder.y -= dy;
    }
}
function sendTrackpadScroll(deltaX, deltaY, timeStamp) {
    trackpadWheelRemainder.x += deltaX * TRACKPAD_SCROLL_UNITS_PER_PIXEL;
    trackpadWheelRemainder.y += deltaY * TRACKPAD_SCROLL_UNITS_PER_PIXEL;
    const dx = takeWholeUnits(trackpadWheelRemainder.x);
    const dy = takeWholeUnits(trackpadWheelRemainder.y);
    if (sendWheelEvent(dx, dy, timeStamp)) {
        trackpadWheelRemainder.x -= dx;
        trackpadWheelRemainder.y -= dy;
    }
}
function sendTrackpadZoom(deltaDistance, timeStamp) {
    if (!touchInputSettings.zoomEnabled || !trackpadZoomGestureActive) {
        return;
    }
    trackpadZoomRemainder += deltaDistance * TRACKPAD_ZOOM_UNITS_PER_PIXEL;
    const delta = takeWholeUnits(trackpadZoomRemainder);
    if (sendZoomEvent(delta, timeStamp)) {
        trackpadZoomRemainder -= delta;
    }
}
function startTrackpadMomentum() {
    stopTrackpadMomentum();
    const now = performance.now();
    if (trackpadLastScrollSampleAt === 0 ||
        now - trackpadLastScrollSampleAt > TRACKPAD_MOMENTUM_MAX_SAMPLE_AGE_MS) {
        return;
    }
    trackpadMomentumVelocity = clampVectorMagnitude(trackpadScrollVelocity.x * TRACKPAD_MOMENTUM_BOOST, trackpadScrollVelocity.y * TRACKPAD_MOMENTUM_BOOST, TRACKPAD_MOMENTUM_MAX_SPEED);
    if (Math.hypot(trackpadMomentumVelocity.x, trackpadMomentumVelocity.y) < TRACKPAD_MOMENTUM_MIN_SPEED) {
        return;
    }
    trackpadMomentumTimestamp = now;
    const step = (now) => {
        const dt = clampNumber(now - trackpadMomentumTimestamp, 8, 32);
        trackpadMomentumTimestamp = now;
        sendTrackpadScroll(trackpadMomentumVelocity.x * dt, trackpadMomentumVelocity.y * dt, now);
        const decay = Math.pow(TRACKPAD_MOMENTUM_DECAY_PER_FRAME, dt / 16.6667);
        trackpadMomentumVelocity.x *= decay;
        trackpadMomentumVelocity.y *= decay;
        if (Math.hypot(trackpadMomentumVelocity.x, trackpadMomentumVelocity.y) < TRACKPAD_MOMENTUM_MIN_SPEED) {
            stopTrackpadMomentum();
            return;
        }
        trackpadMomentumFrame = window.requestAnimationFrame(step);
    };
    trackpadMomentumFrame = window.requestAnimationFrame(step);
}
function updateTrackpadTapEligibility(point) {
    const travel = getTrackpadTouchTravel(point);
    if (travel > TRACKPAD_TAP_MAX_TRAVEL) {
        trackpadPrimaryTapEligible = false;
        trackpadSecondaryTapEligible = false;
    }
    if (travel > TRACKPAD_MOVE_START_TRAVEL && touchInputSettings.dragMode === "hold") {
        clearTrackpadHoldTimer();
    }
}
function beginTrackpadGesture(timeStamp) {
    trackpadGestureMode = "idle";
    trackpadGestureStartedAt = timeStamp;
    trackpadGestureMaxTouches = 1;
    trackpadPrimaryTapEligible = true;
    trackpadSecondaryTapEligible = false;
    trackpadSecondaryTouchStartedAt = 0;
    trackpadScrollOrigin = null;
    trackpadPinchOriginDistance = null;
    trackpadLastScrollSampleAt = 0;
    trackpadMoveRemainder = { x: 0, y: 0 };
    trackpadWheelRemainder = { x: 0, y: 0 };
    trackpadZoomRemainder = 0;
    trackpadScrollVelocity = { x: 0, y: 0 };
}
function armTrackpadHold(pointerId) {
    if (touchInputSettings.dragMode !== "hold") {
        return;
    }
    clearTrackpadHoldTimer();
    trackpadHoldTimer = window.setTimeout(() => {
        const point = trackpadTouches.get(pointerId);
        if (!point || trackpadTouches.size !== 1 || trackpadPrimaryButtonDown || trackpadGestureMode === "scroll") {
            trackpadHoldTimer = null;
            return;
        }
        if (getTrackpadTouchTravel(point) > TRACKPAD_DRAG_HOLD_MAX_TRAVEL) {
            trackpadHoldTimer = null;
            return;
        }
        trackpadGestureMode = "move";
        trackpadPrimaryTapEligible = false;
        trackpadSecondaryTapEligible = false;
        trackpadPrimaryButtonDown = true;
        trackpadDraggingPointerId = pointerId;
        sendMouseButton(1, true, performance.now());
        trackpadHoldTimer = null;
    }, touchInputSettings.longPressDelayMs);
}
function releasePrimaryTrackpadButton(timeStamp) {
    if (!trackpadPrimaryButtonDown) {
        return;
    }
    sendMouseButton(1, false, timeStamp);
    trackpadPrimaryButtonDown = false;
    trackpadDraggingPointerId = null;
}
function onTrackpadPointer(e) {
    if (e.type === "pointerdown") {
        if (!pointInPenArea(e.clientX, e.clientY)) {
            return;
        }
        stopTrackpadMomentum();
        canvas.setPointerCapture(e.pointerId);
        const wasEmpty = trackpadTouches.size === 0;
        trackpadTouches.set(e.pointerId, {
            x: e.clientX,
            y: e.clientY,
            startX: e.clientX,
            startY: e.clientY,
            startTime: e.timeStamp,
            lastTime: e.timeStamp,
        });
        if (wasEmpty) {
            beginTrackpadGesture(e.timeStamp);
            if (isTrackpadDoubleTapDragCandidate(e.clientX, e.clientY, e.timeStamp)) {
                clearTrackpadPrimaryTap();
                trackpadGestureMode = "move";
                trackpadPrimaryTapEligible = false;
                trackpadSecondaryTapEligible = false;
                trackpadPrimaryButtonDown = true;
                trackpadDraggingPointerId = e.pointerId;
                sendMouseButton(1, true, e.timeStamp);
            }
            else {
                armTrackpadHold(e.pointerId);
            }
        }
        else {
            clearTrackpadHoldTimer();
            clearTrackpadPrimaryTap();
            trackpadPrimaryTapEligible = false;
            trackpadGestureMaxTouches = Math.max(trackpadGestureMaxTouches, trackpadTouches.size);
            if (trackpadPrimaryButtonDown) {
                releasePrimaryTrackpadButton(e.timeStamp);
            }
            if (trackpadTouches.size === 2) {
                setTrackpadZoomGestureActive(false, e.timeStamp);
                trackpadSecondaryTapEligible = trackpadGestureMode === "idle";
                trackpadSecondaryTouchStartedAt = e.timeStamp;
                trackpadScrollOrigin = getTrackpadCentroid();
                trackpadPinchOriginDistance = getTrackpadDistance();
                trackpadLastScrollSampleAt = e.timeStamp;
                trackpadScrollVelocity = { x: 0, y: 0 };
            }
            else {
                trackpadSecondaryTapEligible = false;
                setTrackpadZoomGestureActive(false, e.timeStamp);
                trackpadPinchOriginDistance = null;
            }
        }
        return;
    }
    const point = trackpadTouches.get(e.pointerId);
    if (!point) {
        return;
    }
    if (e.type === "pointermove") {
        const touchCount = trackpadTouches.size;
        if (touchCount === 2) {
            const previousCentroid = getTrackpadCentroid();
            const previousDistance = getTrackpadDistance();
            point.x = e.clientX;
            point.y = e.clientY;
            const dt = Math.max(1, e.timeStamp - point.lastTime);
            point.lastTime = e.timeStamp;
            updateTrackpadTapEligibility(point);
            const nextCentroid = getTrackpadCentroid();
            const nextDistance = getTrackpadDistance();
            if (!trackpadScrollOrigin) {
                trackpadScrollOrigin = previousCentroid;
            }
            if (trackpadPinchOriginDistance === null) {
                trackpadPinchOriginDistance = previousDistance;
            }
            const origin = trackpadScrollOrigin;
            const totalTravel = Math.hypot(nextCentroid.x - origin.x, nextCentroid.y - origin.y);
            const totalZoomTravel = Math.abs(nextDistance - trackpadPinchOriginDistance);
            const shouldStartScroll = totalTravel >= TRACKPAD_SCROLL_START_TRAVEL;
            const shouldStartZoom = touchInputSettings.zoomEnabled &&
                !trackpadZoomGestureActive &&
                totalZoomTravel >= TRACKPAD_ZOOM_START_DISTANCE;
            if (trackpadGestureMode === "scroll" ||
                shouldStartScroll ||
                shouldStartZoom) {
                trackpadGestureMode = "scroll";
                trackpadSecondaryTapEligible = false;
                const deltaX = nextCentroid.x - previousCentroid.x;
                const deltaY = nextCentroid.y - previousCentroid.y;
                sendTrackpadScroll(deltaX, deltaY, e.timeStamp);
                if (shouldStartZoom) {
                    setTrackpadZoomGestureActive(true, e.timeStamp);
                    trackpadPinchOriginDistance = nextDistance;
                    trackpadZoomRemainder = 0;
                }
                else if (trackpadZoomGestureActive) {
                    const deltaDistance = nextDistance - previousDistance;
                    sendTrackpadZoom(deltaDistance, e.timeStamp);
                }
                const instantVelocityX = deltaX / dt;
                const instantVelocityY = deltaY / dt;
                trackpadScrollVelocity.x = trackpadScrollVelocity.x * 0.72 + instantVelocityX * 0.28;
                trackpadScrollVelocity.y = trackpadScrollVelocity.y * 0.72 + instantVelocityY * 0.28;
                trackpadLastScrollSampleAt = e.timeStamp;
            }
            return;
        }
        const previousX = point.x;
        const previousY = point.y;
        point.x = e.clientX;
        point.y = e.clientY;
        const dt = Math.max(1, e.timeStamp - point.lastTime);
        point.lastTime = e.timeStamp;
        updateTrackpadTapEligibility(point);
        if (touchCount === 1) {
            if (trackpadGestureMaxTouches > 1 && !trackpadPrimaryButtonDown) {
                return;
            }
            const totalTravel = getTrackpadTouchTravel(point);
            const deltaX = point.x - previousX;
            const deltaY = point.y - previousY;
            if (!trackpadPrimaryButtonDown && trackpadGestureMode !== "move" && totalTravel < TRACKPAD_MOVE_START_TRAVEL) {
                return;
            }
            trackpadGestureMode = "move";
            trackpadPrimaryTapEligible = false;
            sendTrackpadMove(deltaX, deltaY, dt, e.timeStamp);
            return;
        }
        if (touchCount > 2) {
            point.x = e.clientX;
            point.y = e.clientY;
            trackpadSecondaryTapEligible = false;
            setTrackpadZoomGestureActive(false, e.timeStamp);
            trackpadPinchOriginDistance = null;
        }
        return;
    }
    if (e.type === "pointerup" || e.type === "pointercancel") {
        releasePointerCaptureIfHeld(e.pointerId);
        trackpadTouches.delete(e.pointerId);
        if (trackpadTouches.size < 2) {
            setTrackpadZoomGestureActive(false, e.timeStamp);
            trackpadPinchOriginDistance = null;
        }
        else if (trackpadTouches.size === 2) {
            trackpadScrollOrigin = getTrackpadCentroid();
            trackpadPinchOriginDistance = getTrackpadDistance();
            trackpadLastScrollSampleAt = e.timeStamp;
            trackpadScrollVelocity = { x: 0, y: 0 };
        }
        if (trackpadPrimaryButtonDown && (trackpadDraggingPointerId === e.pointerId || trackpadTouches.size === 0)) {
            releasePrimaryTrackpadButton(e.timeStamp);
        }
        if (trackpadTouches.size === 0) {
            const shouldPrimaryTap = e.type === "pointerup" &&
                trackpadGestureMaxTouches === 1 &&
                trackpadPrimaryTapEligible &&
                e.timeStamp - trackpadGestureStartedAt <= TRACKPAD_TAP_MAX_DURATION_MS;
            const shouldSecondaryTap = e.type === "pointerup" &&
                trackpadGestureMaxTouches === 2 &&
                trackpadSecondaryTapEligible &&
                e.timeStamp - trackpadSecondaryTouchStartedAt <= TRACKPAD_TWO_FINGER_TAP_MAX_DURATION_MS;
            const shouldMomentum = e.type === "pointerup" &&
                trackpadGestureMode === "scroll" &&
                Math.hypot(trackpadScrollVelocity.x, trackpadScrollVelocity.y) >= TRACKPAD_MOMENTUM_MIN_SPEED;
            if (shouldPrimaryTap) {
                sendMouseClick(1, e.timeStamp);
                rememberTrackpadPrimaryTap(e.clientX, e.clientY, e.timeStamp);
            }
            else if (shouldSecondaryTap) {
                sendMouseClick(2, e.timeStamp);
                clearTrackpadPrimaryTap();
            }
            else if (shouldMomentum) {
                startTrackpadMomentum();
                clearTrackpadPrimaryTap();
            }
            else {
                clearTrackpadPrimaryTap();
            }
            trackpadMoveRemainder = { x: 0, y: 0 };
            if (!shouldMomentum) {
                trackpadWheelRemainder = { x: 0, y: 0 };
            }
            resetTrackpadGestureSession();
        }
    }
}
function sendPointerPayload(pointerEvent) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    if (pointerEvent.event_type === "pointermove" &&
        ws.bufferedAmount > WS_POINTER_BACKPRESSURE_LIMIT_BYTES) {
        return;
    }
    const buf = new ArrayBuffer(1 + BINARY_EVENT_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, BINARY_MSG_POINTER_EVENT);
    writeBinaryPointerEvent(view, 1, pointerEvent);
    ws.send(buf);
}
function queuePenBatchPayload(payload) {
    pendingPenBatch.push(payload);
    if (pendingPenBatch.length >= PEN_BATCH_MAX_EVENTS) {
        flushPenBatch();
        return;
    }
    if (penBatchFlushFrame === null) {
        penBatchFlushFrame = window.requestAnimationFrame(flushPenBatch);
    }
}
function discardPenBatch() {
    if (penBatchFlushFrame !== null) {
        window.cancelAnimationFrame(penBatchFlushFrame);
        penBatchFlushFrame = null;
    }
    pendingPenBatch = [];
}
function flushPenBatch() {
    if (penBatchFlushFrame !== null) {
        window.cancelAnimationFrame(penBatchFlushFrame);
        penBatchFlushFrame = null;
    }
    if (pendingPenBatch.length === 0) {
        return;
    }
    const batch = pendingPenBatch;
    pendingPenBatch = [];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    if (ws.bufferedAmount > WS_POINTER_BACKPRESSURE_LIMIT_BYTES) {
        return;
    }
    if (batch.length === 1) {
        sendPointerPayload(batch[0]);
        return;
    }
    const buf = new ArrayBuffer(2 + batch.length * BINARY_EVENT_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, BINARY_MSG_POINTER_EVENTS);
    view.setUint8(1, batch.length);
    for (let i = 0; i < batch.length; i++) {
        writeBinaryPointerEvent(view, 2 + i * BINARY_EVENT_SIZE, batch[i]);
    }
    ws.send(buf);
}
function writeBinaryPointerEvent(view, offset, e) {
    view.setUint8(offset, BINARY_EVENT_TYPE_MAP[e.event_type] ?? 3);
    view.setUint8(offset + 1, (e.is_primary ? 1 : 0) | (e.hovering ? 2 : 0));
    view.setUint8(offset + 2, e.button);
    view.setUint8(offset + 3, e.buttons);
    view.setFloat32(offset + 4, e.x, true);
    view.setFloat32(offset + 8, e.y, true);
    view.setUint16(offset + 12, Math.round(clampNumber(e.pressure, 0, 1) * 1024), true);
    view.setInt8(offset + 14, clampNumber(e.tilt_x, -90, 90));
    view.setInt8(offset + 15, clampNumber(e.tilt_y, -90, 90));
    view.setUint16(offset + 16, e.twist & 0xFFFF, true);
}
function sendJsonMessage(value, allowWhenCongested = true) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    if (!allowWhenCongested && ws.bufferedAmount > WS_CONTROL_BACKPRESSURE_LIMIT_BYTES) {
        return false;
    }
    ws.send(JSON.stringify(value));
    return true;
}
function recordServerActivity() {
    lastServerActivityAt = performance.now();
    heartbeatConsecutiveMisses = 0;
}
function stopHeartbeat() {
    if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    heartbeatConsecutiveMisses = 0;
}
function startHeartbeat(socket) {
    stopHeartbeat();
    recordServerActivity();
    heartbeatTimer = window.setInterval(() => {
        if (ws !== socket) {
            stopHeartbeat();
            return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const now = performance.now();
        if (now - lastServerActivityAt > WS_HEARTBEAT_TIMEOUT_MS) {
            heartbeatConsecutiveMisses += 1;
            if (heartbeatConsecutiveMisses >= WS_HEARTBEAT_MAX_CONSECUTIVE_MISSES) {
                setConnectionVisualState("reconnecting", "The connection stalled. Reconnecting to the desktop...");
                socket.close();
                return;
            }
            // First miss — assume transient and try once more before giving up.
        }
        socket.send(JSON.stringify("Ping"));
    }, WS_HEARTBEAT_INTERVAL_MS);
}
function setConnectionVisualState(state, detail) {
    connectionOverlay.dataset.state = state;
    connectionOverlay.classList.toggle("hidden", state === "ready");
    connectionAttemptText.textContent =
        state === "ready" ? "Connected" : `Attempt ${reconnectAttempt + 1}`;
    switch (state) {
        case "connecting":
            connectionTitle.textContent = "Preparing tablet";
            connectionStateText.textContent = "Connecting to the desktop...";
            connectionDetailText.textContent =
                detail ??
                    "Keep this page open while Pipatab establishes the local network session.";
            setStatus("Connecting...", false);
            break;
        case "syncing":
            connectionTitle.textContent = "Preparing tablet";
            connectionStateText.textContent = "Connected. Syncing display settings...";
            connectionDetailText.textContent =
                detail ?? "The workspace will unlock as soon as the monitor mapping is ready.";
            setStatus("Connecting...", false);
            break;
        case "reconnecting":
            connectionTitle.textContent = "Reconnecting";
            connectionStateText.textContent = "Trying to recover the tablet session...";
            connectionDetailText.textContent =
                detail ??
                    "If this takes too long, check that the computer and tablet are on the same Wi-Fi network.";
            setStatus("Connecting...", false);
            break;
        case "offline":
            connectionTitle.textContent = "Waiting for network";
            connectionStateText.textContent = "The tablet is offline.";
            connectionDetailText.textContent =
                detail ??
                    "Reconnect the tablet to the same local network as the desktop, then Pipatab will retry automatically.";
            setStatus("Disconnected", false);
            break;
        case "ready":
            setStatus("Connected", true);
            break;
    }
}
function setupConnectionLifecycle() {
    window.addEventListener("online", () => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connect();
            return;
        }
        if (ws.readyState === WebSocket.OPEN) {
            if (performance.now() - lastServerActivityAt > WS_VISIBLE_STALE_GRACE_MS) {
                setConnectionVisualState("reconnecting", "Network is back. Restoring the tablet session...");
                ws.close();
            }
            else {
                ws.send(JSON.stringify("Ping"));
            }
        }
    });
    window.addEventListener("offline", () => {
        setConnectionVisualState("offline", "The tablet lost network access. Waiting for the local network to come back...");
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            return;
        }
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connect();
            return;
        }
        if (ws.readyState === WebSocket.OPEN &&
            performance.now() - lastServerActivityAt > WS_VISIBLE_STALE_GRACE_MS) {
            setConnectionVisualState("reconnecting", "Checking the connection after returning to the tablet...");
            ws.close();
        }
        else if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify("Ping"));
        }
    });
    window.addEventListener("pageshow", () => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connect();
        }
    });
    window.addEventListener("beforeunload", () => {
        stopHeartbeat();
        ws?.close();
    });
}
function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
        return;
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    let url = `${proto}//${loc.host}/ws`;
    const params = new URLSearchParams(loc.search);
    const code = params.get("access_code");
    if (code)
        url += `?access_code=${encodeURIComponent(code)}`;
    setConnectionVisualState(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
        if (ws !== socket) {
            socket.close();
            return;
        }
        setConnectionVisualState("syncing");
        reconnectAttempt = 0;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        recordServerActivity();
        startHeartbeat(socket);
        sendJsonMessage("RequestMonitorList");
        resendActiveModifierStates();
    };
    socket.onmessage = (ev) => {
        if (ws !== socket) {
            return;
        }
        recordServerActivity();
        const data = ev.data;
        if (typeof data === "string") {
            try {
                handleMessage(JSON.parse(data));
            }
            catch {
                console.warn("Failed to parse server message");
            }
        }
        else if (data instanceof Blob) {
            data.text().then(text => {
                try {
                    handleMessage(JSON.parse(text));
                }
                catch {
                    console.warn("Failed to parse server message (blob)");
                }
            });
        }
    };
    socket.onclose = () => {
        if (ws !== socket) {
            return;
        }
        ws = null;
        stopHeartbeat();
        discardPenBatch();
        cancelActiveTouchInteractions();
        setLivePressureIndicator(0, 0, false);
        setConnectionVisualState(navigator.onLine ? "reconnecting" : "offline", navigator.onLine
            ? "The connection dropped. Pipatab is retrying automatically..."
            : "The tablet is offline. Waiting for the local network to return...");
        scheduleReconnect();
    };
    socket.onerror = () => {
        if (ws !== socket) {
            return;
        }
        setConnectionVisualState(navigator.onLine ? "reconnecting" : "offline", navigator.onLine
            ? "The connection hit an error. Retrying on the local network..."
            : "The tablet is offline. Waiting for the local network to return...");
        socket.close();
    };
}
function scheduleReconnect() {
    if (reconnectTimer !== null)
        return;
    const delay = Math.min(WS_RECONNECT_BASE_DELAY_MS * Math.pow(1.5, reconnectAttempt), WS_RECONNECT_MAX_DELAY_MS);
    reconnectAttempt++;
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}
function handleMessage(msg) {
    if (typeof msg === "string") {
        if (msg === "ConfigOk") {
            setConnectionVisualState("ready");
        }
        return;
    }
    if ("MonitorList" in msg) {
        populateMonitors(msg.MonitorList);
        setConnectionVisualState("ready");
    }
    if ("Error" in msg) {
        console.error("Server error:", msg.Error);
        if (!currentMonitor) {
            setConnectionVisualState("offline", msg.Error);
        }
    }
}
// ─── Monitor Selection ────────────────────────────────────────────────────────
function loadSelectedMonitorSelection() {
    try {
        const stored = window.localStorage.getItem(MONITOR_SELECTION_STORAGE_KEY);
        return stored && stored.trim().length > 0 ? stored : null;
    }
    catch {
        return null;
    }
}
function rememberSelectedMonitor(id) {
    selectedMonitorId = id;
    try {
        if (id) {
            window.localStorage.setItem(MONITOR_SELECTION_STORAGE_KEY, id);
        }
        else {
            window.localStorage.removeItem(MONITOR_SELECTION_STORAGE_KEY);
        }
    }
    catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}
function populateMonitors(monitors) {
    monitorList = monitors;
    monitorSelect.innerHTML = "";
    for (const m of monitors) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.width}×${m.height})${m.is_primary ? " ★" : ""}`;
        monitorSelect.appendChild(opt);
    }
    const preferredId = selectedMonitorId ?? currentMonitor?.id ?? null;
    const preferred = preferredId ? monitors.find(m => m.id === preferredId) ?? null : null;
    const primary = monitors.find(m => m.is_primary);
    const selected = preferred ?? primary ?? monitors[0] ?? null;
    if (selected) {
        monitorSelect.value = selected.id;
        setCurrentMonitor(selected);
        sendJsonMessage({ SelectMonitor: selected.id });
    }
}
function setCurrentMonitor(m) {
    currentMonitor = m;
    rememberSelectedMonitor(m.id);
    recalcPenArea();
    drawPenArea();
}
// ─── UI ───────────────────────────────────────────────────────────────────────
function setupUI() {
    settingsPanel = document.getElementById("settings");
    const btnOpen = document.getElementById("btn-open-settings");
    const btnClose = document.getElementById("btn-close-settings");
    const btnFullscreen = document.getElementById("btn-fullscreen");
    const btnInterpolateMiddle = document.getElementById("btn-interpolate-middle");
    const btnResetPressure = document.getElementById("btn-reset-pressure");
    pencilSqueezeSelect = document.getElementById("pencil-squeeze-modifier");
    btnTrackpadMode = document.getElementById("btn-trackpad-mode");
    btnTrackpadZoom = document.getElementById("btn-trackpad-zoom");
    btnTrackpadDragDoubleTap = document.getElementById("btn-trackpad-drag-double-tap");
    btnTrackpadDragHold = document.getElementById("btn-trackpad-drag-hold");
    trackpadDragModeControl = document.getElementById("trackpad-drag-mode");
    trackpadHoldDelayGroup = document.getElementById("trackpad-hold-delay-group");
    trackpadHoldDelayInput = document.getElementById("trackpad-hold-delay");
    trackpadHoldDelayValue = document.getElementById("trackpad-hold-delay-value");
    pressureReadoutStart = document.getElementById("pressure-readout-start");
    pressureReadoutMiddle = document.getElementById("pressure-readout-middle");
    pressureReadoutEnd = document.getElementById("pressure-readout-end");
    btnOpen.addEventListener("click", () => {
        settingsPanel.classList.remove("hidden");
        btnOpen.style.display = "none";
        syncPressureCurveEditor();
    });
    btnClose.addEventListener("click", () => {
        settingsPanel.classList.add("hidden");
        btnOpen.style.display = "";
    });
    btnFullscreen.addEventListener("click", () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        }
        else {
            document.exitFullscreen().catch(() => { });
        }
    });
    pressurePreview.addEventListener("pointerdown", onPressurePreviewPointerDown);
    pressurePreview.addEventListener("pointermove", onPressurePreviewPointerMove);
    pressurePreview.addEventListener("pointerup", endPressurePreviewInteraction);
    pressurePreview.addEventListener("pointercancel", endPressurePreviewInteraction);
    btnInterpolateMiddle.addEventListener("click", () => {
        interpolateMiddlePoint();
    });
    btnResetPressure.addEventListener("click", () => {
        setPressureCurve({ ...DEFAULT_PRESSURE_CURVE }, true);
    });
    pencilSqueezeSelect.addEventListener("change", () => {
        setPencilSqueezeModifier(normalizePencilSqueezeModifier(pencilSqueezeSelect.value), true);
    });
    btnTrackpadMode.addEventListener("click", () => {
        setTouchInputSettings({
            enabled: !touchInputSettings.enabled,
            zoomEnabled: touchInputSettings.zoomEnabled,
            dragMode: touchInputSettings.dragMode,
            longPressDelayMs: touchInputSettings.longPressDelayMs,
        }, true);
    });
    btnTrackpadZoom.addEventListener("click", () => {
        setTouchInputSettings({
            ...touchInputSettings,
            zoomEnabled: !touchInputSettings.zoomEnabled,
        }, true);
    });
    btnTrackpadDragDoubleTap.addEventListener("click", () => {
        setTouchInputSettings({
            ...touchInputSettings,
            dragMode: "double-tap",
        }, true);
    });
    btnTrackpadDragHold.addEventListener("click", () => {
        setTouchInputSettings({
            ...touchInputSettings,
            dragMode: "hold",
        }, true);
    });
    trackpadHoldDelayInput.addEventListener("input", () => {
        setTouchInputSettings({
            ...touchInputSettings,
            longPressDelayMs: Number(trackpadHoldDelayInput.value),
        }, true);
    });
    monitorSelect.addEventListener("change", () => {
        const id = monitorSelect.value;
        rememberSelectedMonitor(id || null);
        sendJsonMessage({ SelectMonitor: id });
        // Update pen area from cached monitor list
        const mon = monitorList.find(m => m.id === id);
        if (mon) {
            setCurrentMonitor(mon);
        }
    });
    if (typeof ResizeObserver !== "undefined") {
        pressurePreviewResizeObserver?.disconnect();
        pressurePreviewResizeObserver = new ResizeObserver(() => {
            schedulePressureCurvePreviewDraw(true);
        });
        pressurePreviewResizeObserver.observe(pressurePreview);
    }
    window.addEventListener("resize", () => {
        schedulePressureCurvePreviewDraw(true);
    });
    syncPressureCurveEditor();
    syncPencilSqueezeControls();
    syncTouchInputControls();
    // Initial draw
    drawPenArea();
}
function setStatus(text, connected) {
    statusDot.classList.remove("connected", "connecting", "offline");
    const normalizedText = text.trim().toLowerCase();
    if (connected) {
        statusDot.classList.add("connected");
    }
    else if (normalizedText.startsWith("connecting")) {
        statusDot.classList.add("connecting");
    }
    else {
        statusDot.classList.add("offline");
    }
    statusDot.title = text;
}
