package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
)

// --- Inbound (client → server) ---

// MessageInbound is a tagged-union JSON message from the client.
// Rust serde produces e.g. {"PointerEvent":{...}} or "RequestMonitorList".
type MessageInbound struct {
	Tag  string
	Body json.RawMessage
}

func (m *MessageInbound) UnmarshalJSON(data []byte) error {
	// Try simple string first: "RequestMonitorList", "Ping"
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		m.Tag = s
		m.Body = nil
		return nil
	}
	// Otherwise it is an object with one key
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return fmt.Errorf("invalid inbound message: %s", string(data))
	}
	for k, v := range obj {
		m.Tag = k
		m.Body = v
		return nil
	}
	return fmt.Errorf("empty inbound message object")
}

// --- Outbound (server → client) ---

type MonitorInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Width     uint32 `json:"width"`
	Height    uint32 `json:"height"`
	IsPrimary bool   `json:"is_primary"`
}

func marshalOutbound(tag string, payload any) ([]byte, error) {
	if payload == nil {
		return json.Marshal(tag)
	}
	return json.Marshal(map[string]any{tag: payload})
}

func outboundError(msg string) ([]byte, error) {
	return marshalOutbound("Error", msg)
}

// --- Pointer events ---

type PointerEventType int

const (
	PointerDown PointerEventType = iota
	PointerUp
	PointerCancel
	PointerMove
	PointerEnter
	PointerLeave
)

type Button uint8

const (
	ButtonNone      Button = 0x00
	ButtonPrimary   Button = 0x01
	ButtonSecondary Button = 0x02
	ButtonEraser    Button = 0x20
)

type PointerEvent struct {
	EventType PointerEventType
	PointerID int64
	Timestamp uint64
	IsPrimary bool
	X         float64
	Y         float64
	Pressure  float64
	TiltX     int32
	TiltY     int32
	Twist     int32
	Btn       Button
	Buttons   Button
	Hovering  bool
}

func (e *PointerEvent) UnmarshalJSON(data []byte) error {
	var raw struct {
		EventType string  `json:"event_type"`
		PointerID int64   `json:"pointer_id"`
		Timestamp uint64  `json:"timestamp"`
		IsPrimary bool    `json:"is_primary"`
		X         float64 `json:"x"`
		Y         float64 `json:"y"`
		Pressure  float64 `json:"pressure"`
		TiltX     int32   `json:"tilt_x"`
		TiltY     int32   `json:"tilt_y"`
		Twist     int32   `json:"twist"`
		Button    uint8   `json:"button"`
		Buttons   uint8   `json:"buttons"`
		Hovering  bool    `json:"hovering"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	switch raw.EventType {
	case "pointerdown":
		e.EventType = PointerDown
	case "pointerup":
		e.EventType = PointerUp
	case "pointercancel":
		e.EventType = PointerCancel
	case "pointermove":
		e.EventType = PointerMove
	case "pointerenter":
		e.EventType = PointerEnter
	case "pointerleave":
		e.EventType = PointerLeave
	default:
		return fmt.Errorf("unknown event_type: %s", raw.EventType)
	}
	e.PointerID = raw.PointerID
	e.Timestamp = raw.Timestamp
	e.IsPrimary = raw.IsPrimary
	e.X = raw.X
	e.Y = raw.Y
	e.Pressure = raw.Pressure
	e.TiltX = raw.TiltX
	e.TiltY = raw.TiltY
	e.Twist = raw.Twist
	e.Btn = Button(raw.Button)
	e.Buttons = Button(raw.Buttons)
	e.Hovering = raw.Hovering
	return nil
}

type RelativeMouseMoveEvent struct {
	DX        int32  `json:"dx"`
	DY        int32  `json:"dy"`
	Timestamp uint64 `json:"timestamp"`
}

type WheelEvent struct {
	DX        int32  `json:"dx"`
	DY        int32  `json:"dy"`
	Timestamp uint64 `json:"timestamp"`
}

type ZoomEvent struct {
	Delta     int32  `json:"delta"`
	Timestamp uint64 `json:"timestamp"`
}

type ZoomStateEvent struct {
	Active    bool   `json:"active"`
	Timestamp uint64 `json:"timestamp"`
}

type ModifierKey string

const (
	ModifierShift   ModifierKey = "shift"
	ModifierControl ModifierKey = "control"
	ModifierAlt     ModifierKey = "alt"
)

type ModifierStateEvent struct {
	Modifier  ModifierKey `json:"modifier"`
	Active    bool        `json:"active"`
	Timestamp uint64      `json:"timestamp"`
}

type MouseClickEvent struct {
	Button    uint8  `json:"button"`
	Timestamp uint64 `json:"timestamp"`
}

type MouseButtonEvent struct {
	Button    uint8  `json:"button"`
	Pressed   bool   `json:"pressed"`
	Timestamp uint64 `json:"timestamp"`
}

// --- Binary pointer event protocol ---

const (
	BinaryMsgPointerEvent  byte = 0x01
	BinaryMsgPointerEvents byte = 0x02
	BinaryEventSize             = 18
)

func parseBinaryPointerEvent(data []byte) (*PointerEvent, bool) {
	if len(data) < BinaryEventSize {
		return nil, false
	}

	var eventType PointerEventType
	switch data[0] {
	case 0:
		eventType = PointerDown
	case 1:
		eventType = PointerUp
	case 2:
		eventType = PointerCancel
	case 3:
		eventType = PointerMove
	case 4:
		eventType = PointerEnter
	case 5:
		eventType = PointerLeave
	default:
		return nil, false
	}

	flags := data[1]
	isPrimary := (flags & 1) != 0
	hovering := (flags & 2) != 0
	btn := Button(data[2])
	buttons := Button(data[3])
	x := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[4:8])))
	y := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[8:12])))
	pressureRaw := binary.LittleEndian.Uint16(data[12:14])
	pressure := float64(pressureRaw) / 1024.0
	tiltX := int32(int8(data[14]))
	tiltY := int32(int8(data[15]))
	twist := int32(binary.LittleEndian.Uint16(data[16:18]))

	return &PointerEvent{
		EventType: eventType,
		PointerID: 0,
		Timestamp: 0,
		IsPrimary: isPrimary,
		X:         x,
		Y:         y,
		Pressure:  pressure,
		TiltX:     tiltX,
		TiltY:     tiltY,
		Twist:     twist,
		Btn:       btn,
		Buttons:   buttons,
		Hovering:  hovering,
	}, true
}
