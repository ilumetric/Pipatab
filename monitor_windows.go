package main

import (
	"fmt"
	"log"
	"sort"
	"syscall"
	"unsafe"
)

var (
	user32                = syscall.NewLazyDLL("user32.dll")
	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
	procSetProcessDPIAware  = user32.NewProc("SetProcessDPIAware")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
)

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
	monitorInfoFPrimary = 0x00000001
)

type MonitorGeometry struct {
	Left    int32  // Screen X of top-left corner (absolute screen coords)
	Top     int32  // Screen Y of top-left corner (absolute screen coords)
	Width   uint32 // Monitor width in pixels
	Height  uint32 // Monitor height in pixels
	OffsetX int32  // Monitor X relative to virtual screen origin (for InjectSyntheticPointerInput)
	OffsetY int32  // Monitor Y relative to virtual screen origin
}

type rect struct {
	Left, Top, Right, Bottom int32
}

type monitorInfoExW struct {
	CbSize    uint32
	RcMonitor rect
	RcWork    rect
	DwFlags   uint32
	SzDevice  [32]uint16
}

type rawMonitor struct {
	Name      string
	Rect      rect
	IsPrimary bool
}

func InitDPIAwareness() {
	procSetProcessDPIAware.Call()
}

func GetVirtualScreen() (x, y, w, h int32) {
	r, _, _ := procGetSystemMetrics.Call(uintptr(smXVirtualScreen))
	x = int32(r)
	r, _, _ = procGetSystemMetrics.Call(uintptr(smYVirtualScreen))
	y = int32(r)
	r, _, _ = procGetSystemMetrics.Call(uintptr(smCXVirtualScreen))
	w = int32(r)
	r, _, _ = procGetSystemMetrics.Call(uintptr(smCYVirtualScreen))
	h = int32(r)
	return
}

func EnumerateMonitors() []struct {
	Info MonitorInfo
	Geom MonitorGeometry
} {
	var raw []rawMonitor

	callback := syscall.NewCallback(func(hMonitor uintptr, hdcMonitor uintptr, lprcMonitor uintptr, dwData uintptr) uintptr {
		var mi monitorInfoExW
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		r, _, _ := procGetMonitorInfoW.Call(hMonitor, uintptr(unsafe.Pointer(&mi)))
		if r != 0 {
			name := syscall.UTF16ToString(mi.SzDevice[:])
			isPrimary := (mi.DwFlags & monitorInfoFPrimary) != 0
			raw = append(raw, rawMonitor{
				Name:      name,
				Rect:      mi.RcMonitor,
				IsPrimary: isPrimary,
			})
		}
		return 1 // TRUE — continue enumeration
	})

	procEnumDisplayMonitors.Call(0, 0, callback, 0)

	// Virtual screen origin — InjectSyntheticPointerInput uses coordinates
	// relative to the top-left of the virtual screen (union of all monitors).
	virtualLeft := int32(0)
	virtualTop := int32(0)
	if len(raw) > 0 {
		virtualLeft = raw[0].Rect.Left
		virtualTop = raw[0].Rect.Top
		for _, m := range raw[1:] {
			if m.Rect.Left < virtualLeft {
				virtualLeft = m.Rect.Left
			}
			if m.Rect.Top < virtualTop {
				virtualTop = m.Rect.Top
			}
		}
	}

	// Sort: primary first, then by position
	sort.SliceStable(raw, func(i, j int) bool {
		a, b := raw[i], raw[j]
		if a.IsPrimary != b.IsPrimary {
			return a.IsPrimary
		}
		if a.Rect.Left != b.Rect.Left {
			return a.Rect.Left < b.Rect.Left
		}
		if a.Rect.Top != b.Rect.Top {
			return a.Rect.Top < b.Rect.Top
		}
		return a.Name < b.Name
	})

	type monitorResult struct {
		Info MonitorInfo
		Geom MonitorGeometry
	}

	results := make([]monitorResult, 0, len(raw))
	for idx, m := range raw {
		w := uint32(m.Rect.Right - m.Rect.Left)
		h := uint32(m.Rect.Bottom - m.Rect.Top)
		friendlyName := friendlyMonitorName(m.Name, idx)

		log.Printf("Monitor %d: %s (%s) %dx%d at (%d,%d) primary=%v",
			idx, friendlyName, m.Name, w, h, m.Rect.Left, m.Rect.Top, m.IsPrimary)

		results = append(results, monitorResult{
			Info: MonitorInfo{
				ID:        m.Name,
				Name:      friendlyName,
				Width:     w,
				Height:    h,
				IsPrimary: m.IsPrimary,
			},
			Geom: MonitorGeometry{
				Left:    m.Rect.Left,
				Top:     m.Rect.Top,
				Width:   w,
				Height:  h,
				OffsetX: m.Rect.Left - virtualLeft,
				OffsetY: m.Rect.Top - virtualTop,
			},
		})
	}

	// Convert to the expected return type
	type result = struct {
		Info MonitorInfo
		Geom MonitorGeometry
	}
	out := make([]result, len(results))
	for i, r := range results {
		out[i] = result{Info: r.Info, Geom: r.Geom}
	}
	return out
}

func friendlyMonitorName(deviceName string, fallbackIndex int) string {
	// Try parsing \\.\DISPLAYn
	var n int
	if _, err := fmt.Sscanf(deviceName, `\\.\DISPLAY%d`, &n); err == nil {
		return fmt.Sprintf("Display %d", n)
	}
	return fmt.Sprintf("Display %d", fallbackIndex+1)
}

func selectMonitorByIndex(monitors []struct {
	Info MonitorInfo
	Geom MonitorGeometry
}, index int) MonitorGeometry {
	if index >= 0 && index < len(monitors) {
		return monitors[index].Geom
	}
	if len(monitors) > 0 {
		log.Printf("Monitor index %d not found, falling back to first monitor", index)
		return monitors[0].Geom
	}
	log.Println("No monitors found, using default 1920x1080")
	return MonitorGeometry{Left: 0, Top: 0, Width: 1920, Height: 1080, OffsetX: 0, OffsetY: 0}
}

func selectMonitorByID(monitors []struct {
	Info MonitorInfo
	Geom MonitorGeometry
}, id string) MonitorGeometry {
	for _, m := range monitors {
		if m.Info.ID == id {
			return m.Geom
		}
	}
	log.Printf("Monitor id %s not found, falling back to first monitor", id)
	return selectMonitorByIndex(monitors, 0)
}
