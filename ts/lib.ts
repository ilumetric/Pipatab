// Pipatab — Stylus-first wireless tablet client
// Apple Pencil drives pen input. When the Pencil is away, touch can act as a trackpad.
// Hover, pressure, tilt, twist, barrel button, eraser — all forwarded.

interface JsonPointerEvent {
    event_type: string;
    pointer_id: number;
    timestamp: number;
    is_primary: boolean;
    x: number;
    y: number;
    pressure: number;
    tilt_x: number;
    tilt_y: number;
    twist: number;
    button: number;
    buttons: number;
    hovering: boolean;
}

interface RelativeMouseMovePayload {
    dx: number;
    dy: number;
    timestamp: number;
}

interface WheelPayload {
    dx: number;
    dy: number;
    timestamp: number;
}

interface ZoomPayload {
    delta: number;
    timestamp: number;
}

interface ZoomStatePayload {
    active: boolean;
    timestamp: number;
}

interface MouseClickPayload {
    button: number;
    timestamp: number;
}

interface MouseButtonPayload {
    button: number;
    pressed: boolean;
    timestamp: number;
}

type MonitorInfo = {
    id: string;
    name: string;
    width: number;
    height: number;
    is_primary: boolean;
};

type PressureCurveSettings = {
    startY: number;
    middleX: number;
    middleY: number;
    endX: number;
};

type CurvePoint = {
    x: number;
    y: number;
};

type PressureHandle = "start" | "middle" | "end";

type LivePressureIndicator = {
    raw: number;
    mapped: number;
    visible: boolean;
};

type DragMode = "hold" | "double-tap";

type TouchInputSettings = {
    enabled: boolean;
    zoomEnabled: boolean;
    dragMode: DragMode;
    longPressDelayMs: number;
};

type TrackpadTouchPoint = {
    x: number;
    y: number;
    startX: number;
    startY: number;
    startTime: number;
    lastTime: number;
};

type ScreenPoint = {
    x: number;
    y: number;
};

type TrackpadGestureMode = "idle" | "move" | "scroll";

type MessageOutbound =
    | { MonitorList: MonitorInfo[] }
    | "ConfigOk"
    | { Error: string };

// ─── State ────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let statusDot: HTMLSpanElement;
let monitorSelect: HTMLSelectElement;
let pressurePreview: HTMLCanvasElement;
let pressurePreviewCtx: CanvasRenderingContext2D;
let settingsPanel: HTMLDivElement;
let btnTrackpadMode: HTMLButtonElement;
let btnTrackpadZoom: HTMLButtonElement;
let btnTrackpadDragHold: HTMLButtonElement;
let btnTrackpadDragDoubleTap: HTMLButtonElement;
let trackpadDragModeControl: HTMLDivElement;
let trackpadHoldDelayGroup: HTMLDivElement;
let trackpadHoldDelayInput: HTMLInputElement;
let trackpadHoldDelayValue: HTMLSpanElement;
let reconnectTimer: number | null = null;
let pressurePreviewFrame: number | null = null;
let activePressureHandle: PressureHandle | null = null;
let livePressureIndicator: LivePressureIndicator = {
    raw: 0,
    mapped: 0,
    visible: false,
};

// Pen active area (pixel coords on canvas, accounting for monitor aspect ratio)
let penArea = { x: 0, y: 0, w: 0, h: 0 };
let currentMonitor: MonitorInfo | null = null;
let monitorList: MonitorInfo[] = [];
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
const LEGACY_TRACKPAD_MODE_STORAGE_KEY = "pipatab.trackpad.v3";
const LEGACY_TRACKPAD_MODE_STORAGE_KEY_V2 = "pipatab.trackpad.v2";
const LEGACY_TOUCH_INPUT_STORAGE_KEY = "pipatab.touchInput.v1";
const PRESSURE_CURVE_LUT_SIZE = 256;
const PRESSURE_CURVE_START_X = 0;
const PRESSURE_CURVE_POINT_GAP = 0.08;
const PRESSURE_CURVE_HANDLE_RADIUS = 18;
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
const DEFAULT_PRESSURE_CURVE: PressureCurveSettings = {
    startY: 0,
    middleX: 0.5,
    middleY: 0.5,
    endX: 1,
};
const DEFAULT_TOUCH_INPUT_SETTINGS: TouchInputSettings = {
    enabled: true,
    zoomEnabled: true,
    dragMode: "double-tap",
    longPressDelayMs: 180,
};

let pressureCurve: PressureCurveSettings = { ...DEFAULT_PRESSURE_CURVE };
let pressureCurveLut = buildPressureCurveLut(pressureCurve);
let touchInputSettings: TouchInputSettings = { ...DEFAULT_TOUCH_INPUT_SETTINGS };
let penIsInRange = false;
let lastPenActivityAt = 0;
const trackpadTouches = new Map<number, TrackpadTouchPoint>();
let trackpadMoveRemainder = { x: 0, y: 0 };
let trackpadWheelRemainder = { x: 0, y: 0 };
let trackpadZoomRemainder = 0;
let trackpadGestureMode: TrackpadGestureMode = "idle";
let trackpadGestureStartedAt = 0;
let trackpadGestureMaxTouches = 0;
let trackpadPrimaryTapEligible = false;
let trackpadSecondaryTapEligible = false;
let trackpadSecondaryTouchStartedAt = 0;
let trackpadScrollOrigin: ScreenPoint | null = null;
let trackpadPinchOriginDistance: number | null = null;
let trackpadZoomGestureActive = false;
let trackpadScrollVelocity = { x: 0, y: 0 };
let trackpadMomentumVelocity = { x: 0, y: 0 };
let trackpadLastScrollSampleAt = 0;
let trackpadHoldTimer: number | null = null;
let trackpadPrimaryButtonDown = false;
let trackpadDraggingPointerId: number | null = null;
let trackpadMomentumFrame: number | null = null;
let trackpadMomentumTimestamp = 0;
let lastPrimaryTapAt = 0;
let lastPrimaryTapPosition: ScreenPoint | null = null;

