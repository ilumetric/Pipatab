# Pipatab

Turn an iPad Pro with Apple Pencil into a wireless graphics tablet for Windows 11.

No screen mirroring — pen input only, like a classic screenless drawing tablet
(think Wacom Intuos), but over Wi-Fi with pressure, tilt, rotation and hover.

```
┌─────────────────────┐    WebSocket (binary + JSON)   ┌──────────────────────────┐
│   iPad Safari/PWA   │ ◄────────────────────────────► │    Windows 11 Server     │
│  PointerEvent API   │  ── pen events (12 B, bin) ──► │  Synthetic Pen Device    │
│  coalesced 240 Hz   │  ◄── monitors / pong (JSON) ── │  Per-Monitor V2 DPI      │
└─────────────────────┘                                └──────────────────────────┘
```

## Features

- **Full pen fidelity** — pressure (with a custom response curve), tilt X/Y,
  rotation (twist), eraser, barrel button
- **Apple Pencil hover** (iPad Pro M2+) — the cursor moves before the pen touches
- **240 Hz sampling** — coalesced Apple Pencil events, sent immediately over a
  12-byte binary protocol; a full second of drawing is under 3 KB
- **Multi-monitor** — pick any display (or several at once) with a visual layout
  map; real monitor names, correct handling of DPI scaling and L-shaped layouts
- **Custom active area** — resize and reposition the mapped region on the iPad
- **Pressure curve editor** — monotone cubic spline with live pressure readout,
  plus Soft/Linear/Firm presets
- **Robust connection** — heartbeats both ways, exponential-backoff reconnect,
  contact never breaks mid-stroke; a reloaded Safari tab always takes over cleanly
- **Zero install on the iPad** — it's a web app; add it to the Home Screen and it
  runs fullscreen like a native app
- **Single portable .exe** — the web client is embedded in the binary; no
  installer, no drivers, no services

## Requirements

- **PC:** Windows 10 1809 or newer (uses the Windows pen injection API)
- **Tablet:** iPad with Apple Pencil (hover requires iPad Pro M2+), Safari 16+
- Both devices on the same network

## Quick start

1. Download the latest `pipatab-*-windows-amd64.zip` from
   [Releases](https://github.com/ilumetric/Pipatab/releases) and unzip it.
2. Run `pipatab.exe` on the PC (allow it through the Windows firewall for
   private networks).
3. On the iPad, open the URL the server prints (e.g. `http://192.168.1.10:1701`)
   in Safari.
4. Tap Share → **Add to Home Screen**, then launch it from there — it opens
   fullscreen without Safari bars.

All settings (monitor selection, pressure curve, hover, active area) live on the
iPad and survive reconnects and server restarts.

### Server flags

| Flag       | Default   | Description                                              |
| ---------- | --------- | -------------------------------------------------------- |
| `-port`    | `1701`    | HTTP/WebSocket port                                      |
| `-bind`    | `0.0.0.0` | Bind address                                             |
| `-code`    | —         | Access code; clients must open `http://…:1701/?code=...` |
| `-monitor` | primary   | Initial monitor device name (e.g. `\\.\DISPLAY2`)        |
| `-version` | —         | Print version and exit                                   |

## Building from source

Requires [Go](https://go.dev/) 1.26+ and [Node.js](https://nodejs.org/) (for the
TypeScript client bundle).

```
build.bat
```

This typechecks and bundles the web client with esbuild, then compiles the Go
server with the client embedded. The result is a single `pipatab.exe`.

## How it works

The Go server creates a single synthetic pen device via the Windows
`InjectSyntheticPointerInput` API on a dedicated OS thread. The iPad client
captures `PointerEvent`s (including coalesced samples at up to 240 Hz), applies
the pressure curve locally, and streams 12-byte binary events over a WebSocket
with backpressure handling — under congestion only hover packets are dropped,
never contact ones.

Design notes and the hard-earned quirks of the Win32 pen injection state machine
are documented in [SPEC.md](SPEC.md) (in Russian).

## License

[MIT](LICENSE)
