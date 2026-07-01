package main

import (
	"fmt"
	"sort"
	"syscall"
	"unsafe"
)

var (
	procEnumDisplayMonitors        = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW            = user32.NewProc("GetMonitorInfoW")
	procGetDisplayConfigBufferSize = user32.NewProc("GetDisplayConfigBufferSizes")
	procQueryDisplayConfig         = user32.NewProc("QueryDisplayConfig")
	procDisplayConfigGetDeviceInfo = user32.NewProc("DisplayConfigGetDeviceInfo")
)

const monitorInfoFPrimary = 0x00000001

// Monitor describes one display: identity for the client UI plus the geometry
// needed to map normalized pen coordinates into injection coordinates.
type Monitor struct {
	ID        string `json:"id"`   // GDI device name, e.g. `\\.\DISPLAY1` — stable across reconnects
	Name      string `json:"name"` // Friendly name, e.g. "DELL U2720Q"
	Width     int32  `json:"width"`
	Height    int32  `json:"height"`
	Left      int32  `json:"left"` // Virtual-screen-relative position (>= 0), for the client's layout map
	Top       int32  `json:"top"`
	IsPrimary bool   `json:"primary"`
}

// Geometry returns the injection-space rectangle of the monitor. Windows'
// InjectSyntheticPointerInput expects coordinates relative to the top-left of
// the virtual screen (the bounding box of all monitors), which is exactly how
// Left/Top are stored.
func (m Monitor) Geometry() MonitorGeometry {
	return MonitorGeometry{OffsetX: m.Left, OffsetY: m.Top, Width: m.Width, Height: m.Height}
}

type MonitorGeometry struct {
	OffsetX, OffsetY int32
	Width, Height    int32
}

type winRect struct {
	Left, Top, Right, Bottom int32
}

type monitorInfoExW struct {
	CbSize    uint32
	RcMonitor winRect
	RcWork    winRect
	DwFlags   uint32
	SzDevice  [32]uint16
}

// EnumerateMonitors lists all active displays sorted primary-first, with
// positions rebased to the virtual screen origin.
func EnumerateMonitors() []Monitor {
	type rawMonitor struct {
		device    string
		rect      winRect
		isPrimary bool
	}
	var raw []rawMonitor

	callback := syscall.NewCallback(func(hMonitor, hdc, lprc, lparam uintptr) uintptr {
		var mi monitorInfoExW
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		if r, _, _ := procGetMonitorInfoW.Call(hMonitor, uintptr(unsafe.Pointer(&mi))); r != 0 {
			raw = append(raw, rawMonitor{
				device:    syscall.UTF16ToString(mi.SzDevice[:]),
				rect:      mi.RcMonitor,
				isPrimary: (mi.DwFlags & monitorInfoFPrimary) != 0,
			})
		}
		return 1 // continue enumeration
	})
	procEnumDisplayMonitors.Call(0, 0, callback, 0)

	if len(raw) == 0 {
		return nil
	}

	virtualLeft, virtualTop := raw[0].rect.Left, raw[0].rect.Top
	for _, m := range raw[1:] {
		if m.rect.Left < virtualLeft {
			virtualLeft = m.rect.Left
		}
		if m.rect.Top < virtualTop {
			virtualTop = m.rect.Top
		}
	}

	sort.SliceStable(raw, func(i, j int) bool {
		a, b := raw[i], raw[j]
		if a.isPrimary != b.isPrimary {
			return a.isPrimary
		}
		if a.rect.Left != b.rect.Left {
			return a.rect.Left < b.rect.Left
		}
		return a.rect.Top < b.rect.Top
	})

	friendly := queryFriendlyMonitorNames()

	// Identical models produce identical friendly names; number the
	// duplicates so the picker stays unambiguous.
	nameCount := map[string]int{}
	out := make([]Monitor, 0, len(raw))
	for i, m := range raw {
		name := friendly[m.device]
		if name == "" {
			name = fallbackMonitorName(m.device, i)
		}
		nameCount[name]++
		if n := nameCount[name]; n > 1 {
			name = fmt.Sprintf("%s (%d)", name, n)
		}
		out = append(out, Monitor{
			ID:        m.device,
			Name:      name,
			Width:     m.rect.Right - m.rect.Left,
			Height:    m.rect.Bottom - m.rect.Top,
			Left:      m.rect.Left - virtualLeft,
			Top:       m.rect.Top - virtualTop,
			IsPrimary: m.isPrimary,
		})
	}
	return out
}

func fallbackMonitorName(deviceName string, fallbackIndex int) string {
	var n int
	if _, err := fmt.Sscanf(deviceName, `\\.\DISPLAY%d`, &n); err == nil {
		return fmt.Sprintf("Display %d", n)
	}
	return fmt.Sprintf("Display %d", fallbackIndex+1)
}

// --- Friendly monitor names via QueryDisplayConfig -------------------------
// Maps GDI device names (`\\.\DISPLAY1`) to the monitor's EDID friendly name
// ("DELL U2720Q"). Best-effort: returns an empty map on any failure.

type luid struct {
	LowPart  uint32
	HighPart int32
}

type displayConfigPathSourceInfo struct {
	AdapterID   luid
	ID          uint32
	ModeInfoIdx uint32
	StatusFlags uint32
}

type displayConfigPathTargetInfo struct {
	AdapterID        luid
	ID               uint32
	ModeInfoIdx      uint32
	OutputTechnology uint32
	Rotation         uint32
	Scaling          uint32
	RefreshRate      [2]uint32
	ScanLineOrdering uint32
	TargetAvailable  int32
	StatusFlags      uint32
}

