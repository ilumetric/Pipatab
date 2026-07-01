import { encodePenBatch, EvType, FLAG_BARREL, FLAG_CONTACT, FLAG_ERASER, MAX_BATCH, PenSample } from "./protocol.js";
import { applyLut } from "./curve.js";
import { Transport, BACKPRESSURE_LIMIT } from "./net.js";

// Pen capture: Apple Pencil only (pointerType === "pen"). Touch is ignored on
// the pad so a resting palm never draws. Every DOM event is flushed to the
// server immediately — no frame batching, latency beats bandwidth on a LAN.

export interface ActiveArea {
    x: number;
    y: number;
    w: number;
    h: number;
}

const BUTTON_BARREL = 2; // PointerEvent.buttons bit for the barrel switch
const BUTTON_ERASER = 32;
const CONTACT_MASK = 1 | BUTTON_ERASER;

export class PenCapture {
    /** Live pressure feed for the settings UI (raw, mapped). */
    onPressure: ((raw: number, mapped: number) => void) | null = null;
    /** Fires on any pen activity — used to auto-dim the HUD. */
    onActivity: (() => void) | null = null;

    private lut: Float32Array;
    private area: ActiveArea = { x: 0, y: 0, w: 1, h: 1 };
    private hoverEnabled = true;
    private enabled = true;
    private wasInContact = false;
    private batch: PenSample[] = [];
    private lastRawUpdateAt = -Infinity;

    constructor(
        private surface: HTMLElement,
        private transport: Transport,
        lut: Float32Array
    ) {
        this.lut = lut;
        this.bind();
    }

    setLut(lut: Float32Array): void {
        this.lut = lut;
    }

    setActiveArea(area: ActiveArea): void {
        this.area = area;
    }

    setHoverEnabled(enabled: boolean): void {
        this.hoverEnabled = enabled;
    }

    /** Suspends forwarding entirely (area-edit mode drives the pen locally). */
    setEnabled(enabled: boolean): void {
        if (!enabled) this.releaseContact();
        this.enabled = enabled;
    }

    /** Releases any held contact — call before the page hides or disconnects. */
    releaseContact(): void {
        if (!this.wasInContact) return;
        this.wasInContact = false;
        this.transport.sendPen(
            encodePenBatch([
                { type: EvType.Cancel, flags: 0, x: 0.5, y: 0.5, pressure: 0, tiltX: 0, tiltY: 0, twist: 0 },
            ])
        );
    }

    private bind(): void {
        const el = this.surface;
        const opts: AddEventListenerOptions = { passive: false };

        // Block Safari's scroll/zoom/system gestures on the drawing surface.
        for (const type of ["touchstart", "touchmove", "touchend", "gesturestart", "gesturechange"]) {
            el.addEventListener(type, (e) => e.preventDefault(), opts);
        }

        el.addEventListener("pointerdown", (e) => this.onPointer(e, EvType.Down), opts);
        el.addEventListener("pointerup", (e) => this.onPointer(e, EvType.Up), opts);
        el.addEventListener("pointercancel", (e) => this.onPointer(e, EvType.Cancel), opts);
        el.addEventListener("pointerenter", (e) => this.onPointer(e, EvType.Enter), opts);
        el.addEventListener("pointerleave", (e) => this.onPointer(e, EvType.Leave), opts);

        // pointerrawupdate (when supported) delivers samples ahead of the
        // rAF-aligned pointermove — and pointermove then repeats the same
        // samples as coalesced events. Whichever stream is live owns Move
        // forwarding: pointermove is used only while no recent rawupdate has
        // been seen, so nothing is ever sent twice.
        el.addEventListener(
            "pointermove",
            (e) => {
                if (performance.now() - this.lastRawUpdateAt < 1000) return;
                this.onPointer(e, EvType.Move);
            },
            opts
        );
        if ("onpointerrawupdate" in el) {
            el.addEventListener(
                "pointerrawupdate",
                (e) => {
                    const pe = e as PointerEvent;
                    if (pe.pointerType === "pen") this.lastRawUpdateAt = performance.now();
                    this.onPointer(pe, EvType.Move);
                },
                opts
            );
        }
    }

    private onPointer(e: PointerEvent, type: EvType): void {
        if (!this.enabled) return;
        if (e.pointerType !== "pen") return;
        e.preventDefault();

        if (type === EvType.Down) {
            try {
                this.surface.setPointerCapture(e.pointerId);
            } catch {
                // Capture is best-effort; clamping handles strays.
            }
        }

        this.onActivity?.();

        const contact = (e.buttons & CONTACT_MASK) !== 0;

        // Hover forwarding disabled: swallow frames that are neither part of
        // a contact stroke nor needed to close one (a non-contact frame right
        // after contact still goes through so the server releases the pen).
        if (
            !this.hoverEnabled &&
            !contact &&
            !this.wasInContact &&
            type !== EvType.Up &&
            type !== EvType.Cancel
        ) {
            return;
        }

        this.batch.length = 0;

        // Coalesced events carry the full 240 Hz Pencil sample stream; the
        // wrapping event alone would cap us at the display refresh rate.
        const coalesced =
            type === EvType.Move && typeof e.getCoalescedEvents === "function"
                ? e.getCoalescedEvents()
                : null;

        if (coalesced && coalesced.length > 0) {
            for (const ce of coalesced) {
                if (this.batch.length >= MAX_BATCH) break;
                this.batch.push(this.sample(ce, type));
            }
        } else {
            this.batch.push(this.sample(e, type));
        }

        this.flush(type, contact);
    }

    private sample(e: PointerEvent, type: EvType): PenSample {
        const contact = (e.buttons & CONTACT_MASK) !== 0 || type === EvType.Down;

        let flags = 0;
        if (contact && type !== EvType.Up && type !== EvType.Cancel) flags |= FLAG_CONTACT;
        if (e.buttons & BUTTON_BARREL) flags |= FLAG_BARREL;
        if (e.buttons & BUTTON_ERASER || e.button === 5) flags |= FLAG_ERASER;

        const raw = e.pressure;
        const mapped = contact ? applyLut(this.lut, raw) : 0;
        if (contact || raw > 0) this.onPressure?.(raw, mapped);

        return {
            type,
            flags,
            x: (e.clientX - this.area.x) / this.area.w,
            y: (e.clientY - this.area.y) / this.area.h,
            pressure: mapped,
            tiltX: e.tiltX,
            tiltY: e.tiltY,
            twist: e.twist,
        };
    }

    private flush(type: EvType, contact: boolean): void {
        if (this.batch.length === 0) return;

        // Under backpressure (congested Wi-Fi) drop hover updates — they are
        // cosmetic. Contact samples always go through: they are the stroke.
        if (!contact && type === EvType.Move && this.transport.bufferedAmount > BACKPRESSURE_LIMIT) {
            return;
        }

        this.transport.sendPen(encodePenBatch(this.batch));

        if (type === EvType.Down) this.wasInContact = true;
        if (type === EvType.Up || type === EvType.Cancel) this.wasInContact = false;
        if (type === EvType.Move) this.wasInContact = contact;

        if ((type === EvType.Up || type === EvType.Cancel) && this.onPressure) {
            this.onPressure(0, 0);
        }
    }
}
