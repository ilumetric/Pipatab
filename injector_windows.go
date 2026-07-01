package main

import (
	"fmt"
	"log"
	"syscall"
	"time"
	"unsafe"
)

// Win32 constants for synthetic pointer / pen injection.
const (
	ptPen = 0x00000003

	pointerFlagInRange      = 0x00000002
	pointerFlagInContact    = 0x00000004
	pointerFlagFirstButton  = 0x00000010
	pointerFlagSecondButton = 0x00000020
	pointerFlagPrimary      = 0x00002000
	pointerFlagDown         = 0x00010000
	pointerFlagUpdate       = 0x00020000
	pointerFlagUp           = 0x00040000
	pointerFlagCanceled     = 0x00080000

	penFlagBarrel = 0x00000001
	penFlagEraser = 0x00000080

	penMaskPressure = 0x00000001
	penMaskRotation = 0x00000002
	penMaskTiltX    = 0x00000004
	penMaskTiltY    = 0x00000008

	// Windows pen pressure is 0..1024.
	winPressureMax = 1024
)

var (
	kernel32                          = syscall.NewLazyDLL("kernel32.dll")
	procSwitchToThread                = kernel32.NewProc("SwitchToThread")
	procCreateSyntheticPointerDevice  = user32.NewProc("CreateSyntheticPointerDevice")
	procDestroySyntheticPointerDevice = user32.NewProc("DestroySyntheticPointerDevice")
	procInjectSyntheticPointerInput   = user32.NewProc("InjectSyntheticPointerInput")
)

// Win32 structures - layout must match the Windows amd64 ABI. Go's struct
// alignment rules match MSVC for these field types.

type winPoint struct {
	X, Y int32
}

type pointerInfo struct {
	PointerType           uint32
	PointerID             uint32
	FrameID               uint32
	PointerFlags          uint32
	SourceDevice          uintptr
	HwndTarget            uintptr
	PtPixelLocation       winPoint
	PtHimetricLocation    winPoint
	PtPixelLocationRaw    winPoint
	PtHimetricLocationRaw winPoint
	DwTime                uint32
	HistoryCount          uint32
	InputData             uint32
	DwKeyStates           uint32
	PerformanceCount      uint64
	ButtonChangeType      int32
	// Go pads to 96 bytes.
}

type pointerPenInfo struct {
	PointerInfo pointerInfo
	PenFlags    uint32
	PenMask     uint32
	Pressure    uint32
	Rotation    uint32
	TiltX       int32
	TiltY       int32
}

// pointerTypeInfo matches POINTER_TYPE_INFO: a 4-byte type tag padded to 8,
// followed by the pen info union member.
type pointerTypeInfo struct {
	Type    uint32
	_       uint32
	PenInfo pointerPenInfo
}

// Injector owns the single process-wide synthetic pen device. All methods
// must be called from the one OS thread the device was created on (the hub's
// injection worker guarantees this).
type Injector struct {
	device uintptr
	// geom is the mapping target: one monitor's rect, or the union bounding
	// box when several monitors are selected.
	geom MonitorGeometry
	// rects are the individual monitor rectangles inside geom. The union box
	// of an L-shaped layout contains dead zones with no display behind them;
	// injecting there is invalid, so points get clamped to the nearest rect.
	rects        []MonitorGeometry
	inContact    bool
	lastX, lastY int32

	// Hold state: the last accepted contact frame. KeepAlive re-injects it
	// while the pen rests motionless (a still Apple Pencil produces no DOM
	// events at all), and the failure path re-establishes contact with it.
	holdPenFlags uint32
	holdPressure uint32
	holdRotation uint32
	holdTiltX    int32
	holdTiltY    int32
	lastInjectAt time.Time

	lastFailLogAt time.Time
	retriedOK     uint64
}

func NewInjector(geom MonitorGeometry, rects []MonitorGeometry) (*Injector, error) {
	// POINTER_FEEDBACK_DEFAULT = 1: respect the user's pen visualization
	// settings (keeps the hover cursor dot visible, which artists rely on).
	handle, _, callErr := procCreateSyntheticPointerDevice.Call(ptPen, 1, 1)
	if handle == 0 {
		return nil, fmt.Errorf("CreateSyntheticPointerDevice failed: %v", callErr)
	}
	return &Injector{device: handle, geom: geom, rects: rects}, nil
}

