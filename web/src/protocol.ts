// Binary pen protocol — must mirror protocol.go.
//
// Frame:  [0x01][count u8][count × 12-byte events]
// Event:  type u8 | flags u8 | x u16 | y u16 | pressure u16 |
//         tiltX i8 | tiltY i8 | twist u16   (little-endian)

export const enum EvType {
    Down = 0,
    Up = 1,
    Move = 2,
    Cancel = 3,
    Enter = 4,
    Leave = 5,
}

export const FLAG_CONTACT = 1 << 0;
export const FLAG_BARREL = 1 << 1;
export const FLAG_ERASER = 1 << 2;

export interface PenSample {
    type: EvType;
    flags: number;
    x: number; // 0..1
    y: number; // 0..1
    pressure: number; // 0..1, curve already applied
    tiltX: number; // -90..90
    tiltY: number; // -90..90
    twist: number; // 0..359
}

const FRAME_PEN_BATCH = 0x01;
const EVENT_SIZE = 12;
export const MAX_BATCH = 255;

const scratch = new ArrayBuffer(2 + MAX_BATCH * EVENT_SIZE);
const scratchView = new DataView(scratch);

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Encodes samples into a transferable slice of a reusable scratch buffer. */
export function encodePenBatch(samples: PenSample[]): ArrayBuffer {
    const count = Math.min(samples.length, MAX_BATCH);
    scratchView.setUint8(0, FRAME_PEN_BATCH);
    scratchView.setUint8(1, count);

    for (let i = 0; i < count; i++) {
        const s = samples[i];
        const off = 2 + i * EVENT_SIZE;
        scratchView.setUint8(off, s.type);
        scratchView.setUint8(off + 1, s.flags);
        scratchView.setUint16(off + 2, Math.round(clamp(s.x, 0, 1) * 65535), true);
        scratchView.setUint16(off + 4, Math.round(clamp(s.y, 0, 1) * 65535), true);
        scratchView.setUint16(off + 6, Math.round(clamp(s.pressure, 0, 1) * 65535), true);
        scratchView.setInt8(off + 8, Math.round(clamp(s.tiltX, -90, 90)));
        scratchView.setInt8(off + 9, Math.round(clamp(s.tiltY, -90, 90)));
        scratchView.setUint16(off + 10, ((Math.round(s.twist) % 360) + 360) % 360, true);
    }

    return scratch.slice(0, 2 + count * EVENT_SIZE);
}

// --- Control messages (JSON) ------------------------------------------------

export interface MonitorInfo {
    id: string;
    name: string;
    width: number;
    height: number;
    left: number;
    top: number;
    primary: boolean;
}

export type ServerMessage =
    | { type: "welcome"; version: string; monitors: MonitorInfo[]; monitorIds: string[] }
    | { type: "monitors"; monitors: MonitorInfo[]; monitorIds: string[] }
    | { type: "pong"; t: number }
    | { type: "replaced" };
