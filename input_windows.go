package main

import (
	"fmt"
	"log"
	"math"
	"unsafe"
)

// Win32 constants for synthetic pointer / pen injection
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

	mouseeventfMove      = 0x0001
	mouseeventfLeftDown  = 0x0002
	mouseeventfLeftUp    = 0x0004
	mouseeventfRightDown = 0x0008
	mouseeventfRightUp   = 0x0010
	mouseeventfWheel     = 0x0800
	mouseeventfHWheel    = 0x01000

	keyeventfKeyUp = 0x0002

	vkShift   = 0x10
	vkControl = 0x11
	vkMenu    = 0x12 // Alt

	// sizeof(INPUT) on amd64 Windows = 40 bytes
	inputSize     = 40
	inputMouse    = 0
	inputKeyboard = 1
)

var (
	procCreateSyntheticPointerDevice  = user32.NewProc("CreateSyntheticPointerDevice")
	procDestroySyntheticPointerDevice = user32.NewProc("DestroySyntheticPointerDevice")
	procInjectSyntheticPointerInput   = user32.NewProc("InjectSyntheticPointerInput")
	procSendInput                     = user32.NewProc("SendInput")
)

// Win32 structures for pointer injection — layout must match Windows ABI on amd64.
// Go struct alignment rules match MSVC on amd64 for these types.

type winPoint struct {
	X, Y int32
}

type pointerInfo struct {
	PointerType           uint32   // offset 0
	PointerID             uint32   // offset 4
	FrameID               uint32   // offset 8
	PointerFlags          uint32   // offset 12
	SourceDevice          uintptr  // offset 16
	HwndTarget            uintptr  // offset 24
	PtPixelLocation       winPoint // offset 32
	PtHimetricLocation    winPoint // offset 40
	PtPixelLocationRaw    winPoint // offset 48
	PtHimetricLocationRaw winPoint // offset 56
	DwTime                uint32   // offset 64
	HistoryCount          uint32   // offset 68
	InputData             uint32   // offset 72
	DwKeyStates           uint32   // offset 76
	PerformanceCount      uint64   // offset 80
	ButtonChangeType      int32    // offset 88
	// Go pads to 96 bytes (alignment of largest field = 8)
}

type pointerPenInfo struct {
	PointerInfo pointerInfo // 96 bytes
	PenFlags    uint32
	PenMask     uint32
	Pressure    uint32
	Rotation    uint32
	TiltX       int32
	TiltY       int32
	// Total: 120 bytes
}

// pointerTypeInfo matches POINTER_TYPE_INFO. The 'type' field is followed by
// implicit padding (4 bytes) to align the pen info union to 8 bytes.
type pointerTypeInfo struct {
	Type    uint32         // offset 0
	_       uint32         // offset 4 (padding)
	PenInfo pointerPenInfo // offset 8
	// Total: 128 bytes
}

type modifierSource int

const (
	modSourceZoomGesture modifierSource = iota
	modSourcePencilSqueeze
)

// PenInjector manages Windows synthetic pen input.
type PenInjector struct {
	deviceHandle          uintptr
	geometry              MonitorGeometry
	penInContact          bool
	lastX, lastY          int32
	zoomModifierActive    bool
	squeezeModifierActive *ModifierKey // nil = none
}

func NewPenInjector(geom MonitorGeometry) (*PenInjector, error) {
	handle, _, callErr := procCreateSyntheticPointerDevice.Call(ptPen, 1, 1)
	if handle == 0 {
		return nil, fmt.Errorf("CreateSyntheticPointerDevice failed: %v", callErr)
	}
	return &PenInjector{
		deviceHandle: handle,
		geometry:     geom,
	}, nil
}

func (p *PenInjector) Close() {
	p.ForcePenUp()
	p.releaseAllModifiers()
	procDestroySyntheticPointerDevice.Call(p.deviceHandle)
}

func (p *PenInjector) SetGeometry(geom MonitorGeometry) {
	p.ForcePenUp()
	p.geometry = geom
}