// ─── Entry ────────────────────────────────────────────────────────────────────

window.onload = () => {
    canvas = document.getElementById("tablet") as HTMLCanvasElement;
    ctx = canvas.getContext("2d")!;
    statusDot = document.getElementById("status-dot") as HTMLSpanElement;
    monitorSelect = document.getElementById("monitor-select") as HTMLSelectElement;
    pressurePreview = document.getElementById("pressure-preview") as HTMLCanvasElement;
    pressurePreviewCtx = pressurePreview.getContext("2d")!;

    pressureCurve = loadPressureCurveSettings();
    pressureCurveLut = buildPressureCurveLut(pressureCurve);
    touchInputSettings = loadTouchInputSettings();

    setupCanvas();
    setupUI();
    connect();
};

function clampNumber(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function normalizeTrackpadHoldDelay(delayMs: number) {
    const clamped = clampNumber(delayMs, TRACKPAD_HOLD_DELAY_MIN_MS, TRACKPAD_HOLD_DELAY_MAX_MS);
    return Math.round(clamped / TRACKPAD_HOLD_DELAY_STEP_MS) * TRACKPAD_HOLD_DELAY_STEP_MS;
}

function normalizePressureCurve(
    curve: Partial<PressureCurveSettings> | null | undefined
): PressureCurveSettings {
    const startYRaw =
        typeof curve?.startY === "number" ? curve.startY : DEFAULT_PRESSURE_CURVE.startY;
    const startY = clampNumber(startYRaw, 0, 0.72);

    const middleXMin = PRESSURE_CURVE_START_X + PRESSURE_CURVE_POINT_GAP;
    const middleXRaw =
        typeof curve?.middleX === "number" ? curve.middleX : DEFAULT_PRESSURE_CURVE.middleX;
    const endXRaw = typeof curve?.endX === "number" ? curve.endX : DEFAULT_PRESSURE_CURVE.endX;

    const middleXMax = clampNumber(
        endXRaw - PRESSURE_CURVE_POINT_GAP,
        middleXMin,
        1 - PRESSURE_CURVE_POINT_GAP
    );
    const middleX = clampNumber(middleXRaw, middleXMin, middleXMax);
    const endX = clampNumber(endXRaw, middleX + PRESSURE_CURVE_POINT_GAP, 1);

    const middleYRaw =
        typeof curve?.middleY === "number" ? curve.middleY : DEFAULT_PRESSURE_CURVE.middleY;
    const middleY = clampNumber(middleYRaw, startY + 0.04, 0.96);

    return { startY, middleX, middleY, endX };
}

function loadPressureCurveSettings(): PressureCurveSettings {
    try {
        const raw = window.localStorage.getItem(PRESSURE_CURVE_STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_PRESSURE_CURVE };
        }
        return normalizePressureCurve(JSON.parse(raw) as Partial<PressureCurveSettings>);
    } catch {
        return { ...DEFAULT_PRESSURE_CURVE };
    }
}

function savePressureCurveSettings() {
    try {
        window.localStorage.setItem(PRESSURE_CURVE_STORAGE_KEY, JSON.stringify(pressureCurve));
    } catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}

function normalizeTouchInputSettings(
    settings: Partial<TouchInputSettings> | null | undefined
): TouchInputSettings {
    const longPressDelayRaw =
        typeof settings?.longPressDelayMs === "number"
            ? settings.longPressDelayMs
            : DEFAULT_TOUCH_INPUT_SETTINGS.longPressDelayMs;

    return {
        enabled: settings?.enabled !== false,
        zoomEnabled: settings?.zoomEnabled !== false,
        dragMode: settings?.dragMode === "double-tap" ? "double-tap" : "hold",
        longPressDelayMs: normalizeTrackpadHoldDelay(longPressDelayRaw),
    };
}

function loadTouchInputSettings(): TouchInputSettings {
    try {
        const currentRaw = window.localStorage.getItem(TRACKPAD_MODE_STORAGE_KEY);
        if (currentRaw) {
            return normalizeTouchInputSettings(JSON.parse(currentRaw) as Partial<TouchInputSettings>);
        }

        const legacyRaw =
            window.localStorage.getItem(LEGACY_TRACKPAD_MODE_STORAGE_KEY) ??
            window.localStorage.getItem(LEGACY_TRACKPAD_MODE_STORAGE_KEY_V2) ??
            window.localStorage.getItem(LEGACY_TOUCH_INPUT_STORAGE_KEY);
        if (!legacyRaw) {
            return { ...DEFAULT_TOUCH_INPUT_SETTINGS };
        }

        const legacySettings = JSON.parse(legacyRaw) as Partial<TouchInputSettings>;
        const normalized = normalizeTouchInputSettings(legacySettings);
        return {
            ...normalized,
            dragMode: DEFAULT_TOUCH_INPUT_SETTINGS.dragMode,
        };
    } catch {
        return { ...DEFAULT_TOUCH_INPUT_SETTINGS };
    }
}