type displayConfigPathInfo struct {
	SourceInfo displayConfigPathSourceInfo
	TargetInfo displayConfigPathTargetInfo
	Flags      uint32
}

type displayConfigModeInfo struct {
	InfoType  uint32
	ID        uint32
	AdapterID luid
	Union     [48]byte
}

type displayConfigDeviceInfoHeader struct {
	Type      uint32
	Size      uint32
	AdapterID luid
	ID        uint32
}

type displayConfigTargetDeviceName struct {
	Header                    displayConfigDeviceInfoHeader
	Flags                     uint32
	OutputTechnology          uint32
	EdidManufactureID         uint16
	EdidProductCodeID         uint16
	ConnectorInstance         uint32
	MonitorFriendlyDeviceName [64]uint16
	MonitorDevicePath         [128]uint16
}

type displayConfigSourceDeviceName struct {
	Header            displayConfigDeviceInfoHeader
	ViewGdiDeviceName [32]uint16
}

const (
	qdcOnlyActivePaths                    = 0x00000002
	displayConfigDeviceInfoGetSourceName  = 1
	displayConfigDeviceInfoGetTargetName  = 2
	displayConfigPathModeIdxInvalid       = 0xffffffff
	displayConfigOutputTechnologyInternal = 0x80000000
)

func queryFriendlyMonitorNames() map[string]string {
	names := map[string]string{}

	var pathCount, modeCount uint32
	r, _, _ := procGetDisplayConfigBufferSize.Call(
		qdcOnlyActivePaths,
		uintptr(unsafe.Pointer(&pathCount)),
		uintptr(unsafe.Pointer(&modeCount)),
	)
	if r != 0 || pathCount == 0 {
		return names
	}

	paths := make([]displayConfigPathInfo, pathCount)
	modes := make([]displayConfigModeInfo, max(modeCount, 1))
	r, _, _ = procQueryDisplayConfig.Call(
		qdcOnlyActivePaths,
		uintptr(unsafe.Pointer(&pathCount)),
		uintptr(unsafe.Pointer(&paths[0])),
		uintptr(unsafe.Pointer(&modeCount)),
		uintptr(unsafe.Pointer(&modes[0])),
		0,
	)
	if r != 0 {
		return names
	}

	for i := range paths[:pathCount] {
		path := &paths[i]

		var src displayConfigSourceDeviceName
		src.Header = displayConfigDeviceInfoHeader{
			Type:      displayConfigDeviceInfoGetSourceName,
			Size:      uint32(unsafe.Sizeof(src)),
			AdapterID: path.SourceInfo.AdapterID,
			ID:        path.SourceInfo.ID,
		}
		if r, _, _ := procDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&src))); r != 0 {
			continue
		}

		var tgt displayConfigTargetDeviceName
		tgt.Header = displayConfigDeviceInfoHeader{
			Type:      displayConfigDeviceInfoGetTargetName,
			Size:      uint32(unsafe.Sizeof(tgt)),
			AdapterID: path.TargetInfo.AdapterID,
			ID:        path.TargetInfo.ID,
		}
		if r, _, _ := procDisplayConfigGetDeviceInfo.Call(uintptr(unsafe.Pointer(&tgt))); r != 0 {
			continue
		}

		gdiName := syscall.UTF16ToString(src.ViewGdiDeviceName[:])
		friendly := syscall.UTF16ToString(tgt.MonitorFriendlyDeviceName[:])
		if friendly == "" && tgt.OutputTechnology == displayConfigOutputTechnologyInternal {
			friendly = "Built-in Display"
		}
		if gdiName != "" && friendly != "" {
			names[gdiName] = friendly
		}
	}
	return names
}

// SelectionGeometry resolves a set of monitor IDs into the mapping target:
// the union bounding box (what the pad area maps onto), the individual
// monitor rectangles (for dead-zone clamping in L-shaped layouts), and the
// effective ID list. Unknown IDs are dropped; an empty result falls back to
// the primary monitor.
func SelectionGeometry(monitors []Monitor, ids []string) (MonitorGeometry, []MonitorGeometry, []string) {
	var selected []Monitor
	for _, id := range ids {
		for _, m := range monitors {
			if m.ID == id {
				dup := false
				for _, s := range selected {
					if s.ID == id {
						dup = true
						break
					}
				}
				if !dup {
					selected = append(selected, m)
				}
				break
			}
		}
	}
	if len(selected) == 0 {
		if len(monitors) == 0 {
			return MonitorGeometry{Width: 1920, Height: 1080}, nil, nil
		}
		selected = monitors[:1]
	}

	minL, minT := selected[0].Left, selected[0].Top
	maxR, maxB := selected[0].Left+selected[0].Width, selected[0].Top+selected[0].Height
	rects := make([]MonitorGeometry, 0, len(selected))
	effective := make([]string, 0, len(selected))
	for _, m := range selected {
		minL = min(minL, m.Left)
		minT = min(minT, m.Top)
		maxR = max(maxR, m.Left+m.Width)
		maxB = max(maxB, m.Top+m.Height)
		rects = append(rects, m.Geometry())
		effective = append(effective, m.ID)
	}

	union := MonitorGeometry{OffsetX: minL, OffsetY: minT, Width: maxR - minL, Height: maxB - minT}
	return union, rects, effective
}
