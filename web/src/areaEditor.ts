import { PadRenderer, MIN_AREA_PX } from "./pad.js";
import { PadArea } from "./settings.js";

// AreaEditor: interactive resize/reposition of the mapped pad area. Active
// only while edit mode is on; grabs any pointer type (finger or pencil) —
// pen forwarding to the PC is suspended by main.ts for the duration.
//
// Gestures: drag a corner handle to resize (free proportions), drag inside
// the frame to move the whole area.

const HANDLE_HIT_RADIUS = 44;
const EDGE_MARGIN = 4;

type DragMode =
    | { kind: "corner"; corner: number } // 0=tl 1=tr 2=bl 3=br
    | { kind: "move"; offsetX: number; offsetY: number };

export class AreaEditor {
    onChange: ((area: PadArea) => void) | null = null;

    private active = false;
    private drag: DragMode | null = null;
    private dragPointer = -1;

    constructor(
        private surface: HTMLCanvasElement,
        private renderer: PadRenderer
    ) {
        surface.addEventListener("pointerdown", (e) => this.onDown(e));
        surface.addEventListener("pointermove", (e) => this.onMove(e));
        surface.addEventListener("pointerup", (e) => this.onUp(e));
        surface.addEventListener("pointercancel", (e) => this.onUp(e));
    }

    setActive(active: boolean): void {
        this.active = active;
        this.drag = null;
    }

    private onDown(e: PointerEvent): void {
        if (!this.active || this.drag) return;
        e.preventDefault();

        const a = this.renderer.area;
        const handles = this.renderer.handleCenters();
        let corner = -1;
        let bestD = HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS;
        for (let i = 0; i < handles.length; i++) {
            const dx = e.clientX - handles[i][0];
            const dy = e.clientY - handles[i][1];
            const d = dx * dx + dy * dy;
            if (d <= bestD) {
                bestD = d;
                corner = i;
            }
        }

        if (corner >= 0) {
            this.drag = { kind: "corner", corner };
        } else if (
            e.clientX >= a.x && e.clientX <= a.x + a.w &&
            e.clientY >= a.y && e.clientY <= a.y + a.h
        ) {
            this.drag = { kind: "move", offsetX: e.clientX - a.x, offsetY: e.clientY - a.y };
        } else {
            return;
        }

        this.dragPointer = e.pointerId;
        try {
            this.surface.setPointerCapture(e.pointerId);
        } catch {
            // best-effort
        }
    }

    private onMove(e: PointerEvent): void {
        if (!this.active || !this.drag || e.pointerId !== this.dragPointer) return;
        e.preventDefault();

        const sw = window.innerWidth;
        const sh = window.innerHeight;
        const a = { ...this.renderer.area };
        const px = Math.min(Math.max(e.clientX, EDGE_MARGIN), sw - EDGE_MARGIN);
        const py = Math.min(Math.max(e.clientY, EDGE_MARGIN), sh - EDGE_MARGIN);

        if (this.drag.kind === "move") {
            a.x = Math.min(Math.max(e.clientX - this.drag.offsetX, EDGE_MARGIN), sw - a.w - EDGE_MARGIN);
            a.y = Math.min(Math.max(e.clientY - this.drag.offsetY, EDGE_MARGIN), sh - a.h - EDGE_MARGIN);
        } else {
            // Opposite corner stays anchored.
            const right = a.x + a.w;
            const bottom = a.y + a.h;
            switch (this.drag.corner) {
                case 0: // tl
                    a.x = Math.min(px, right - MIN_AREA_PX);
                    a.y = Math.min(py, bottom - MIN_AREA_PX);
                    a.w = right - a.x;
                    a.h = bottom - a.y;
                    break;
                case 1: // tr
                    a.y = Math.min(py, bottom - MIN_AREA_PX);
                    a.w = Math.max(px - a.x, MIN_AREA_PX);
                    a.h = bottom - a.y;
                    break;
                case 2: // bl
                    a.x = Math.min(px, right - MIN_AREA_PX);
                    a.w = right - a.x;
                    a.h = Math.max(py - a.y, MIN_AREA_PX);
                    break;
                case 3: // br
                    a.w = Math.max(px - a.x, MIN_AREA_PX);
                    a.h = Math.max(py - a.y, MIN_AREA_PX);
                    break;
            }
        }

        this.onChange?.({ x: a.x / sw, y: a.y / sh, w: a.w / sw, h: a.h / sh });
    }

    private onUp(e: PointerEvent): void {
        if (e.pointerId !== this.dragPointer) return;
        this.drag = null;
        this.dragPointer = -1;
        if (this.surface.hasPointerCapture(e.pointerId)) {
            this.surface.releasePointerCapture(e.pointerId);
        }
    }
}
