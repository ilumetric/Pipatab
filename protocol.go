package main

import "encoding/binary"

// Binary pen protocol (client → server, WebSocket binary frames).
//
// Frame layout:
//   [0]    frame type (0x01 = pen event batch)
//   [1]    event count (1..255)
//   [2..]  count × 12-byte events
//
// Event layout (little-endian):
//   [0]    event type   (0=down 1=up 2=move 3=cancel 4=enter 5=leave)
//   [1]    flags        (bit0=contact bit1=barrel bit2=eraser)
//   [2:4]  x            uint16, normalized 0..65535 across the mapped monitor
//   [4:6]  y            uint16, normalized 0..65535
//   [6:8]  pressure     uint16, normalized 0..65535 (curve already applied client-side)
//   [8]    tiltX        int8, degrees -90..90
//   [9]    tiltY        int8, degrees -90..90
//   [10:12] twist       uint16, degrees 0..359
//
// Fixed-point u16 coordinates give sub-0.1px resolution on any monitor up to
// 6K wide while keeping the whole event at 12 bytes — a full 240 Hz second of
// pen data is under 3 KB/s.

const (
	frameTypePenBatch byte = 0x01

	penEventSize = 12

	evDown   byte = 0
	evUp     byte = 1
	evMove   byte = 2
	evCancel byte = 3
	evEnter  byte = 4
	evLeave  byte = 5

	flagContact byte = 1 << 0
	flagBarrel  byte = 1 << 1
	flagEraser  byte = 1 << 2
)

type PenEvent struct {
	Type     byte
	Flags    byte
	X, Y     uint16
	Pressure uint16
	TiltX    int8
	TiltY    int8
	Twist    uint16
}

func (e *PenEvent) Contact() bool { return e.Flags&flagContact != 0 }
func (e *PenEvent) Barrel() bool  { return e.Flags&flagBarrel != 0 }
func (e *PenEvent) Eraser() bool  { return e.Flags&flagEraser != 0 }

// ParsePenBatch decodes a binary pen frame into events, reusing buf when it
// has enough capacity. Returns nil for malformed frames.
func ParsePenBatch(data []byte, buf []PenEvent) []PenEvent {
	if len(data) < 2 || data[0] != frameTypePenBatch {
		return nil
	}
	count := int(data[1])
	if count == 0 || len(data) < 2+count*penEventSize {
		return nil
	}

	events := buf[:0]
	for i := 0; i < count; i++ {
		b := data[2+i*penEventSize:]
		evType := b[0]
		if evType > evLeave {
			continue
		}
		events = append(events, PenEvent{
			Type:     evType,
			Flags:    b[1],
			X:        binary.LittleEndian.Uint16(b[2:4]),
			Y:        binary.LittleEndian.Uint16(b[4:6]),
			Pressure: binary.LittleEndian.Uint16(b[6:8]),
			TiltX:    int8(b[8]),
			TiltY:    int8(b[9]),
			Twist:    binary.LittleEndian.Uint16(b[10:12]),
		})
	}
	return events
}

// --- Control protocol (JSON over WebSocket text frames) ---------------------

// Client → server control messages.
type controlMessage struct {
	Type       string   `json:"type"`
	MonitorIDs []string `json:"monitorIds,omitempty"` // for "selectMonitors"
	T          int64    `json:"t,omitempty"`          // client timestamp echo, for "ping"
}

// Server → client messages.
type serverMessage struct {
	Type       string    `json:"type"`
	Version    string    `json:"version,omitempty"`
	Monitors   []Monitor `json:"monitors,omitempty"`
	MonitorIDs []string  `json:"monitorIds,omitempty"`
	T          int64     `json:"t,omitempty"`
	Message    string    `json:"message,omitempty"`
}
