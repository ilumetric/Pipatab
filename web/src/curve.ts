// Pressure curve: a monotone cubic (Fritsch–Carlson) through three draggable
// control points, sampled into a LUT for O(1) lookup per pen sample.

export interface PressureCurve {
    startY: number; // output at zero pressure (dead-zone lift)
    middleX: number;
    middleY: number;
    endX: number; // input at which output saturates to 1
}

export const LINEAR_CURVE: PressureCurve = { startY: 0, middleX: 0.5, middleY: 0.5, endX: 1 };

export const CURVE_PRESETS: Record<string, PressureCurve> = {
    soft: { startY: 0, middleX: 0.35, middleY: 0.55, endX: 0.9 },
    linear: LINEAR_CURVE,
    firm: { startY: 0, middleX: 0.65, middleY: 0.42, endX: 1 },
};

const LUT_SIZE = 256;
const POINT_GAP = 0.08;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

export function normalizeCurve(c: Partial<PressureCurve> | null | undefined): PressureCurve {
    const startY = clamp(typeof c?.startY === "number" ? c.startY : 0, 0, 0.72);
    const endXRaw = typeof c?.endX === "number" ? c.endX : 1;
    const middleXRaw = typeof c?.middleX === "number" ? c.middleX : 0.5;
    const middleYRaw = typeof c?.middleY === "number" ? c.middleY : 0.5;

    const middleXMax = clamp(endXRaw - POINT_GAP, POINT_GAP, 1 - POINT_GAP);
    const middleX = clamp(middleXRaw, POINT_GAP, middleXMax);
    const endX = clamp(endXRaw, middleX + POINT_GAP, 1);
    const middleY = clamp(middleYRaw, startY + 0.04, 0.96);
    return { startY, middleX, middleY, endX };
}

interface Pt {
    x: number;
    y: number;
}

function curvePoints(c: PressureCurve): Pt[] {
    const pts: Pt[] = [
        { x: 0, y: c.startY },
        { x: c.middleX, y: c.middleY },
    ];
    if (c.endX < 0.999) pts.push({ x: c.endX, y: 1 });
    pts.push({ x: 1, y: 1 });
    return pts;
}

function monotoneTangents(pts: Pt[]): number[] {
    const n = pts.length;
    const tangents = new Array<number>(n).fill(0);
    const secants = new Array<number>(n - 1);
    for (let i = 0; i < n - 1; i++) {
        secants[i] = (pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x);
    }
    tangents[0] = secants[0];
    tangents[n - 1] = secants[n - 2];
    for (let i = 1; i < n - 1; i++) tangents[i] = (secants[i - 1] + secants[i]) / 2;

    for (let i = 0; i < n - 1; i++) {
        if (Math.abs(secants[i]) < 1e-6) {
            tangents[i] = 0;
            tangents[i + 1] = 0;
            continue;
        }
        const a = tangents[i] / secants[i];
        const b = tangents[i + 1] / secants[i];
        const m = a * a + b * b;
        if (m > 9) {
            const s = 3 / Math.sqrt(m);
            tangents[i] = s * a * secants[i];
            tangents[i + 1] = s * b * secants[i];
        }
    }
    return tangents;
}

function sampleCurve(pts: Pt[], tangents: number[], x: number): number {
    const cx = clamp(x, 0, 1);
    if (cx <= pts[0].x) return pts[0].y;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (cx > p1.x) continue;
        const span = p1.x - p0.x;
        const t = span <= 0 ? 0 : (cx - p0.x) / span;
        const t2 = t * t;
        const t3 = t2 * t;
        return clamp(
            (2 * t3 - 3 * t2 + 1) * p0.y +
                (t3 - 2 * t2 + t) * span * tangents[i] +
                (-2 * t3 + 3 * t2) * p1.y +
                (t3 - t2) * span * tangents[i + 1],
            0,
            1
        );
    }
    return pts[pts.length - 1].y;
}

export function buildLut(c: PressureCurve): Float32Array {
    const pts = curvePoints(c);
    const tangents = monotoneTangents(pts);
    const lut = new Float32Array(LUT_SIZE + 1);
    for (let i = 0; i <= LUT_SIZE; i++) {
        lut[i] = sampleCurve(pts, tangents, i / LUT_SIZE);
    }
    return lut;
}

export function applyLut(lut: Float32Array, pressure: number): number {
    if (pressure <= 0) return 0;
    if (pressure >= 1) return 1;
    const scaled = pressure * LUT_SIZE;
    const left = Math.floor(scaled);
    const frac = scaled - left;
    return lut[left] + (lut[left + 1] - lut[left]) * frac;
}
