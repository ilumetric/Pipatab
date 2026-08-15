import { MonitorInfo } from "./protocol.js";
import { buildLut, CURVE_PRESETS, PressureCurve } from "./curve.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";
import { ConnState, Transport } from "./net.js";
import { PenCapture } from "./pen.js";
import { PadRenderer } from "./pad.js";
import { CurveEditor } from "./curveEditor.js";
import { AreaEditor } from "./areaEditor.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

window.addEventListener("DOMContentLoaded", () => {
    const settings: Settings = loadSettings();

    // --- DOM ---
    const pad = $<HTMLCanvasElement>("pad");
    const hud = $("hud");
    const statusDot = $("status-dot");
    const statusLatency = $("status-latency");
    const overlay = $("overlay");
    const overlayTitle = $("overlay-title");
    const overlayText = $("overlay-text");
    const overlaySpinner = $("overlay-spinner");
    const overlayAction = $<HTMLButtonElement>("btn-overlay-action");
    const monitorMap = $("monitor-map");
    const monitorList = $("monitor-list");
    const pressureRaw = $("pressure-raw");
    const pressureMapped = $("pressure-mapped");
    const areaButton = $("btn-area");

    $("overlay-host").textContent = window.location.host;
    $("conn-host").textContent = window.location.host;

    // --- State ---
    let monitors: MonitorInfo[] = [];
    let selectedIds: string[] = [];

    let saveTimer: number | null = null;
    function persistSoon(): void {
        // Debounced: area dragging changes settings at pointer rate and
        // localStorage writes are synchronous.
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => saveSettings(settings), 250);
    }

    // --- Pad + pen ---
    const renderer = new PadRenderer(pad);
    renderer.setCustomArea(settings.padArea);
    const transport = new Transport({
        onState: handleState,
        onMonitors: handleMonitors,
        onLatency: handleLatency,
        onVersion: (v) => {
            $("panel-version").textContent = `Pipatab ${v} · settings live on this iPad`;
        },
    });
    const pen = new PenCapture(pad, transport, buildLut(settings.curve));
    pen.setHoverEnabled(settings.hoverEnabled);
    renderer.onAreaChange = (area) => pen.setActiveArea(area);
    pen.setActiveArea(renderer.area);

    // --- Connection state UI ---
    function handleState(state: ConnState, attempt: number): void {
        statusDot.className = state === "online" ? "online" : state === "connecting" ? "connecting" : state;
        if (state !== "online") statusLatency.textContent = "";
        $("conn-status").textContent =
            state === "online"
                ? "Connected"
                : state === "connecting"
                  ? "Connecting…"
                  : state === "replaced"
                    ? "Another device took over"
                    : "Reconnecting…";

        if (state === "online") {
            overlay.classList.remove("visible");
            return;
        }

        overlay.classList.add("visible");
        overlayAction.classList.add("hidden");
        overlaySpinner.classList.remove("hidden");
        if (state === "replaced") {
            overlaySpinner.classList.add("hidden");
            overlayAction.classList.remove("hidden");
            overlayTitle.textContent = "Session taken over";
            overlayText.textContent = "Another device connected to this PC and is now the active tablet.";
        } else if (state === "connecting" && attempt <= 1) {
            overlayTitle.textContent = "Connecting";
            overlayText.textContent = "Looking for the Pipatab server…";
        } else {
            overlayTitle.textContent = "Reconnecting";
            overlayText.textContent = `Connection lost — retrying (attempt ${Math.max(attempt, 1)}). Check that Pipatab is running on the PC.`;
        }
    }

    overlayAction.addEventListener("click", () => transport.connect());

    function handleLatency(rtt: number): void {
        statusLatency.textContent = `${Math.max(1, Math.round(rtt))} ms`;
        $("conn-latency").textContent = `${rtt.toFixed(1)} ms`;
    }

    // --- Monitors ---
    const sameSet = (a: string[], b: string[]) =>
        a.length === b.length && a.every((id) => b.includes(id));

    function handleMonitors(list: MonitorInfo[], serverIds: string[], isWelcome: boolean): void {
        monitors = list;
        selectedIds = serverIds;

        // On every (re)connect, push the iPad's remembered selection to the
        // server — the iPad owns the settings, so a server restart must not
        // silently revert the mapping to the primary display.
        if (isWelcome) {
            const stored = settings.monitorIds.filter((id) => list.some((m) => m.id === id));
            if (stored.length > 0 && !sameSet(stored, serverIds)) {
                transport.selectMonitors(stored);
                return; // server will answer with a fresh monitors message
            }
        }

        settings.monitorIds = serverIds;
        persistSoon();

        renderer.setMonitors(list.filter((m) => selectedIds.includes(m.id)));
        renderMonitorUI();
    }

    function applySelection(ids: string[]): void {
        if (ids.length === 0 || sameSet(ids, selectedIds)) return;
        transport.selectMonitors(ids);
    }

    function renderMonitorUI(): void {
        monitorMap.textContent = "";
        monitorList.textContent = "";
        if (monitors.length === 0) return;

        let maxRight = 0;
        let maxBottom = 0;
        for (const m of monitors) {
            maxRight = Math.max(maxRight, m.left + m.width);
            maxBottom = Math.max(maxBottom, m.top + m.height);
        }
        const mapW = monitorMap.clientWidth || 340;
        const mapH = monitorMap.clientHeight || 120;
        const scale = Math.min((mapW - 16) / maxRight, (mapH - 16) / maxBottom);
        const offX = (mapW - maxRight * scale) / 2;
        const offY = (mapH - maxBottom * scale) / 2;

        monitors.forEach((m, i) => {
            const isSelected = selectedIds.includes(m.id);

            // Mini-map tile: tap = use exactly this one display.
            const tile = document.createElement("button");
            tile.className = "map-monitor" + (isSelected ? " selected" : "");
            tile.style.left = `${offX + m.left * scale}px`;
            tile.style.top = `${offY + m.top * scale}px`;
            tile.style.width = `${Math.max(24, m.width * scale)}px`;
            tile.style.height = `${Math.max(18, m.height * scale)}px`;
            tile.textContent = `${i + 1}`;
            tile.addEventListener("click", () => applySelection([m.id]));
            monitorMap.appendChild(tile);

            // List row: checkbox toggles membership in the multi-selection.
            const card = document.createElement("button");
            card.className = "monitor-card" + (isSelected ? " selected" : "");
            const check = document.createElement("span");
            check.className = "check";
            check.textContent = "✓";
            const info = document.createElement("span");
            const name = document.createElement("div");
            name.className = "m-name";
            name.textContent = m.name;
            const detail = document.createElement("div");
            detail.className = "m-detail";
            detail.textContent = `${m.width} × ${m.height}${m.primary ? "  ·  Primary" : ""}`;
            info.append(name, detail);
            card.append(check, info);
            card.addEventListener("click", () => {
                const next = isSelected
                    ? selectedIds.filter((id) => id !== m.id) // keep at least one
                    : [...selectedIds, m.id];
                if (next.length > 0) applySelection(next);
            });
            monitorList.appendChild(card);
        });
    }

    // --- Settings panel ---
    const openPanel = () => {
        exitAreaEdit();
        document.body.classList.add("panel-open");
        transport.sendControl({ type: "monitors" }); // refresh list on open
    };
    const closePanel = () => document.body.classList.remove("panel-open");
    $("btn-panel").addEventListener("click", openPanel);
    $("btn-panel-close").addEventListener("click", closePanel);
    $("panel-version").textContent = "Pipatab · settings live on this iPad";

    // Close on a finger tap outside the panel. Pen pointers are deliberately
    // ignored so test strokes (watching the pressure meters) don't dismiss it.
    document.addEventListener("pointerdown", (e) => {
        if (!document.body.classList.contains("panel-open")) return;
        if (e.pointerType === "pen") return;
        const t = e.target as HTMLElement;
        if (t.closest("#panel") || t.closest("#hud")) return;
        closePanel();
    });

    // --- Pressure curve ---
    const curveEditor = new CurveEditor($<HTMLCanvasElement>("curve-editor"), settings.curve);
    const presetButtons = Array.from(
        $("curve-presets").querySelectorAll<HTMLButtonElement>("button")
    );

    function syncPresetHighlight(curve: PressureCurve): void {
        for (const btn of presetButtons) {
            const preset = CURVE_PRESETS[btn.dataset.preset!];
            const matches =
                Math.abs(preset.startY - curve.startY) < 0.01 &&
                Math.abs(preset.middleX - curve.middleX) < 0.01 &&
                Math.abs(preset.middleY - curve.middleY) < 0.01 &&
                Math.abs(preset.endX - curve.endX) < 0.01;
            btn.classList.toggle("active", matches);
        }
    }

    curveEditor.onChange = (curve) => {
        settings.curve = curve;
        persistSoon();
        pen.setLut(buildLut(curve));
        syncPresetHighlight(curve);
    };
    syncPresetHighlight(settings.curve);

    for (const btn of presetButtons) {
        btn.addEventListener("click", () => {
            curveEditor.setCurve(CURVE_PRESETS[btn.dataset.preset!], true);
        });
    }

    pen.onPressure = (raw, mapped) => {
        if (!document.body.classList.contains("panel-open")) return;
        pressureRaw.style.width = `${raw * 100}%`;
        pressureMapped.style.width = `${mapped * 100}%`;
        curveEditor.setLivePressure(raw, true);
    };

    // --- Active area editing ---
    const areaEditor = new AreaEditor(pad, renderer);
    let areaEditActive = false;

    areaEditor.onChange = (area) => {
        settings.padArea = area;
        renderer.setCustomArea(area);
        persistSoon();
    };

    function enterAreaEdit(): void {
        if (areaEditActive) return;
        areaEditActive = true;
        closePanel();
        pen.setEnabled(false); // the pencil drags handles instead of drawing
        areaEditor.setActive(true);
        renderer.setEditMode(true);
        document.body.classList.add("area-edit");
        areaButton.classList.add("active");
    }

    function exitAreaEdit(): void {
        if (!areaEditActive) return;
        areaEditActive = false;
        areaEditor.setActive(false);
        renderer.setEditMode(false);
        pen.setEnabled(true);
        document.body.classList.remove("area-edit");
        areaButton.classList.remove("active");
        saveSettings(settings);
    }

    areaButton.addEventListener("click", () => (areaEditActive ? exitAreaEdit() : enterAreaEdit()));
    $("btn-area-done").addEventListener("click", exitAreaEdit);
    $("btn-area-reset").addEventListener("click", () => {
        settings.padArea = null;
        renderer.setCustomArea(null);
        persistSoon();
    });

    // --- Hover toggle ---
    const hoverToggle = $("toggle-hover");
    const syncHover = () => hoverToggle.setAttribute("aria-checked", String(settings.hoverEnabled));
    syncHover();
    hoverToggle.addEventListener("click", () => {
        settings.hoverEnabled = !settings.hoverEnabled;
        pen.setHoverEnabled(settings.hoverEnabled);
        persistSoon();
        syncHover();
    });

    // --- Fullscreen ---
    $("btn-fullscreen").addEventListener("click", () => {
        const el = document.documentElement as HTMLElement & {
            webkitRequestFullscreen?: () => void;
        };
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        else el.webkitRequestFullscreen?.();
    });

    // --- Wake lock ---
    const wakeStatus = $("wakelock-status");
    let wakeLock: { release(): Promise<void>; addEventListener(t: string, f: () => void): void } | null = null;

    async function acquireWakeLock(): Promise<void> {
        const wl = (navigator as Navigator & { wakeLock?: { request(type: string): Promise<never> } }).wakeLock;
        if (!wl) {
            wakeStatus.textContent = "Unavailable";
            return;
        }
        try {
            wakeLock = await wl.request("screen");
            wakeStatus.textContent = "Active";
            wakeLock.addEventListener("release", () => {
                wakeStatus.textContent = "Released";
            });
        } catch {
            wakeStatus.textContent = "Blocked";
        }
    }
    acquireWakeLock();

    // --- HUD auto-dim: fade controls while drawing ---
    let hudTimer: number | null = null;
    pen.onActivity = () => {
        if (document.body.classList.contains("panel-open")) return;
        hud.classList.add("dimmed");
        if (hudTimer !== null) window.clearTimeout(hudTimer);
        hudTimer = window.setTimeout(() => hud.classList.remove("dimmed"), 1200);
    };

    // --- Lifecycle ---
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            pen.releaseContact();
        } else {
            transport.nudge();
            acquireWakeLock();
        }
    });
    window.addEventListener("pagehide", () => pen.releaseContact());

    transport.connect();
});
