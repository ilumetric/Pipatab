import { applyLut, buildLut, normalizeCurve, PressureCurve } from "./curve.js";

// Canvas-based pressure curve editor with three draggable handles:
//   start  — output floor at zero pressure
//   middle — free point shaping the curve body
//   end    — input level where output saturates
// Rendered with the panel accent style; shows a live dot while drawing.

type Handle = "start" | "middle" | "end";

const HANDLE_HIT_RADIUS = 26;
const PAD = { left: 14, right: 14, top: 14, bottom: 14 };

export class CurveEditor {
    onChange: ((curve: PressureCurve) => void) | null = null;

    private ctx: CanvasRenderingContext2D;
    private curve: PressureCurve;
    private lut: Float32Array;
    private active: Handle | null = null;
    private liveRaw = 0;
    private liveVisible = false;
    private drawQueued = false;

    constructor(private canvas: HTMLCanvasElement, initial: PressureCurve) {
        this.ctx = canvas.getContext("2d")!;
        this.curve = normalizeCurve(initial);
        this.lut = buildLut(this.curve);

        canvas.addEventListener("pointerdown", (e) => this.onDown(e));
        canvas.addEventListener("pointermove", (e) => this.onMove(e));
        canvas.addEventListener("pointerup", (e) => this.onUp(e));
        canvas.addEventListener("pointercancel", (e) => this.onUp(e));

        new ResizeObserver(() => this.resize()).observe(canvas);
        this.resize();
    }

    getCurve(): PressureCurve {
        return { ...this.curve };
    }

    setCurve(curve: PressureCurve, notify: boolean): void {
        this.curve = normalizeCurve(curve);
        this.lut = buildLut(this.curve);
        this.requestDraw();
        if (notify) this.onChange?.(this.curve);
    }

    setLivePressure(raw: number, visible: boolean): void {
        this.liveRaw = raw;
        this.liveVisible = visible && raw > 0;
        this.requestDraw();
    }

    private resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 2) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        this.canvas.width = Math.round(rect.width * dpr);
        this.canvas.height = Math.round(rect.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.requestDraw();
    }

    // --- coordinate mapping ---

    private plot() {
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        return {
            left: PAD.left,
            top: PAD.top,
            width: Math.max(1, w - PAD.left - PAD.right),
            height: Math.max(1, h - PAD.top - PAD.bottom),
        };
    }

    private toPx(x: number, y: number): [number, number] {
        const p = this.plot();
        return [p.left + x * p.width, p.top + (1 - y) * p.height];
    }

    private fromPx(px: number, py: number): [number, number] {
        const p = this.plot();
        const x = Math.min(1, Math.max(0, (px - p.left) / p.width));
        const y = Math.min(1, Math.max(0, 1 - (py - p.top) / p.height));
        return [x, y];
    }

    private handlePositions(): Record<Handle, [number, number]> {
        return {
            start: this.toPx(0, this.curve.startY),
            middle: this.toPx(this.curve.middleX, this.curve.middleY),
            end: this.toPx(this.curve.endX, 1),
        };
    }

    // --- interaction ---

    private eventPos(e: PointerEvent): [number, number] {
        const rect = this.canvas.getBoundingClientRect();
        return [e.clientX - rect.left, e.clientY - rect.top];
    }

    private onDown(e: PointerEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const [px, py] = this.eventPos(e);
        const handles = this.handlePositions();
        let best: Handle | null = null;
        let bestD = HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS;
        for (const h of ["start", "middle", "end"] as const) {
            const dx = px - handles[h][0];
            const dy = py - handles[h][1];
            const d = dx * dx + dy * dy;
            if (d <= bestD) {
                bestD = d;
                best = h;
            }
        }
        if (!best) return;
        this.active = best;
        this.canvas.setPointerCapture(e.pointerId);
        this.drag(e);
    }

    private onMove(e: PointerEvent): void {
        if (!this.active) return;
        e.preventDefault();
        e.stopPropagation();
        this.drag(e);
    }

    private onUp(e: PointerEvent): void {
        if (!this.active) return;
        this.active = null;
        if (this.canvas.hasPointerCapture(e.pointerId)) {
            this.canvas.releasePointerCapture(e.pointerId);
        }
        this.requestDraw();
    }

    private drag(e: PointerEvent): void {
        const [px, py] = this.eventPos(e);
        const [x, y] = this.fromPx(px, py);
        const next = { ...this.curve };
        if (this.active === "start") {
            next.startY = y;
        } else if (this.active === "middle") {
            next.middleX = x;
            next.middleY = y;
        } else if (this.active === "end") {
            next.endX = x;
        }
        this.setCurve(next, true);
    }

    // --- rendering ---

    private requestDraw(): void {
        if (this.drawQueued) return;
        this.drawQueued = true;
        requestAnimationFrame(() => {
            this.drawQueued = false;
            this.draw();
        });
    }

    private draw(): void {
        const { ctx } = this;
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (w < 2) return;
        const p = this.plot();

        ctx.clearRect(0, 0, w, h);

        // Plot background.
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 12);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.09)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Grid.
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        for (let i = 1; i < 4; i++) {
            const gx = p.left + (p.width * i) / 4;
            const gy = p.top + (p.height * i) / 4;
            ctx.beginPath();
            ctx.moveTo(gx, p.top);
            ctx.lineTo(gx, p.top + p.height);
            ctx.moveTo(p.left, gy);
            ctx.lineTo(p.left + p.width, gy);
            ctx.stroke();
        }

        // Diagonal reference.
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.beginPath();
        ctx.moveTo(...this.toPx(0, 0));
        ctx.lineTo(...this.toPx(1, 1));
        ctx.stroke();
        ctx.setLineDash([]);

        // Curve area fill + stroke.
        const curvePath = new Path2D();
        const areaPath = new Path2D();
        const [x0, y0] = this.toPx(0, this.lut[0]);
        curvePath.moveTo(x0, y0);
        areaPath.moveTo(...this.toPx(0, 0));
        areaPath.lineTo(x0, y0);
        const steps = 128;
        for (let i = 1; i <= steps; i++) {
            const x = i / steps;
            const [px, py] = this.toPx(x, applyLut(this.lut, x));
            curvePath.lineTo(px, py);
            areaPath.lineTo(px, py);
        }
        areaPath.lineTo(...this.toPx(1, 0));
        areaPath.closePath();

        const fill = ctx.createLinearGradient(0, p.top, 0, p.top + p.height);
        fill.addColorStop(0, "rgba(10, 132, 255, 0.28)");
        fill.addColorStop(1, "rgba(10, 132, 255, 0.02)");
        ctx.fillStyle = fill;
        ctx.fill(areaPath);

        ctx.strokeStyle = "#0a84ff";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke(curvePath);

        // Live pressure dot.
        if (this.liveVisible) {
            const [lx, ly] = this.toPx(this.liveRaw, applyLut(this.lut, this.liveRaw));
            ctx.fillStyle = "rgba(48, 209, 88, 0.25)";
            ctx.beginPath();
            ctx.arc(lx, ly, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#30d158";
            ctx.beginPath();
            ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Handles.
        const handles = this.handlePositions();
        for (const hName of ["start", "middle", "end"] as const) {
            const [hx, hy] = handles[hName];
            const isActive = this.active === hName;
            ctx.fillStyle = isActive ? "rgba(10,132,255,0.35)" : "rgba(255,255,255,0.10)";
            ctx.beginPath();
            ctx.arc(hx, hy, isActive ? 14 : 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#101013";
            ctx.beginPath();
            ctx.arc(hx, hy, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isActive ? "#eaf4ff" : "#0a84ff";
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }
}