func (inj *Injector) Close() {
	inj.ForcePenUp()
	procDestroySyntheticPointerDevice.Call(inj.device)
}

// SetGeometry switches the mapping target. Any active contact is released
// first so the stroke doesn't teleport across screens. A no-op when the
// geometry is unchanged (monitor list refreshes must not interrupt a stroke).
func (inj *Injector) SetGeometry(geom MonitorGeometry, rects []MonitorGeometry) {
	if geom == inj.geom && geometriesEqual(rects, inj.rects) {
		return
	}
	inj.ForcePenUp()
	inj.geom = geom
	inj.rects = rects
}

func geometriesEqual(a, b []MonitorGeometry) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func clampI32(v, lo, hi int32) int32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// mapToScreen converts normalized u16 coordinates to virtual-screen-relative
// pixels inside the mapping target, then snaps points that landed in a dead
// zone (union-box area with no display) to the nearest selected monitor.
func (inj *Injector) mapToScreen(nx, ny uint16) (int32, int32) {
	maxX := inj.geom.Width - 1
	maxY := inj.geom.Height - 1
	if maxX < 0 {
		maxX = 0
	}
	if maxY < 0 {
		maxY = 0
	}
	// +32767 rounds to nearest (divisor is 65535).
	x := inj.geom.OffsetX + int32((uint32(nx)*uint32(maxX)+32767)/65535)
	y := inj.geom.OffsetY + int32((uint32(ny)*uint32(maxY)+32767)/65535)
	x = clampI32(x, inj.geom.OffsetX, inj.geom.OffsetX+maxX)
	y = clampI32(y, inj.geom.OffsetY, inj.geom.OffsetY+maxY)

	if len(inj.rects) == 0 {
		return x, y
	}

	bestX, bestY := x, y
	bestDist := int64(-1)
	for _, r := range inj.rects {
		cx := clampI32(x, r.OffsetX, r.OffsetX+r.Width-1)
		cy := clampI32(y, r.OffsetY, r.OffsetY+r.Height-1)
		if cx == x && cy == y {
			return x, y // inside a real monitor - no snapping needed
		}
		dx := int64(cx - x)
		dy := int64(cy - y)
		d := dx*dx + dy*dy
		if bestDist < 0 || d < bestDist {
			bestDist = d
			bestX, bestY = cx, cy
		}
	}
	return bestX, bestY
}

