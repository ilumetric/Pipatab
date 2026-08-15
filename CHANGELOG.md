# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.1] - 2026-08-15

### Changed

- Binary renamed to `Pipatab.exe` (was `pipatab.exe`); release archive renamed
  accordingly
- The executable now has an application icon

## [2.0.0] - 2026-08-15

First public release. Complete rewrite of the original Rust prototype in Go +
TypeScript.

### Added

- Binary pen protocol: 12 bytes per event, immediate send, coalesced 240 Hz
  Apple Pencil samples
- Pressure curve editor (monotone cubic spline) with Soft/Linear/Firm presets
  and live pressure readout
- Apple Pencil hover support (iPad Pro M2+), toggleable
- Multi-monitor support with a visual layout map, real monitor names, and
  multi-display union mapping
- Custom active area with corner handles
- Access code protection (`-code` flag)
- Per-Monitor V2 DPI awareness
- Robust reconnect: heartbeats both ways, exponential backoff, stroke-safe
  contact recovery, single-active-session takeover
- Single-binary distribution: web client embedded via `go:embed`

[Unreleased]: https://github.com/ilumetric/Pipatab/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/ilumetric/Pipatab/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ilumetric/Pipatab/releases/tag/v2.0.0
