import { MonitorInfo } from "./protocol.js";
import { ActiveArea } from "./pen.js";
import { PadArea } from "./settings.js";

// PadRenderer draws the tablet surface: a black screen with the mapped area
// marked by a dot grid and border. With several monitors selected, their
// individual frames are outlined inside the area. A user-defined custom area
// (position + size + proportions) overrides the automatic aspect-fit; in
// edit mode the frame grows corner handles.

const PADDING = 18;
const CORNER_RADIUS = 16;
const GRID_SPACING = 26;
const TONE = "#3a3a3e";
const TONE_BRIGHT = "#6e6e73";
const ACCENT = "#0a84ff";
export const MIN_AREA_PX = 100;

export class PadRenderer {
    private ctx: CanvasRenderingContext2D;
    private monitors: MonitorInfo[] = [];
    private customArea: PadArea | null = null;
    private editMode = false;
    area: ActiveArea = { x: PADDING, y: PADDING, w: 100, h: 100 };

    onAreaChange: ((area: ActiveArea) => void) | null = null;

    constructor(private canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d")!;
        window.addEventListener("resize", () => this.layout());
        this.layout();
    }

    setMonitors(monitors: MonitorInfo[]): void {
        this.monitors = monitors;
        this.layout();
    }

    setCustomArea(area: PadArea | null): void {
        this.customArea = area;
        this.layout();
    }

    setEditMode(edit: boolean): void {
        this.editMode = edit;
        this.draw();
    }

    /** Bounding box of the selected monitors in virtual-screen coordinates. */
    private unionBox(): { left: number; top: number; w: number; h: number } | null {
        if (this.monitors.length === 0) return null;
        let minL = Infinity;
        let minT = Infinity;
        let maxR = -Infinity;
        let maxB = -Infinity;
        for (const m of this.monitors) {
            minL = Math.min(minL, m.left);
            minT = Math.min(minT, m.top);
            maxR = Math.max(maxR, m.left + m.width);
            maxB = Math.max(maxB, m.top + m.height);
        }
        return { left: minL, top: minT, w: maxR - minL, h: maxB - minT };
    }

    layout(): void {
        const dpr = window.devicePixelRatio || 1;
        const sw = window.innerWidth;
        const sh = window.innerHeight;
        this.canvas.width = Math.round(sw * dpr);
        this.canvas.height = Math.round(sh * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (this.customArea) {
            const c = this.customArea;
            this.area = {
                x: c.x * sw,
                y: c.y * sh,
                w: Math.max(MIN_AREA_PX, c.w * sw),
                h: Math.max(MIN_AREA_PX, c.h * sh),
            };
        } else {
            const availW = Math.max(1, sw - PADDING * 2);
            const availH = Math.max(1, sh - PADDING * 2);
            const box = this.unionBox();
            if (!box) {
                this.area = { x: PADDING, y: PADDING, w: availW, h: availH };
            } else {
                const aspect = box.w / box.h;
                let w = availW;
                let h = availW / aspect;
                if (h > availH) {
                    h = availH;
                    w = availH * aspect;
                }
                this.area = {
                    x: PADDING + (availW - w) / 2,
                    y: PADDING + (availH - h) / 2,
                    w,
                    h,
                };
            }
        }

        this.onAreaChange?.(this.area);
        this.draw();
    }

    draw(): void {
        const { ctx } = this;
        const a = this.area;

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

        const radius = Math.min(CORNER_RADIUS, a.w * 0.05, a.h * 0.05);

        // Dot grid inside the active area, centered.
        ctx.save();
        this.roundRect(a.x, a.y, a.w, a.h, radius);
        ctx.clip();
        ctx.fillStyle = TONE;
        const cx = a.x + a.w / 2;
        const cy = a.y + a.h / 2;
        const nx = Math.ceil(a.w / 2 / GRID_SPACING);
        const ny = Math.ceil(a.h / 2 / GRID_SPACING);
        for (let iy = -ny; iy <= ny; iy++) {
            for (let ix = -nx; ix <= nx; ix++) {
                ctx.fillRect(Math.round(cx + ix * GRID_SPACING), Math.round(cy + iy * GRID_SPACING), 1, 1);
            }
        }
        this.drawMonitorFrames();
        ctx.restore();

        // Area border.
        ctx.strokeStyle = this.editMode ? ACCENT : TONE;
        ctx.lineWidth = this.editMode ? 2 : 1;
        this.roundRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1, radius);
        ctx.stroke();

        if (this.monitors.length === 1) {
            const m = this.monitors[0];
            this.drawLabel(
                `${m.name}  ${m.width}×${m.height}`,
                a.x + a.w - radius - 8,
                a.y + a.h - 12
            );
        }

        if (this.editMode) this.drawHandles();
    }

    /** Outlines each selected monitor inside the mapped area (multi mode). */
    private drawMonitorFrames(): void {
        if (this.monitors.length < 2) return;
        const box = this.unionBox();
        if (!box) return;
        const { ctx } = this;
        const a = this.area;

        ctx.strokeStyle = TONE_BRIGHT;
        ctx.lineWidth = 1;
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        for (const m of this.monitors) {
            const rx = a.x + ((m.left - box.left) / box.w) * a.w;
            const ry = a.y + ((m.top - box.top) / box.h) * a.h;
            const rw = (m.width / box.w) * a.w;
            const rh = (m.height / box.h) * a.h;

            ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(rw) - 1, Math.round(rh) - 1);

            const label = m.name;
            const tw = ctx.measureText(label).width;
            if (tw + 20 < rw && rh > 40) {
                ctx.fillStyle = "#000";
                ctx.fillRect(rx + 8, ry + 8, tw + 12, 20);
                ctx.fillStyle = TONE_BRIGHT;
                ctx.fillText(label, rx + 14, ry + 12);
            }
        }
    }

    private drawLabel(label: string, textRight: number, textBottom: number): void {
        const { ctx } = this;
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "#000";
        ctx.fillRect(textRight - tw - 8, textBottom - 16, tw + 16, 22);
        ctx.fillStyle = TONE;
        ctx.fillText(label, textRight, textBottom);
    }

    /** Corner handle centers in screen pixels (tl, tr, bl, br). */
    handleCenters(): [number, number][] {
        const a = this.area;
        return [
            [a.x, a.y],
            [a.x + a.w, a.y],
            [a.x, a.y + a.h],
            [a.x + a.w, a.y + a.h],
        ];
    }

    private drawHandles(): void {
        const { ctx } = this;
        for (const [hx, hy] of this.handleCenters()) {
            ctx.fillStyle = "rgba(10, 132, 255, 0.28)";
            ctx.beginPath();
            ctx.arc(hx, hy, 22, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(hx, hy, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }
    }

    private roundRect(x: number, y: number, w: number, h: number, r: number): void {
        const { ctx } = this;
        const rad = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.arcTo(x + w, y, x + w, y + h, rad);
        ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad);
        ctx.arcTo(x, y, x + w, y, rad);
        ctx.closePath();
    }
}
