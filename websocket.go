package main

import (
	"encoding/json"
	"log"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// How long to wait for a read before assuming the client is gone.
	wsReadTimeout = 15 * time.Second
	// How long a single write may take before we give up.
	wsWriteTimeout = 10 * time.Second
	// Server-side ping interval (transport-level, on top of app-level Ping/Pong).
	wsPingInterval = 5 * time.Second
	// Bounded queue of outbound messages. Larger queues hide back-pressure; a
	// smaller bound forces the sender to drop or close.
	wsOutboundQueue = 64
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// HandleWebSocket upgrades an HTTP connection to WebSocket and runs the
// client session. Pen injection runs on a locked OS thread.
func HandleWebSocket(w http.ResponseWriter, r *http.Request, initialMonitor int) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	remoteAddr := r.RemoteAddr
	log.Printf("WebSocket client connected from %s", remoteAddr)

	go runSession(conn, remoteAddr, initialMonitor)
}

func runSession(conn *websocket.Conn, remoteAddr string, initialMonitor int) {
	// Win32 synthetic pointer device is thread-bound — lock the whole session
	// (reader + injection) to a single OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer conn.Close()

	monitors := EnumerateMonitors()
	geom := selectMonitorByIndex(monitors, initialMonitor)

	injector, err := NewPenInjector(geom)
	if err != nil {
		log.Printf("Failed to create pen injector for %s: %v", remoteAddr, err)
		return
	}
	defer injector.Close()

	infos := make([]MonitorInfo, len(monitors))
	for i, m := range monitors {
		infos[i] = m.Info
	}

	outCh := make(chan []byte, wsOutboundQueue)
	var writerWg sync.WaitGroup
	writerWg.Add(1)

	// Single writer goroutine owns all NextWriter/WriteMessage calls.
	// Transport-level pings are sent via WriteControl, which the gorilla
	// contract allows concurrently with a regular writer.
	go func() {
		defer writerWg.Done()
		for data := range outCh {
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				conn.Close() // unblock the reader
				// Drain remaining to let senders unblock and range exit.
				for range outCh {
				}
				return
			}
		}
	}()

	sendMsg := func(tag string, payload any) {
		data, err := marshalOutbound(tag, payload)
		if err != nil {
			return
		}
		select {
		case outCh <- data:
		default:
			// Queue full — client is too slow; close session.
			log.Printf("Outbound queue full for %s, closing", remoteAddr)
			conn.Close()
		}
	}

	// Pong handler extends the read deadline every time a transport-level
	// pong arrives from the client.
	conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		return nil
	})

	// Transport-level ping ticker. WriteControl is safe to call concurrently
	// with the writer goroutine (per gorilla/websocket contract).
	pingStop := make(chan struct{})
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				deadline := time.Now().Add(wsWriteTimeout)
				if err := conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
					conn.Close()
					return
				}
			case <-pingStop:
				return
			}
		}
	}()

	// Initial messages.
	sendMsg("MonitorList", infos)
	sendMsg("ConfigOk", nil)

	log.Printf("Client %s: %d monitor(s) available", remoteAddr, len(monitors))

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(wsReadTimeout))

		switch msgType {
		case websocket.BinaryMessage:
			handleBinaryFrame(data, injector)
		case websocket.TextMessage:
			handleTextFrame(data, injector, sendMsg)
		}
	}

	// Cleanly shut down ping ticker and writer.
	close(pingStop)
	<-pingDone
	close(outCh)
	writerWg.Wait()
	log.Printf("WebSocket client disconnected from %s", remoteAddr)
}

func handleTextFrame(data []byte, injector *PenInjector, sendMsg func(string, any)) {
	var msg MessageInbound
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Tag {
	case "PointerEvent":
		var ev PointerEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.Inject(&ev)
		}
	case "PointerEvents":
		var events []PointerEvent
		if json.Unmarshal(msg.Body, &events) == nil {
			injectPointerBatch(injector, events)
		}
	case "RelativeMouseMove":
		var ev RelativeMouseMoveEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.MoveMouseRelative(&ev)
		}
	case "WheelEvent":
		var ev WheelEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.ScrollWheel(&ev)
		}
	case "ZoomEvent":
		var ev ZoomEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.Zoom(&ev)
		}
	case "ZoomState":
		var ev ZoomStateEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.SetZoomModifier(&ev)
		}
	case "ModifierState":
		var ev ModifierStateEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.SetModifier(&ev)
		}
	case "MouseClick":
		var ev MouseClickEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.ClickMouseButton(&ev)
		}
	case "MouseButton":
		var ev MouseButtonEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			injector.SetMouseButton(&ev)
		}
	case "RequestMonitorList":
		mons := EnumerateMonitors()
		mi := make([]MonitorInfo, len(mons))
		for i, m := range mons {
			mi[i] = m.Info
		}
		sendMsg("MonitorList", mi)
	case "SelectMonitor":
		var id string
		if json.Unmarshal(msg.Body, &id) == nil {
			mons := EnumerateMonitors()
			g := selectMonitorByID(mons, id)
			log.Printf("Monitor switched to %s: %dx%d screen=(%d,%d) vsOffset=(%d,%d)",
				id, g.Width, g.Height, g.Left, g.Top, g.OffsetX, g.OffsetY)
			injector.SetGeometry(g)
			sendMsg("ConfigOk", nil)
		}
	case "Ping":
		sendMsg("Pong", nil)
	}
}

// injectPointerBatch deduplicates consecutive pointermove events to only the
// last one (it carries the final position & pressure). InjectSyntheticPointerInput
// has a 0.1 ms minimum interval between calls; injecting every coalesced move
// in a tight loop triggers ERROR_NOT_READY.
func injectPointerBatch(injector *PenInjector, events []PointerEvent) {
	var lastMove *PointerEvent
	for i := range events {
		ev := &events[i]
		if ev.EventType == PointerMove {
			lastMove = ev
			continue
		}
		if lastMove != nil {
			injector.Inject(lastMove)
			lastMove = nil
		}
		injector.Inject(ev)
	}
	if lastMove != nil {
		injector.Inject(lastMove)
	}
}

func handleBinaryFrame(data []byte, injector *PenInjector) {
	if len(data) == 0 {
		return
	}

	switch data[0] {
	case BinaryMsgPointerEvent:
		if ev, ok := parseBinaryPointerEvent(data[1:]); ok {
			injector.Inject(ev)
		}
	case BinaryMsgPointerEvents:
		if len(data) < 2 {
			return
		}
		count := int(data[1])
		events := make([]PointerEvent, 0, count)
		for i := 0; i < count; i++ {
			offset := 2 + i*BinaryEventSize
			if offset+BinaryEventSize > len(data) {
				break
			}
			if ev, ok := parseBinaryPointerEvent(data[offset:]); ok {
				events = append(events, *ev)
			}
		}
		injectPointerBatch(injector, events)
	}
}
