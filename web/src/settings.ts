import { normalizeCurve, PressureCurve, LINEAR_CURVE } from "./curve.js";

/** Custom pad mapping area, as fractions of the viewport (0..1). */
export interface PadArea {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Settings {
    monitorIds: string[];
    curve: PressureCurve;
    hoverEnabled: boolean;
    padArea: PadArea | null;
}

const KEY = "pipatab.settings.v3";
const LEGACY_KEY = "pipatab.settings.v2";

function normalizePadArea(a: unknown): PadArea | null {
    if (!a || typeof a !== "object") return null;
    const r = a as Record<string, unknown>;
    if (
        typeof r.x !== "number" || typeof r.y !== "number" ||
        typeof r.w !== "number" || typeof r.h !== "number"
    ) {
        return null;
    }
    const w = Math.min(Math.max(r.w, 0.05), 1);
    const h = Math.min(Math.max(r.h, 0.05), 1);
    return {
        x: Math.min(Math.max(r.x, 0), 1 - w),
        y: Math.min(Math.max(r.y, 0), 1 - h),
        w,
        h,
    };
}

export function loadSettings(): Settings {
    const defaults: Settings = {
        monitorIds: [],
        curve: { ...LINEAR_CURVE },
        hoverEnabled: true,
        padArea: null,
    };
    try {
        const raw = window.localStorage.getItem(KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<Settings>;
            return {
                monitorIds: Array.isArray(parsed.monitorIds)
                    ? parsed.monitorIds.filter((id): id is string => typeof id === "string")
                    : [],
                curve: normalizeCurve(parsed.curve),
                hoverEnabled: parsed.hoverEnabled !== false,
                padArea: normalizePadArea(parsed.padArea),
            };
        }
        // One-time migration from the single-monitor settings format.
        const legacy = window.localStorage.getItem(LEGACY_KEY);
        if (legacy) {
            const parsed = JSON.parse(legacy) as { monitorId?: string; curve?: PressureCurve; hoverEnabled?: boolean };
            return {
                monitorIds: typeof parsed.monitorId === "string" ? [parsed.monitorId] : [],
                curve: normalizeCurve(parsed.curve),
                hoverEnabled: parsed.hoverEnabled !== false,
                padArea: null,
            };
        }
        return defaults;
    } catch {
        return defaults;
    }
}

export function saveSettings(s: Settings): void {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        // Private browsing / storage quota — settings just won't persist.
    }
}