// Inject translates one pen event into a synthetic pointer frame, maintaining
// the Win32 contact state machine.
func (inj *Injector) Inject(ev *PenEvent) {
	x, y := inj.mapToScreen(ev.X, ev.Y)

	contact := ev.Contact()

	var pointerFlags uint32
	switch ev.Type {
	case evDown:
		contact = true
		pointerFlags = pointerFlagInRange | pointerFlagInContact | pointerFlagDown
	case evMove:
		if contact {
			pointerFlags = pointerFlagInRange | pointerFlagInContact | pointerFlagUpdate
		} else {
			pointerFlags = pointerFlagInRange | pointerFlagUpdate
		}
	case evEnter:
		contact = false
		pointerFlags = pointerFlagInRange | pointerFlagUpdate
	case evUp:
		contact = false
		pointerFlags = pointerFlagInRange | pointerFlagUp
	case evLeave:
		contact = false
		pointerFlags = pointerFlagUpdate
	case evCancel:
		if contact {
			pointerFlags = pointerFlagUp | pointerFlagCanceled
		} else {
			pointerFlags = pointerFlagUpdate | pointerFlagCanceled
		}
		contact = false
	}

	if pointerFlags&pointerFlagInContact != 0 {
		if ev.Barrel() {
			pointerFlags |= pointerFlagSecondButton
		} else {
			pointerFlags |= pointerFlagFirstButton
		}
	}
	pointerFlags |= pointerFlagPrimary

	var penFlags uint32
	if ev.Barrel() {
		penFlags |= penFlagBarrel
	}
	if ev.Eraser() {
		penFlags |= penFlagEraser
	}

	penMask := uint32(penMaskRotation | penMaskTiltX | penMaskTiltY)
	var pressure uint32
	if pointerFlags&pointerFlagInContact != 0 && ev.Pressure > 0 {
		penMask |= penMaskPressure
		pressure = (uint32(ev.Pressure)*winPressureMax + 32767) / 65535
		if pressure == 0 {
			pressure = 1
		}
	}

	isDown := pointerFlags&pointerFlagDown != 0
	isUp := pointerFlags&pointerFlagUp != 0
	wantsContact := pointerFlags&pointerFlagInContact != 0

	// Win32 requires the UP frame's ptPixelLocation to exactly match the last
	// accepted UPDATE frame. iPad pointerup events often land on a fractionally
	// different coordinate than the final pointermove; a mismatch makes Win32
	// return ERROR_INVALID_PARAMETER and cancel the contact, cascading through
	// every subsequent INCONTACT frame. Reuse the last accepted position.
	if isUp && inj.inContact {
		x, y = inj.lastX, inj.lastY
	}

	// A DOWN while already in contact, or a hover frame while in contact,
	// means we missed an UP (dropped packet, reconnect). Close the old
	// contact first - at its last accepted position.
	if inj.inContact && (isDown || (!wantsContact && !isUp)) {
		inj.injectPenUp()
	}

	// An INCONTACT UPDATE without a preceding DOWN (first packets after a
	// reconnect mid-stroke): promote to DOWN so Win32 accepts it.
	if !isDown && !isUp && wantsContact && !inj.inContact {
		pointerFlags = (pointerFlags &^ pointerFlagUpdate) | pointerFlagDown
		isDown = true
	}

	// An UP without an active contact is a no-op for Win32; skip it.
	if isUp && !inj.inContact {
		return
	}

	rotation := uint32(ev.Twist % 360)
	tiltX := clampI32(int32(ev.TiltX), -90, 90)
	tiltY := clampI32(int32(ev.TiltY), -90, 90)

	pt := winPoint{x, y}
	pti := pointerTypeInfo{
		Type: ptPen,
		PenInfo: pointerPenInfo{
			PointerInfo: pointerInfo{
				PointerType:        ptPen,
				PointerFlags:       pointerFlags,
				PtPixelLocation:    pt,
				PtPixelLocationRaw: pt,
				HistoryCount:       1,
			},
			PenFlags: penFlags,
			PenMask:  penMask,
			Pressure: pressure,
			Rotation: rotation,
			TiltX:    tiltX,
			TiltY:    tiltY,
		},
	}

	if !inj.injectFrame(&pti) {
		inj.logFailure(int(ev.Type), pointerFlags, x, y)
		// Win32 cancels the active contact on a validation failure. Drop our
		// belief, then, if a stroke was in progress, re-establish contact
		// right now as a DOWN at this position instead of waiting for the
		// next sample - that keeps the visible gap to a single point.
		inj.inContact = false
		if wantsContact && !isDown {
			downFlags := uint32(pointerFlagInRange | pointerFlagInContact | pointerFlagDown | pointerFlagPrimary)
			if ev.Barrel() {
				downFlags |= pointerFlagSecondButton
			} else {
				downFlags |= pointerFlagFirstButton
			}
			pti.PenInfo.PointerInfo.PointerFlags = downFlags
			if inj.injectFrame(&pti) {
				inj.inContact = true
				inj.lastX, inj.lastY = x, y
				inj.rememberHold(penFlags, pressure, rotation, tiltX, tiltY)
			}
		}
		return
	}

	inj.lastX, inj.lastY = x, y
	if isDown {
		inj.inContact = true
	} else if isUp {
		inj.inContact = false
	}
	if inj.inContact {
		inj.rememberHold(penFlags, pressure, rotation, tiltX, tiltY)
	}
}

// injectFrame performs the syscall, retrying briefly on transient rejections.
// Back-to-back injections (coalesced pen bursts arrive 8+ per WebSocket
// frame) sporadically fail with ERROR_INVALID_PARAMETER (~0.1% of frames
// under load); yielding the thread quantum and retrying absorbs them.
// Timestamps stay system-assigned: explicit PerformanceCount values made
// Windows reject frames more often, not less.
func (inj *Injector) injectFrame(pti *pointerTypeInfo) bool {
	for attempt := 0; ; attempt++ {
		r, _, _ := procInjectSyntheticPointerInput.Call(
			inj.device, uintptr(unsafe.Pointer(pti)), 1,
		)
		if r != 0 {
			inj.lastInjectAt = time.Now()
			if attempt > 0 {
				inj.retriedOK++
				if inj.retriedOK == 1 || inj.retriedOK%1000 == 0 {
					log.Printf("inject retry absorbed a transient rejection (%d so far)", inj.retriedOK)
				}
			}
			return true
		}
		if attempt >= 2 {
			return false
		}
		procSwitchToThread.Call()
	}
}

