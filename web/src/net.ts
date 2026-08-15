import { MonitorInfo, ServerMessage } from "./protocol.js";

// Connection lifecycle: connect → open → (pen traffic) → close → backoff →
// reconnect. A "replaced" message (another device took over) parks the
// transport until the user explicitly resumes.

export type ConnState = "connecting" | "online" | "offline" | "replaced";

export interface TransportEvents {
    onState(state: ConnState, attempt: number): void;
    onMonitors(monitors: MonitorInfo[], selectedIds: string[], isWelcome: boolean): void;
    onLatency(rttMs: number): void;
    onVersion(version: string): void;
}

const PING_INTERVAL_MS = 2000;
// Force a reconnect when nothing (not even a pong) arrived for this long.
const STALE_TIMEOUT_MS = 8000;
// Abort sockets stuck in CONNECTING: an iPad waking before Wi-Fi is back up
// can leave one hanging for tens of seconds, and nudge() can't help until
// the browser gives up on its own.
const CONNECT_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 300;
const BACKOFF_MAX_MS = 4000;
// If this much is stuck in the socket buffer, the link is congested —
// hover packets get dropped first.
export const BACKPRESSURE_LIMIT = 128 * 1024;

export class Transport {
    private ws: WebSocket | null = null;
    private state: ConnState = "offline";
    private attempt = 0;
    private reconnectTimer: number | null = null;
    private pingTimer: number | null = null;
    private lastActivity = 0;
    private parked = false;

    constructor(private events: TransportEvents) {}

    connect(): void {
        this.parked = false;
        this.clearReconnect();
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.open();
    }

    get isOnline(): boolean {
        return this.state === "online";
    }

    /** Sends a binary pen frame. Returns false when offline. */
    sendPen(frame: ArrayBuffer): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(frame);
        return true;
    }

    get bufferedAmount(): number {
        return this.ws?.bufferedAmount ?? 0;
    }

    sendControl(msg: object): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    selectMonitors(ids: string[]): void {
        this.sendControl({ type: "selectMonitors", monitorIds: ids });
    }

    /** Called on visibilitychange → visible: reconnect immediately if needed. */
    nudge(): void {
        if (this.parked) return;
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.attempt = 0;
            this.connect();
        }
    }

    private open(): void {
        this.attempt++;
        this.setState("connecting");

        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const code = new URLSearchParams(window.location.search).get("code");
        const url = `${proto}://${window.location.host}/ws${code ? `?code=${encodeURIComponent(code)}` : ""}`;

        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        // close() on a CONNECTING socket aborts the attempt and fires
        // onclose, so the normal backoff path takes over.
        const connectTimer = window.setTimeout(() => {
            if (ws.readyState === WebSocket.CONNECTING) ws.close();
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
            window.clearTimeout(connectTimer);
            this.attempt = 0;
            this.lastActivity = performance.now();
            this.setState("online");
            this.startPing();
        };

        ws.onmessage = (e: MessageEvent) => {
            this.lastActivity = performance.now();
            if (typeof e.data !== "string") return;
            let msg: ServerMessage;
            try {
                msg = JSON.parse(e.data) as ServerMessage;
            } catch {
                return;
            }
            switch (msg.type) {
                case "welcome":
                case "monitors":
                    if (msg.type === "welcome" && msg.version) this.events.onVersion(msg.version);
                    this.events.onMonitors(msg.monitors ?? [], msg.monitorIds ?? [], msg.type === "welcome");
                    break;
                case "pong":
                    this.events.onLatency(performance.now() - msg.t);
                    break;
                case "replaced":
                    this.parked = true;
                    break;
            }
        };

        ws.onclose = () => {
            window.clearTimeout(connectTimer);
            if (this.ws !== ws) return;
            this.ws = null;
            this.stopPing();
            if (this.parked) {
                this.setState("replaced");
            } else {
                this.setState("offline");
                this.scheduleReconnect();
            }
        };

        ws.onerror = () => ws.close();
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = window.setInterval(() => {
            if (performance.now() - this.lastActivity > STALE_TIMEOUT_MS) {
                // Dead link that TCP hasn't noticed yet (iPad slept, AP roamed).
                this.ws?.close();
                return;
            }
            this.sendControl({ type: "ping", t: performance.now() });
        }, PING_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingTimer !== null) {
            window.clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnect();
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 5), BACKOFF_MAX_MS);
        this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    }

    private clearReconnect(): void {
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private setState(state: ConnState): void {
        this.state = state;
        this.events.onState(state, this.attempt);
    }
}