func clampF(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
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

func (p *PenInjector) Inject(event *PointerEvent) {
	ex := clampF(event.X, 0, 1)
	ey := clampF(event.Y, 0, 1)

	maxX := float64(p.geometry.Width) - 1
	if maxX < 0 {
		maxX = 0
	}
	maxY := float64(p.geometry.Height) - 1
	if maxY < 0 {
		maxY = 0
	}

	// Map [0,1] → virtual-screen-relative pixel coordinates.
	// InjectSyntheticPointerInput expects coords relative to the top-left of the
	// virtual screen (bounding box of all monitors), NOT absolute screen coords.
	x := int32(math.Round(ex*maxX)) + p.geometry.OffsetX
	y := int32(math.Round(ey*maxY)) + p.geometry.OffsetY

	// Hard-clamp to this monitor's bounds in virtual-screen-relative space.
	x = clampI32(x, p.geometry.OffsetX, p.geometry.OffsetX+int32(p.geometry.Width)-1)
	y = clampI32(y, p.geometry.OffsetY, p.geometry.OffsetY+int32(p.geometry.Height)-1)

	hovering := event.Hovering ||
		(event.Pressure <= 0 && event.EventType != PointerDown)
	barrelActive := (event.Btn&ButtonSecondary) != 0 || (event.Buttons&ButtonSecondary) != 0
	eraserActive := (event.Btn&ButtonEraser) != 0 || (event.Buttons&ButtonEraser) != 0
	tipContactActive := (event.Btn&(ButtonPrimary|ButtonEraser)) != 0 ||
		(event.Buttons&(ButtonPrimary|ButtonEraser)) != 0

	var inContact bool
	switch event.EventType {
	case PointerDown:
		inContact = true
	case PointerMove:
		inContact = tipContactActive || !hovering
	case PointerEnter:
		inContact = false
	case PointerUp, PointerLeave:
		inContact = false
	case PointerCancel:
		inContact = tipContactActive || !hovering
	}

	var pointerFlags uint32
	switch event.EventType {
	case PointerDown:
		pointerFlags = pointerFlagInRange | pointerFlagInContact | pointerFlagDown
	case PointerMove:
		if inContact {
			pointerFlags = pointerFlagInRange | pointerFlagInContact | pointerFlagUpdate
		} else {
			pointerFlags = pointerFlagInRange | pointerFlagUpdate
		}
	case PointerEnter:
		pointerFlags = pointerFlagInRange | pointerFlagUpdate
	case PointerUp:
		pointerFlags = pointerFlagInRange | pointerFlagUp
	case PointerCancel:
		if inContact {
			pointerFlags = pointerFlagUp | pointerFlagCanceled
		} else {
			pointerFlags = pointerFlagUpdate | pointerFlagCanceled
		}
	case PointerLeave:
		pointerFlags = pointerFlagUpdate
	}

	if inContact {
		if barrelActive {
			pointerFlags |= pointerFlagSecondButton
		} else {
			pointerFlags |= pointerFlagFirstButton
		}
	}

	if event.IsPrimary {
		pointerFlags |= pointerFlagPrimary
	}

	var penFlags uint32
	if barrelActive {
		penFlags |= penFlagBarrel
	}
	if eraserActive {
		penFlags |= penFlagEraser
	}

	penMask := uint32(penMaskRotation | penMaskTiltX | penMaskTiltY)
	var pressure uint32
	if inContact && event.Pressure > 0 {
		penMask |= penMaskPressure
		pressure = uint32(math.Round(clampF(event.Pressure, 0, 1) * 1024))
	}
	rotation := uint32(((event.Twist % 360) + 360) % 360)
	tiltX := clampI32(event.TiltX, -90, 90)
	tiltY := clampI32(event.TiltY, -90, 90)

	// State machine recovery
	isDownEvent := (pointerFlags & pointerFlagDown) != 0
	isUpEvent := (pointerFlags & pointerFlagUp) != 0
	wantsContact := (pointerFlags & pointerFlagInContact) != 0

	// Win32 requires the UP-frame ptPixelLocation to match the previous UPDATE
	// frame's position exactly. iPad pointerup events sometimes arrive at a
	// fractionally-different coordinate than the last pointermove (sub-pixel
	// rounding), and a mismatch makes Win32 return ERROR_INVALID_PARAMETER and
	// cancel the active contact — which then cascades through every subsequent
	// INCONTACT|UPDATE frame. Reuse the last known-good position for UP.
	if isUpEvent && p.penInContact {
		x = p.lastX
		y = p.lastY
	}

	if p.penInContact && (isDownEvent || (!wantsContact && !isUpEvent)) {
		// Implicit-UP fired by state recovery must also use the previous
		// UPDATE position (lastX/lastY), not the incoming event's position.
		p.injectPenUp(p.lastX, p.lastY)
	}

	if !isDownEvent && !isUpEvent && wantsContact && !p.penInContact {
		pointerFlags = (pointerFlags & ^uint32(pointerFlagUpdate)) | pointerFlagDown
		isDownEvent = true
	}

	if isUpEvent && !p.penInContact {
		return
	}

	pt := winPoint{x, y}
	var pti pointerTypeInfo
	pti.Type = ptPen
	pti.PenInfo = pointerPenInfo{
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
	}

	r, _, lastErr := procInjectSyntheticPointerInput.Call(
		p.deviceHandle,
		uintptr(unsafe.Pointer(&pti)),
		1,
	)
	if r == 0 {
		log.Printf("InjectSyntheticPointerInput failed: %v (event=%v, flags=0x%08X, pos=(%d,%d), bounds=[%d..%d, %d..%d], inContact=%v)",
			lastErr, event.EventType, pointerFlags, x, y,
			p.geometry.OffsetX, p.geometry.OffsetX+int32(p.geometry.Width)-1,
			p.geometry.OffsetY, p.geometry.OffsetY+int32(p.geometry.Height)-1,
			p.penInContact)
		// Win32 may have cancelled the active contact (it does so on UP-coord
		// mismatch, and apparently on other validation failures too). Drop our
		// belief that the pen is still down so the next INCONTACT event hits
		// the orphan-UPDATE→DOWN recovery path above and re-establishes contact.
		p.penInContact = false
		return
	}

	// Track the last position Win32 actually accepted, so subsequent UP frames
	// can reuse it byte-for-byte.
	p.lastX = x
	p.lastY = y

	if isDownEvent {
		p.penInContact = true
	} else if isUpEvent {
		p.penInContact = false
	}
}

func (p *PenInjector) ForcePenUp() {
	if p.penInContact {
		p.injectPenUp(p.lastX, p.lastY)
	}
}

func (p *PenInjector) injectPenUp(x, y int32) {
	// Clamp to monitor bounds (virtual-screen-relative)
	x = clampI32(x, p.geometry.OffsetX, p.geometry.OffsetX+int32(p.geometry.Width)-1)
	y = clampI32(y, p.geometry.OffsetY, p.geometry.OffsetY+int32(p.geometry.Height)-1)
	pt := winPoint{x, y}
	var pti pointerTypeInfo
	pti.Type = ptPen
	pti.PenInfo = pointerPenInfo{
		PointerInfo: pointerInfo{
			PointerType:        ptPen,
			PointerFlags:       pointerFlagInRange | pointerFlagUp | pointerFlagPrimary,
			PtPixelLocation:    pt,
			PtPixelLocationRaw: pt,
			HistoryCount:       1,
		},
		PenMask: penMaskRotation | penMaskTiltX | penMaskTiltY,
	}

	procInjectSyntheticPointerInput.Call(
		p.deviceHandle,
		uintptr(unsafe.Pointer(&pti)),
		1,
	)
	p.penInContact = false
}

func (p *PenInjector) MoveMouseRelative(event *RelativeMouseMoveEvent) {
	if event.DX == 0 && event.DY == 0 {
		return
	}
	p.sendMouseInput(event.DX, event.DY, 0, mouseeventfMove)
}

func (p *PenInjector) ScrollWheel(event *WheelEvent) {
	if event.DY != 0 {
		p.sendMouseInput(0, 0, uint32(event.DY), mouseeventfWheel)
	}
	if event.DX != 0 {
		p.sendMouseInput(0, 0, uint32(event.DX), mouseeventfHWheel)
	}
}

func (p *PenInjector) Zoom(event *ZoomEvent) {
	if event.Delta == 0 {
		return
	}
	p.sendMouseInput(0, 0, uint32(event.Delta), mouseeventfWheel)
}

func (p *PenInjector) SetZoomModifier(event *ZoomStateEvent) {
	var next *ModifierKey
	if event.Active {
		mk := ModifierControl
		next = &mk
	}
	p.setModifierSource(modSourceZoomGesture, next)
}

func (p *PenInjector) SetModifier(event *ModifierStateEvent) {
	var next *ModifierKey
	if event.Active {
		mk := event.Modifier
		next = &mk
	}
	p.setModifierSource(modSourcePencilSqueeze, next)
}

func (p *PenInjector) ClickMouseButton(event *MouseClickEvent) {
	btn := Button(event.Button)
	switch {
	case btn&ButtonPrimary != 0:
		p.sendMouseInput(0, 0, 0, mouseeventfLeftDown)
		p.sendMouseInput(0, 0, 0, mouseeventfLeftUp)
	case btn&ButtonSecondary != 0:
		p.sendMouseInput(0, 0, 0, mouseeventfRightDown)
		p.sendMouseInput(0, 0, 0, mouseeventfRightUp)
	}
}

func (p *PenInjector) SetMouseButton(event *MouseButtonEvent) {
	btn := Button(event.Button)
	var flags uint32
	switch {
	case btn&ButtonPrimary != 0:
		if event.Pressed {
			flags = mouseeventfLeftDown
		} else {
			flags = mouseeventfLeftUp
		}
	case btn&ButtonSecondary != 0:
		if event.Pressed {
			flags = mouseeventfRightDown
		} else {
			flags = mouseeventfRightUp
		}
	default:
		return
	}
	p.sendMouseInput(0, 0, 0, flags)
}

// sendMouseInput sends a Win32 INPUT struct for mouse events using raw bytes
// to guarantee correct amd64 layout (sizeof=40).
func (p *PenInjector) sendMouseInput(dx, dy int32, mouseData uint32, flags uint32) {
	var buf [inputSize]byte
	// buf[0:4]  = type  (INPUT_MOUSE = 0, already zero)
	// buf[4:8]  = padding (zero)
	// buf[8:12] = mi.dx
	*(*int32)(unsafe.Pointer(&buf[8])) = dx
	// buf[12:16] = mi.dy
	*(*int32)(unsafe.Pointer(&buf[12])) = dy
	// buf[16:20] = mi.mouseData
	*(*uint32)(unsafe.Pointer(&buf[16])) = mouseData
	// buf[20:24] = mi.dwFlags
	*(*uint32)(unsafe.Pointer(&buf[20])) = flags
	// buf[24:40] = time, padding, dwExtraInfo (zero)

	r, _, _ := procSendInput.Call(1, uintptr(unsafe.Pointer(&buf[0])), inputSize)
	if r == 0 {
		log.Printf("SendInput mouse failed (flags=0x%08X, dx=%d, dy=%d)", flags, dx, dy)
	}
}

// sendKeyboardInput sends a Win32 INPUT struct for keyboard events.
func (p *PenInjector) sendKeyboardInput(vk uint16, flags uint32) bool {
	var buf [inputSize]byte
	// buf[0:4] = type
	*(*uint32)(unsafe.Pointer(&buf[0])) = inputKeyboard
	// buf[4:8] = padding
	// buf[8:10] = ki.wVk
	*(*uint16)(unsafe.Pointer(&buf[8])) = vk
	// buf[10:12] = ki.wScan (zero)
	// buf[12:16] = ki.dwFlags
	*(*uint32)(unsafe.Pointer(&buf[12])) = flags
	// buf[16:40] = time, padding, dwExtraInfo, tail padding (zero)

	r, _, _ := procSendInput.Call(1, uintptr(unsafe.Pointer(&buf[0])), inputSize)
	if r == 0 {
		log.Printf("SendInput keyboard failed (vk=%d, flags=0x%08X)", vk, flags)
		return false
	}
	return true
}

func (p *PenInjector) currentModifierForSource(source modifierSource) *ModifierKey {
	switch source {
	case modSourceZoomGesture:
		if p.zoomModifierActive {
			mk := ModifierControl
			return &mk
		}
		return nil
	case modSourcePencilSqueeze:
		return p.squeezeModifierActive
	}
	return nil
}

func (p *PenInjector) setModifierSource(source modifierSource, next *ModifierKey) {
	previous := p.currentModifierForSource(source)
	if modifierKeyEqual(previous, next) {
		return
	}

	if previous != nil && !p.otherSourceHasModifier(source, *previous) {
		p.sendKeyboardInput(modifierVirtualKey(*previous), keyeventfKeyUp)
	}

	if next != nil && !p.otherSourceHasModifier(source, *next) {
		p.sendKeyboardInput(modifierVirtualKey(*next), 0)
	}

	switch source {
	case modSourceZoomGesture:
		p.zoomModifierActive = next != nil
	case modSourcePencilSqueeze:
		if next != nil {
			mk := *next
			p.squeezeModifierActive = &mk
		} else {
			p.squeezeModifierActive = nil
		}
	}
}

func (p *PenInjector) otherSourceHasModifier(source modifierSource, modifier ModifierKey) bool {
	switch source {
	case modSourceZoomGesture:
		return p.squeezeModifierActive != nil && *p.squeezeModifierActive == modifier
	case modSourcePencilSqueeze:
		return p.zoomModifierActive && modifier == ModifierControl
	}
	return false
}

func (p *PenInjector) releaseAllModifiers() {
	hadZoom := p.zoomModifierActive
	hadSqueeze := p.squeezeModifierActive

	if hadZoom {
		p.sendKeyboardInput(modifierVirtualKey(ModifierControl), keyeventfKeyUp)
	}
	if hadSqueeze != nil {
		mk := *hadSqueeze
		if !(hadZoom && mk == ModifierControl) {
			p.sendKeyboardInput(modifierVirtualKey(mk), keyeventfKeyUp)
		}
	}

	p.zoomModifierActive = false
	p.squeezeModifierActive = nil
}

func modifierVirtualKey(mk ModifierKey) uint16 {
	switch mk {
	case ModifierShift:
		return vkShift
	case ModifierControl:
		return vkControl
	case ModifierAlt:
		return vkMenu
	}
	return 0
}

func modifierKeyEqual(a, b *ModifierKey) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