func (inj *Injector) rememberHold(penFlags, pressure, rotation uint32, tiltX, tiltY int32) {
	inj.holdPenFlags = penFlags
	inj.holdPressure = pressure
	inj.holdRotation = rotation
	inj.holdTiltX = tiltX
	inj.holdTiltY = tiltY
}

// logFailure reports injection errors at most once per second: failures come
// in bursts (secure desktop / UAC prompt rejects everything) and log I/O in
// the injection path must never become the bottleneck.
func (inj *Injector) logFailure(evType int, flags uint32, x, y int32) {
	now := time.Now()
	if now.Sub(inj.lastFailLogAt) < time.Second {
		return
	}
	inj.lastFailLogAt = now
	log.Printf("inject failed (type=%d flags=0x%08X pos=(%d,%d) contact=%v)",
		evType, flags, x, y, inj.inContact)
}

// contactKeepAlive is how long the contact may go without frames before we
// refresh it. A motionless Apple Pencil produces no DOM events at all, and
// this guards against the synthetic contact expiring inside Windows during
// long holds (defense in depth - cheap: ~40 syscalls/s only while holding).
const contactKeepAlive = 25 * time.Millisecond

// KeepAlive re-injects the last accepted contact frame while the pen is held
// still. Runs on the injection thread via the hub's ticker.
func (inj *Injector) KeepAlive() {
	if !inj.inContact || time.Since(inj.lastInjectAt) < contactKeepAlive {
		return
	}

	flags := uint32(pointerFlagInRange | pointerFlagInContact | pointerFlagUpdate | pointerFlagPrimary)
	if inj.holdPenFlags&penFlagBarrel != 0 {
		flags |= pointerFlagSecondButton
	} else {
		flags |= pointerFlagFirstButton
	}
	penMask := uint32(penMaskRotation | penMaskTiltX | penMaskTiltY)
	if inj.holdPressure > 0 {
		penMask |= penMaskPressure
	}

	pt := winPoint{inj.lastX, inj.lastY}
	pti := pointerTypeInfo{
		Type: ptPen,
		PenInfo: pointerPenInfo{
			PointerInfo: pointerInfo{
				PointerType:        ptPen,
				PointerFlags:       flags,
				PtPixelLocation:    pt,
				PtPixelLocationRaw: pt,
				HistoryCount:       1,
			},
			PenFlags: inj.holdPenFlags,
			PenMask:  penMask,
			Pressure: inj.holdPressure,
			Rotation: inj.holdRotation,
			TiltX:    inj.holdTiltX,
			TiltY:    inj.holdTiltY,
		},
	}

	if inj.injectFrame(&pti) {
		return
	}
	inj.logFailure(-1, flags, inj.lastX, inj.lastY)

	// The hold frame was rejected twice - Windows dropped the contact. The
	// pen is still physically down (we only get here between client events),
	// so re-establish the contact with a DOWN at the same spot.
	pti.PenInfo.PointerInfo.PointerFlags =
		(flags &^ pointerFlagUpdate) | pointerFlagDown
	if !inj.injectFrame(&pti) {
		inj.inContact = false
	}
}

// ForcePenUp releases an active contact, e.g. on disconnect or monitor switch.
func (inj *Injector) ForcePenUp() {
	if inj.inContact {
		inj.injectPenUp()
	}
}

func (inj *Injector) injectPenUp() {
	pt := winPoint{inj.lastX, inj.lastY}
	pti := pointerTypeInfo{
		Type: ptPen,
		PenInfo: pointerPenInfo{
			PointerInfo: pointerInfo{
				PointerType:        ptPen,
				PointerFlags:       pointerFlagInRange | pointerFlagUp | pointerFlagPrimary,
				PtPixelLocation:    pt,
				PtPixelLocationRaw: pt,
				HistoryCount:       1,
			},
			PenMask: penMaskRotation | penMaskTiltX | penMaskTiltY,
		},
	}
	inj.injectFrame(&pti)
	inj.inContact = false
}