function saveTouchInputSettings() {
    try {
        window.localStorage.setItem(TRACKPAD_MODE_STORAGE_KEY, JSON.stringify(touchInputSettings));
    } catch {
        // Ignore storage errors in private browsing or restricted environments.
    }
}

function syncTouchInputControls() {
    btnTrackpadMode.classList.toggle("enabled", touchInputSettings.enabled);
    btnTrackpadMode.setAttribute("aria-pressed", touchInputSettings.enabled ? "true" : "false");
    btnTrackpadZoom.classList.toggle(
        "enabled",
        touchInputSettings.enabled && touchInputSettings.zoomEnabled
    );
    btnTrackpadZoom.setAttribute(
        "aria-pressed",
        touchInputSettings.enabled && touchInputSettings.zoomEnabled ? "true" : "false"
    );
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

function setTouchInputSettings(nextSettings: TouchInputSettings, persist: boolean) {
    const next = normalizeTouchInputSettings(nextSettings);
    const changed =
        next.enabled !== touchInputSettings.enabled ||
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

function getPressureCurvePoints(curve: PressureCurveSettings): CurvePoint[] {
    const points: CurvePoint[] = [
        { x: PRESSURE_CURVE_START_X, y: curve.startY },
        { x: curve.middleX, y: curve.middleY },
    ];
    if (curve.endX < 0.999) {
        points.push({ x: curve.endX, y: 1 });
    }
    points.push({ x: 1, y: 1 });
    return points;
}

function buildMonotoneTangents(points: CurvePoint[]): number[] {
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

function sampleMonotoneCurve(points: CurvePoint[], tangents: number[], x: number) {
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

        return clampNumber(
            h00 * p0.y + h10 * span * tangents[i] + h01 * p1.y + h11 * span * tangents[i + 1],
            0,
            1
        );
    }

    return points[points.length - 1].y;
}

function buildPressureCurveLut(curve: PressureCurveSettings) {
    const points = getPressureCurvePoints(curve);
    const tangents = buildMonotoneTangents(points);
    const lut: number[] = [];

    for (let i = 0; i <= PRESSURE_CURVE_LUT_SIZE; i++) {
        const x = i / PRESSURE_CURVE_LUT_SIZE;
        lut.push(sampleMonotoneCurve(points, tangents, x));
    }

    return lut;
}

function applyPressureCurve(rawPressure: number) {
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
    schedulePressureCurvePreviewDraw(true);
}

function schedulePressureCurvePreviewDraw(force: boolean = false) {
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

function setPressureCurve(nextCurve: PressureCurveSettings, persist: boolean) {
    pressureCurve = normalizePressureCurve(nextCurve);
    pressureCurveLut = buildPressureCurveLut(pressureCurve);
    syncPressureCurveEditor();
    if (persist) {
        savePressureCurveSettings();
    }
}

function setLivePressureIndicator(raw: number, mapped: number, visible: boolean) {
    livePressureIndicator = {
        raw: clampNumber(raw, 0, 1),
        mapped: clampNumber(mapped, 0, 1),
        visible,
    };
    schedulePressureCurvePreviewDraw();
}

function interpolateMiddlePoint() {
    const nextMiddleX = pressureCurve.endX / 2;
    const nextMiddleY =
        pressureCurve.endX <= 0
            ? pressureCurve.startY
            : pressureCurve.startY +
            ((1 - pressureCurve.startY) * nextMiddleX) / pressureCurve.endX;

    setPressureCurve(
        {
            ...pressureCurve,
            middleX: nextMiddleX,
            middleY: nextMiddleY,
        },
        true
    );
}

function getPressurePreviewLayout() {
    const width = pressurePreview.width;
    const height = pressurePreview.height;
    const padLeft = 34;
    const padRight = 18;
    const padTop = 18;
    const padBottom = 30;
    const innerWidth = width - padLeft - padRight;
    const innerHeight = height - padTop - padBottom;

    return {
        width,
        height,
        padLeft,
        padRight,
        padTop,
        padBottom,
        mapX(value: number) {
            return padLeft + clampNumber(value, 0, 1) * innerWidth;
        },
        mapY(value: number) {
            return height - padBottom - clampNumber(value, 0, 1) * innerHeight;
        },
        unmapX(pixelX: number) {
            return clampNumber((pixelX - padLeft) / innerWidth, 0, 1);
        },
        unmapY(pixelY: number) {
            return clampNumber((height - padBottom - pixelY) / innerHeight, 0, 1);
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

function getPreviewPixelPosition(event: PointerEvent) {
    const rect = pressurePreview.getBoundingClientRect();
    const scaleX = pressurePreview.width / rect.width;
    const scaleY = pressurePreview.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
    };
}

function pickPressureHandle(event: PointerEvent): PressureHandle | null {
    const pos = getPreviewPixelPosition(event);
    const handles = getPressureHandlePositions();
    let bestHandle: PressureHandle | null = null;
    let bestDistanceSq = PRESSURE_CURVE_HANDLE_RADIUS * PRESSURE_CURVE_HANDLE_RADIUS;

    for (const handle of ["start", "middle", "end"] as const) {
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

function updatePressureHandleFromEvent(handle: PressureHandle, event: PointerEvent) {
    const layout = getPressurePreviewLayout();
    const pos = getPreviewPixelPosition(event);
    const pressureX = layout.unmapX(pos.x);
    const pressureY = layout.unmapY(pos.y);
    const nextCurve: PressureCurveSettings = { ...pressureCurve };

    if (handle === "start") {
        nextCurve.startY = clampNumber(pressureY, 0, nextCurve.middleY - 0.04);
    } else if (handle === "middle") {
        nextCurve.middleX = clampNumber(
            pressureX,
            PRESSURE_CURVE_START_X + PRESSURE_CURVE_POINT_GAP,
            nextCurve.endX - PRESSURE_CURVE_POINT_GAP
        );
        nextCurve.middleY = clampNumber(pressureY, nextCurve.startY + 0.04, 0.96);
    } else {
        nextCurve.endX = clampNumber(pressureX, nextCurve.middleX + PRESSURE_CURVE_POINT_GAP, 1);
    }

    setPressureCurve(nextCurve, true);
}

function onPressurePreviewPointerDown(event: PointerEvent) {
    event.preventDefault();
    const handle = pickPressureHandle(event);
    if (!handle) {
        return;
    }

    activePressureHandle = handle;
    pressurePreview.setPointerCapture(event.pointerId);
    updatePressureHandleFromEvent(handle, event);
}

function onPressurePreviewPointerMove(event: PointerEvent) {
    if (!activePressureHandle) {
        return;
    }

    event.preventDefault();
    updatePressureHandleFromEvent(activePressureHandle, event);
}

function endPressurePreviewInteraction(event: PointerEvent) {
    if (!activePressureHandle) {
        return;
    }

    if (pressurePreview.hasPointerCapture(event.pointerId)) {
        pressurePreview.releasePointerCapture(event.pointerId);
    }
    activePressureHandle = null;
}

function drawPressureCurvePreview() {
    const layout = getPressurePreviewLayout();
    const { width, height, padLeft, padTop, padBottom } = layout;
    const handles = getPressureHandlePositions();

    pressurePreviewCtx.clearRect(0, 0, width, height);

    const gradient = pressurePreviewCtx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(240, 180, 92, 0.10)");
    gradient.addColorStop(1, "rgba(7, 7, 7, 1)");
    pressurePreviewCtx.fillStyle = gradient;
    pressurePreviewCtx.fillRect(0, 0, width, height);

    pressurePreviewCtx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    pressurePreviewCtx.fillStyle = "rgba(255, 255, 255, 0.5)";
    pressurePreviewCtx.textAlign = "center";
    pressurePreviewCtx.textBaseline = "middle";
    pressurePreviewCtx.fillText("PRESSURE", width / 2, height - 11);

    pressurePreviewCtx.save();
    pressurePreviewCtx.translate(14, height / 2);
    pressurePreviewCtx.rotate(-Math.PI / 2);
    pressurePreviewCtx.fillText("OUTPUT", 0, 0);
    pressurePreviewCtx.restore();

    pressurePreviewCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    pressurePreviewCtx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const x = layout.mapX(i / 4);
        const y = layout.mapY(i / 4);

        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(x, padTop);
        pressurePreviewCtx.lineTo(x, height - padBottom);
        pressurePreviewCtx.stroke();

        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(padLeft, y);
        pressurePreviewCtx.lineTo(width - layout.padRight, y);
        pressurePreviewCtx.stroke();
    }

    pressurePreviewCtx.setLineDash([5, 5]);
    pressurePreviewCtx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    pressurePreviewCtx.beginPath();
    pressurePreviewCtx.moveTo(layout.mapX(0), layout.mapY(0));
    pressurePreviewCtx.lineTo(layout.mapX(1), layout.mapY(1));
    pressurePreviewCtx.stroke();
    pressurePreviewCtx.setLineDash([]);

    pressurePreviewCtx.strokeStyle = "#f0b45c";
    pressurePreviewCtx.lineWidth = 2.5;
    pressurePreviewCtx.beginPath();
    for (let i = 0; i <= PRESSURE_CURVE_LUT_SIZE; i++) {
        const x = i / PRESSURE_CURVE_LUT_SIZE;
        const y = pressureCurveLut[i];
        if (i === 0) {
            pressurePreviewCtx.moveTo(layout.mapX(x), layout.mapY(y));
        } else {
            pressurePreviewCtx.lineTo(layout.mapX(x), layout.mapY(y));
        }
    }
    pressurePreviewCtx.stroke();

    if (livePressureIndicator.visible) {
        const liveX = layout.mapX(livePressureIndicator.raw);
        const liveY = layout.mapY(livePressureIndicator.mapped);

        pressurePreviewCtx.setLineDash([4, 4]);
        pressurePreviewCtx.strokeStyle = "rgba(111, 227, 255, 0.34)";
        pressurePreviewCtx.lineWidth = 1;
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(liveX, padTop);
        pressurePreviewCtx.lineTo(liveX, height - padBottom);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.moveTo(padLeft, liveY);
        pressurePreviewCtx.lineTo(width - layout.padRight, liveY);
        pressurePreviewCtx.stroke();
        pressurePreviewCtx.setLineDash([]);

        pressurePreviewCtx.fillStyle = "rgba(111, 227, 255, 0.2)";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(liveX, liveY, 9, 0, Math.PI * 2);
        pressurePreviewCtx.fill();

        pressurePreviewCtx.fillStyle = "#6fe3ff";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(liveX, liveY, 4.5, 0, Math.PI * 2);
        pressurePreviewCtx.fill();
    }

    pressurePreviewCtx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    pressurePreviewCtx.textBaseline = "middle";
    pressurePreviewCtx.textAlign = "center";

    for (const [handle, label] of [
        ["start", "Start"],
        ["middle", "Middle"],
        ["end", "End"],
    ] as const) {
        const point = handles[handle];
        pressurePreviewCtx.fillStyle = "rgba(240, 180, 92, 0.18)";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, 9, 0, Math.PI * 2);
        pressurePreviewCtx.fill();

        pressurePreviewCtx.fillStyle = "#f0b45c";
        pressurePreviewCtx.beginPath();
        pressurePreviewCtx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        pressurePreviewCtx.fill();

        pressurePreviewCtx.fillStyle = "rgba(255, 255, 255, 0.82)";
        pressurePreviewCtx.fillText(label, point.x, point.y - 14);
    }

    pressurePreviewCtx.fillStyle = "rgba(255, 255, 255, 0.48)";
    pressurePreviewCtx.textAlign = "left";
    pressurePreviewCtx.fillText("0", padLeft - 10, layout.mapY(0));
    pressurePreviewCtx.fillText("1", padLeft - 10, layout.mapY(1));
    pressurePreviewCtx.textAlign = "center";
    pressurePreviewCtx.fillText("0", layout.mapX(0), height - 9);
    pressurePreviewCtx.fillText("1", layout.mapX(1), height - 9);
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

    let w: number, h: number;
    if (monAspect > screenAspect) {
        // Monitor is wider — fit to width
        w = availW;
        h = availW / monAspect;
    } else {
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

function traceRoundedRectPath(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
) {
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

function drawPenAreaDotGrid(radius: number) {
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

function drawPenAreaLabel(label: string, textRight: number, textBottom: number) {
    const fallbackFontSize = parseInt(ACTIVE_AREA_LABEL_FONT, 10) || 11;

    ctx.save();
    ctx.font = ACTIVE_AREA_LABEL_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";

    const metrics = ctx.measureText(label);
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fallbackFontSize);
    const descent = Math.ceil(
        metrics.actualBoundingBoxDescent || Math.max(3, Math.round(fallbackFontSize * 0.35))
    );
    const textWidth = Math.ceil(metrics.width);
    const backgroundX = Math.round(textRight - textWidth - ACTIVE_AREA_LABEL_PADDING_X);
    const backgroundY = Math.round(
        textBottom - ascent - descent - ACTIVE_AREA_LABEL_PADDING_Y
    );
    const backgroundWidth = textWidth + ACTIVE_AREA_LABEL_PADDING_X * 2;
    const backgroundHeight = ascent + descent + ACTIVE_AREA_LABEL_PADDING_Y * 2;
    const backgroundRadius = Math.min(8, backgroundHeight / 2);

    ctx.fillStyle = ACTIVE_AREA_LABEL_BACKGROUND;
    traceRoundedRectPath(
        ctx,
        backgroundX,
        backgroundY,
        backgroundWidth,
        backgroundHeight,
        backgroundRadius
    );
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
        drawPenAreaLabel(
            `${currentMonitor.name}  ${currentMonitor.width}×${currentMonitor.height}`,
            penArea.x + penArea.w - labelInsetX,
            penArea.y + penArea.h - labelInsetY
        );
    }
}

// ─── Pointer Handler ──────────────────────────────────────────────────────────

function onPointer(e: PointerEvent) {
    if (e.pointerType === "pen") {
        onPenPointer(e);
        return;
    }

    if (e.pointerType === "touch") {
        onTouchPointer(e);
    }
}

function onPenPointer(e: PointerEvent) {
    e.preventDefault();

    if (e.type === "pointerleave" || e.type === "pointercancel") {
        penIsInRange = false;
        lastPenActivityAt = 0;
    } else {
        penIsInRange = true;
        lastPenActivityAt = performance.now();
    }

    if (penIsInRange) {
        cancelActiveTouchInteractions();
    }

    const events: PointerEvent[] =
        e.type === "pointermove" && typeof e.getCoalescedEvents === "function"
            ? e.getCoalescedEvents()
            : [e];

    const lastEvent = events[events.length - 1];
    if (lastEvent) {
        updatePenPressureIndicator(lastEvent, e.type);
    }

    if (events.length === 1) {
        sendPointerPayload(buildPenPointerPayload(events[0], e.type));
        return;
    }

    sendPointerEventsPayload(events.map(ev => buildPenPointerPayload(ev, e.type)));
}

function updatePenPressureIndicator(e: PointerEvent, eventType: string) {
    const hovering = e.pressure === 0 && eventType !== "pointerdown";
    const pressure = hovering ? 0 : applyPressureCurve(e.pressure);
    const pressureIndicatorVisible =
        eventType !== "pointerleave" && eventType !== "pointercancel" && eventType !== "pointerup";
    setLivePressureIndicator(e.pressure, pressure, pressureIndicatorVisible);
}

function buildPenPointerPayload(e: PointerEvent, eventType: string): JsonPointerEvent {
    const normX = (e.clientX - penArea.x) / penArea.w;
    const normY = (e.clientY - penArea.y) / penArea.h;
    const x = clampNumber(normX, 0, 1);
    const y = clampNumber(normY, 0, 1);

    const hovering = e.pressure === 0 && eventType !== "pointerdown";
    const pressure = hovering ? 0 : applyPressureCurve(e.pressure);

    let btn = 0;
    const rawBtn = e.button;
    if (rawBtn === 0) btn = 1;
    else if (rawBtn === 2) btn = 2;
    else if (rawBtn === 5) btn = 32;

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
        buttons: e.buttons,
        hovering,
    };
}

function sendPointerEventsPayload(pointerEvents: JsonPointerEvent[]) {
    if (!ws || ws.readyState !== WebSocket.OPEN || pointerEvents.length === 0) {
        return;
    }

    const msg: { PointerEvents: JsonPointerEvent[] } = {
        PointerEvents: pointerEvents,
    };

    ws.send(JSON.stringify(msg));
}

function onTouchPointer(e: PointerEvent) {
    e.preventDefault();

    if (!touchInputSettings.enabled || isPenBlockingTouch()) {
        return;
    }

    onTrackpadPointer(e);
}

function pointInPenArea(clientX: number, clientY: number) {
    return (
        clientX >= penArea.x &&
        clientX <= penArea.x + penArea.w &&
        clientY >= penArea.y &&
        clientY <= penArea.y + penArea.h
    );
}

function isPenBlockingTouch() {
    return (
        penIsInRange ||
        (lastPenActivityAt > 0 && performance.now() - lastPenActivityAt < PEN_TOUCH_BLOCK_TIMEOUT_MS)
    );
}

function releasePointerCaptureIfHeld(pointerId: number) {
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

function setTrackpadZoomGestureActive(active: boolean, timeStamp: number) {
    if (trackpadZoomGestureActive === active) {
        return;
    }

    trackpadZoomGestureActive = active;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const msg: { ZoomState: ZoomStatePayload } = {
        ZoomState: {
            active,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function clearTrackpadPrimaryTap() {
    lastPrimaryTapAt = 0;
    lastPrimaryTapPosition = null;
}

function rememberTrackpadPrimaryTap(clientX: number, clientY: number, timeStamp: number) {
    lastPrimaryTapAt = timeStamp;
    lastPrimaryTapPosition = { x: clientX, y: clientY };
}

function isTrackpadDoubleTapDragCandidate(clientX: number, clientY: number, timeStamp: number) {
    if (touchInputSettings.dragMode !== "double-tap" || !lastPrimaryTapPosition) {
        return false;
    }

    return (
        timeStamp - lastPrimaryTapAt <= TRACKPAD_DOUBLE_TAP_MAX_DELAY_MS &&
        Math.hypot(clientX - lastPrimaryTapPosition.x, clientY - lastPrimaryTapPosition.y) <=
        TRACKPAD_DOUBLE_TAP_MAX_DISTANCE
    );
}

function clampVectorMagnitude(x: number, y: number, maxMagnitude: number): ScreenPoint {
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

function getTrackpadCentroid(): ScreenPoint {
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

function takeWholeUnits(value: number) {
    return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function getTrackpadTouchTravel(point: TrackpadTouchPoint) {
    return Math.hypot(point.x - point.startX, point.y - point.startY);
}

function applyTrackpadAcceleration(deltaX: number, deltaY: number, dt: number) {
    const distance = Math.hypot(deltaX, deltaY);
    const velocity = distance / Math.max(dt, 1);
    const normalizedVelocity = clampNumber(
        velocity / TRACKPAD_ACCELERATION_TARGET_VELOCITY,
        0,
        1
    );
    const gain =
        TRACKPAD_CURSOR_BASE_GAIN +
        (TRACKPAD_CURSOR_MAX_GAIN - TRACKPAD_CURSOR_BASE_GAIN) * normalizedVelocity * normalizedVelocity;

    return {
        x: deltaX * gain,
        y: deltaY * gain,
    };
}

function sendRelativeMouseMove(dx: number, dy: number, timeStamp: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    if (dx === 0 && dy === 0) {
        return;
    }

    const msg: { RelativeMouseMove: RelativeMouseMovePayload } = {
        RelativeMouseMove: {
            dx,
            dy,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function sendWheelEvent(dx: number, dy: number, timeStamp: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    if (dx === 0 && dy === 0) {
        return;
    }

    const msg: { WheelEvent: WheelPayload } = {
        WheelEvent: {
            dx,
            dy,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function sendZoomEvent(delta: number, timeStamp: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN || delta === 0) {
        return;
    }

    const msg: { ZoomEvent: ZoomPayload } = {
        ZoomEvent: {
            delta,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function sendMouseClick(button: number, timeStamp: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const msg: { MouseClick: MouseClickPayload } = {
        MouseClick: {
            button,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function sendMouseButton(button: number, pressed: boolean, timeStamp: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const msg: { MouseButton: MouseButtonPayload } = {
        MouseButton: {
            button,
            pressed,
            timestamp: Math.round(timeStamp * 1000),
        },
    };

    ws.send(JSON.stringify(msg));
}

function sendTrackpadMove(deltaX: number, deltaY: number, dt: number, timeStamp: number) {
    if (!currentMonitor || penArea.w <= 0 || penArea.h <= 0) {
        return;
    }

    const acceleratedDelta = applyTrackpadAcceleration(deltaX, deltaY, dt);
    const cursorScale =
        (currentMonitor.width / penArea.w + currentMonitor.height / penArea.h) / 2;

    trackpadMoveRemainder.x += acceleratedDelta.x * cursorScale;
    trackpadMoveRemainder.y += acceleratedDelta.y * cursorScale;

    const dx = takeWholeUnits(trackpadMoveRemainder.x);
    const dy = takeWholeUnits(trackpadMoveRemainder.y);

    trackpadMoveRemainder.x -= dx;
    trackpadMoveRemainder.y -= dy;

    sendRelativeMouseMove(dx, dy, timeStamp);
}

function sendTrackpadScroll(deltaX: number, deltaY: number, timeStamp: number) {
    trackpadWheelRemainder.x += deltaX * TRACKPAD_SCROLL_UNITS_PER_PIXEL;
    trackpadWheelRemainder.y += deltaY * TRACKPAD_SCROLL_UNITS_PER_PIXEL;

    const dx = takeWholeUnits(trackpadWheelRemainder.x);
    const dy = takeWholeUnits(trackpadWheelRemainder.y);

    trackpadWheelRemainder.x -= dx;
    trackpadWheelRemainder.y -= dy;

    sendWheelEvent(dx, dy, timeStamp);
}

function sendTrackpadZoom(deltaDistance: number, timeStamp: number) {
    if (!touchInputSettings.zoomEnabled || !trackpadZoomGestureActive) {
        return;
    }

    trackpadZoomRemainder += deltaDistance * TRACKPAD_ZOOM_UNITS_PER_PIXEL;
    const delta = takeWholeUnits(trackpadZoomRemainder);
    trackpadZoomRemainder -= delta;
    sendZoomEvent(delta, timeStamp);
}

function startTrackpadMomentum() {
    stopTrackpadMomentum();
    const now = performance.now();
    if (
        trackpadLastScrollSampleAt === 0 ||
        now - trackpadLastScrollSampleAt > TRACKPAD_MOMENTUM_MAX_SAMPLE_AGE_MS
    ) {
        return;
    }

    trackpadMomentumVelocity = clampVectorMagnitude(
        trackpadScrollVelocity.x * TRACKPAD_MOMENTUM_BOOST,
        trackpadScrollVelocity.y * TRACKPAD_MOMENTUM_BOOST,
        TRACKPAD_MOMENTUM_MAX_SPEED
    );
    if (Math.hypot(trackpadMomentumVelocity.x, trackpadMomentumVelocity.y) < TRACKPAD_MOMENTUM_MIN_SPEED) {
        return;
    }

    trackpadMomentumTimestamp = now;
    const step = (now: number) => {
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

function updateTrackpadTapEligibility(point: TrackpadTouchPoint) {
    const travel = getTrackpadTouchTravel(point);
    if (travel > TRACKPAD_TAP_MAX_TRAVEL) {
        trackpadPrimaryTapEligible = false;
        trackpadSecondaryTapEligible = false;
    }
    if (travel > TRACKPAD_MOVE_START_TRAVEL && touchInputSettings.dragMode === "hold") {
        clearTrackpadHoldTimer();
    }
}

function beginTrackpadGesture(timeStamp: number) {
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

function armTrackpadHold(pointerId: number) {
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

function releasePrimaryTrackpadButton(timeStamp: number) {
    if (!trackpadPrimaryButtonDown) {
        return;
    }

    sendMouseButton(1, false, timeStamp);
    trackpadPrimaryButtonDown = false;
    trackpadDraggingPointerId = null;
}

function onTrackpadPointer(e: PointerEvent) {
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
            } else {
                armTrackpadHold(e.pointerId);
            }
        } else {
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
            } else {
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
            const shouldStartZoom =
                touchInputSettings.zoomEnabled &&
                !trackpadZoomGestureActive &&
                totalZoomTravel >= TRACKPAD_ZOOM_START_DISTANCE;
            if (
                trackpadGestureMode === "scroll" ||
                shouldStartScroll ||
                shouldStartZoom
            ) {
                trackpadGestureMode = "scroll";
                trackpadSecondaryTapEligible = false;
                const deltaX = nextCentroid.x - previousCentroid.x;
                const deltaY = nextCentroid.y - previousCentroid.y;
                sendTrackpadScroll(deltaX, deltaY, e.timeStamp);

                if (shouldStartZoom) {
                    setTrackpadZoomGestureActive(true, e.timeStamp);
                    trackpadPinchOriginDistance = nextDistance;
                    trackpadZoomRemainder = 0;
                } else if (trackpadZoomGestureActive) {
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
        } else if (trackpadTouches.size === 2) {
            trackpadScrollOrigin = getTrackpadCentroid();
            trackpadPinchOriginDistance = getTrackpadDistance();
            trackpadLastScrollSampleAt = e.timeStamp;
            trackpadScrollVelocity = { x: 0, y: 0 };
        }

        if (trackpadPrimaryButtonDown && (trackpadDraggingPointerId === e.pointerId || trackpadTouches.size === 0)) {
            releasePrimaryTrackpadButton(e.timeStamp);
        }

        if (trackpadTouches.size === 0) {
            const shouldPrimaryTap =
                e.type === "pointerup" &&
                trackpadGestureMaxTouches === 1 &&
                trackpadPrimaryTapEligible &&
                e.timeStamp - trackpadGestureStartedAt <= TRACKPAD_TAP_MAX_DURATION_MS;
            const shouldSecondaryTap =
                e.type === "pointerup" &&
                trackpadGestureMaxTouches === 2 &&
                trackpadSecondaryTapEligible &&
                e.timeStamp - trackpadSecondaryTouchStartedAt <= TRACKPAD_TWO_FINGER_TAP_MAX_DURATION_MS;
            const shouldMomentum =
                e.type === "pointerup" &&
                trackpadGestureMode === "scroll" &&
                Math.hypot(trackpadScrollVelocity.x, trackpadScrollVelocity.y) >= TRACKPAD_MOMENTUM_MIN_SPEED;

            if (shouldPrimaryTap) {
                sendMouseClick(1, e.timeStamp);
                rememberTrackpadPrimaryTap(e.clientX, e.clientY, e.timeStamp);
            } else if (shouldSecondaryTap) {
                sendMouseClick(2, e.timeStamp);
                clearTrackpadPrimaryTap();
            } else if (shouldMomentum) {
                startTrackpadMomentum();
                clearTrackpadPrimaryTap();
            } else {
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

function sendPointerPayload(pointerEvent: JsonPointerEvent) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const msg: { PointerEvent: JsonPointerEvent } = {
        PointerEvent: pointerEvent,
    };

    ws.send(JSON.stringify(msg));
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    let url = `${proto}//${loc.host}/ws`;

    const params = new URLSearchParams(loc.search);
    const code = params.get("access_code");
    if (code) url += `?access_code=${encodeURIComponent(code)}`;

    setStatus("Connecting...", false);

    ws = new WebSocket(url);

    ws.onopen = () => {
        setStatus("Connected", true);
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        ws!.send(JSON.stringify("RequestMonitorList"));
    };

    ws.onmessage = (ev) => {
        const data = ev.data;
        if (typeof data === "string") {
            try {
                handleMessage(JSON.parse(data));
            } catch {
                console.warn("Failed to parse server message");
            }
        } else if (data instanceof Blob) {
            data.text().then(text => {
                try {
                    handleMessage(JSON.parse(text));
                } catch {
                    console.warn("Failed to parse server message (blob)");
                }
            });
        }
    };

    ws.onclose = () => {
        setStatus("Disconnected", false);
        scheduleReconnect();
    };

    ws.onerror = () => {
        setStatus("Error", false);
        ws?.close();
    };
}

function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 2000);
}

function handleMessage(msg: MessageOutbound) {
    if (typeof msg === "string") {
        return;
    }
    if ("MonitorList" in msg) {
        populateMonitors(msg.MonitorList);
    }
    if ("Error" in msg) {
        console.error("Server error:", msg.Error);
    }
}

// ─── Monitor Selection ────────────────────────────────────────────────────────

function populateMonitors(monitors: MonitorInfo[]) {
    monitorList = monitors;
    monitorSelect.innerHTML = "";
    for (const m of monitors) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.width}×${m.height})${m.is_primary ? " ★" : ""}`;
        monitorSelect.appendChild(opt);
    }

    // Auto-select primary or first, and notify server
    const primary = monitors.find(m => m.is_primary);
    const selected = primary ?? monitors[0] ?? null;
    if (selected) {
        monitorSelect.value = selected.id;
        setCurrentMonitor(selected);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ SelectMonitor: selected.id }));
        }
    }
}

function setCurrentMonitor(m: MonitorInfo) {
    currentMonitor = m;
    recalcPenArea();
    drawPenArea();
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function setupUI() {
    settingsPanel = document.getElementById("settings") as HTMLDivElement;
    const btnOpen = document.getElementById("btn-open-settings")!;
    const btnClose = document.getElementById("btn-close-settings")!;
    const btnFullscreen = document.getElementById("btn-fullscreen")!;
    const btnInterpolateMiddle = document.getElementById("btn-interpolate-middle")!;
    const btnResetPressure = document.getElementById("btn-reset-pressure")!;
    btnTrackpadMode = document.getElementById("btn-trackpad-mode") as HTMLButtonElement;
    btnTrackpadZoom = document.getElementById("btn-trackpad-zoom") as HTMLButtonElement;
    btnTrackpadDragDoubleTap = document.getElementById("btn-trackpad-drag-double-tap") as HTMLButtonElement;
    btnTrackpadDragHold = document.getElementById("btn-trackpad-drag-hold") as HTMLButtonElement;
    trackpadDragModeControl = document.getElementById("trackpad-drag-mode") as HTMLDivElement;
    trackpadHoldDelayGroup = document.getElementById("trackpad-hold-delay-group") as HTMLDivElement;
    trackpadHoldDelayInput = document.getElementById("trackpad-hold-delay") as HTMLInputElement;
    trackpadHoldDelayValue = document.getElementById("trackpad-hold-delay-value") as HTMLSpanElement;

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
        } else {
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

    btnTrackpadMode.addEventListener("click", () => {
        setTouchInputSettings(
            {
                enabled: !touchInputSettings.enabled,
                zoomEnabled: touchInputSettings.zoomEnabled,
                dragMode: touchInputSettings.dragMode,
                longPressDelayMs: touchInputSettings.longPressDelayMs,
            },
            true
        );
    });

    btnTrackpadZoom.addEventListener("click", () => {
        setTouchInputSettings(
            {
                ...touchInputSettings,
                zoomEnabled: !touchInputSettings.zoomEnabled,
            },
            true
        );
    });

    btnTrackpadDragDoubleTap.addEventListener("click", () => {
        setTouchInputSettings(
            {
                ...touchInputSettings,
                dragMode: "double-tap",
            },
            true
        );
    });

    btnTrackpadDragHold.addEventListener("click", () => {
        setTouchInputSettings(
            {
                ...touchInputSettings,
                dragMode: "hold",
            },
            true
        );
    });

    trackpadHoldDelayInput.addEventListener("input", () => {
        setTouchInputSettings(
            {
                ...touchInputSettings,
                longPressDelayMs: Number(trackpadHoldDelayInput.value),
            },
            true
        );
    });

    monitorSelect.addEventListener("change", () => {
        const id = monitorSelect.value;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ SelectMonitor: id }));
        }
        // Update pen area from cached monitor list
        const mon = monitorList.find(m => m.id === id);
        if (mon) {
            setCurrentMonitor(mon);
        }
    });

    syncPressureCurveEditor();
    syncTouchInputControls();

    // Initial draw
    drawPenArea();
}

function setStatus(text: string, connected: boolean) {
    statusDot.classList.remove("connected", "connecting", "offline");
    const normalizedText = text.trim().toLowerCase();
    if (connected) {
        statusDot.classList.add("connected");
    } else if (normalizedText.startsWith("connecting")) {
        statusDot.classList.add("connecting");
    } else {
        statusDot.classList.add("offline");
    }
    statusDot.title = text;
}
