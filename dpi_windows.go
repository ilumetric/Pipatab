package main

import "syscall"

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	shcore = syscall.NewLazyDLL("shcore.dll")

	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDpiAwareness        = shcore.NewProc("SetProcessDpiAwareness")
	procSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
)

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the pseudo-handle -4.
const dpiAwarenessContextPerMonitorAwareV2 = ^uintptr(3) // (uintptr)(-4)

// InitDPIAwareness opts the process into Per-Monitor V2 DPI awareness so that
// GetMonitorInfo / GetSystemMetrics report physical pixels on every monitor,
// regardless of per-monitor scaling. Falls back to older APIs on old builds.
func InitDPIAwareness() {
	if err := procSetProcessDpiAwarenessContext.Find(); err == nil {
		if r, _, _ := procSetProcessDpiAwarenessContext.Call(dpiAwarenessContextPerMonitorAwareV2); r != 0 {
			return
		}
	}
	if err := procSetProcessDpiAwareness.Find(); err == nil {
		// PROCESS_PER_MONITOR_DPI_AWARE = 2
		if r, _, _ := procSetProcessDpiAwareness.Call(2); r == 0 {
			return
		}
	}
	procSetProcessDPIAware.Call()
}
