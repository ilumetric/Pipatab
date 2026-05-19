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
	// How long to wait for a read before assuming the client is gone. Sized
	// generously: client sends an app-level Ping every 5s, and the server's
	// transport-level ping (every 5s) triggers a browser auto-pong that resets
	// the read deadline via PongHandler. 30s gives ~6 round-trips of margin.
	wsReadTimeout = 30 * time.Second
	// How long a single write may take before we give up.
	wsWriteTimeout = 10 * time.Second
	// Server-side ping interval (transport-level, on top of app-level Ping/Pong).
	wsPingInterval = 5 * time.Second
	// Bounded queue of outbound messages. Bigger than strictly needed so a
	// transient writer stall doesn't tear down the session — this queue sees
	// only Pong replies and config acknowledgements, never pen events.
	wsOutboundQueue = 256
	// Bounded queue of injection tasks. The reader pushes tasks here; the
	// dedicated worker (locked to a single OS thread) drains and executes them.
	// Sized to absorb ~1 second of 240Hz pen events plus headroom.
	wsInjectQueue = 512
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// injectionTask is a closure that runs on the injector's locked OS thread.
// Every operation that mutates PenInjector state must go through this channel.
type injectionTask func(*PenInjector)

// HandleWebSocket upgrades an HTTP connection to WebSocket and runs the
// client session. The injector worker runs on its own locked OS thread; the
// reader goroutine stays free to service ping/pong without blocking on
// Win32 syscalls.
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
	defer conn.Close()

	monitors := EnumerateMonitors()
	geom := selectMonitorByIndex(monitors, initialMonitor)

	taskCh := make(chan injectionTask, wsInjectQueue)
	workerReady := make(chan error, 1)
	workerDone := make(chan struct{})

	// Injection worker: owns the PenInjector exclusively, locks to one OS
	// thread (Win32 synthetic pointer device is thread-bound), and drains
	// taskCh until it's closed.
	go func() {
		defer close(workerDone)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		injector, err := NewPenInjector(geom)
		if err != nil {
			workerReady <- err
			return
		}
		workerReady <- nil
		defer injector.Close()

		for task := range taskCh {
			task(injector)
		}
	}()

	if err := <-workerReady; err != nil {
		log.Printf("Failed to create pen injector for %s: %v", remoteAddr, err)
		close(taskCh)
		<-workerDone
		return
	}

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
			// Outbound queue saturated. With cap=256 this means the writer has
			// been stuck for a long time — the client is effectively gone.
			// Drop this message rather than block the reader.
			log.Printf("Outbound queue full for %s, dropping %s", remoteAddr, tag)
		}
	}

	// submitTask hands an injection task to the worker. Pen events are bursty
	// at up to ~240 Hz; we block briefly on a full queue rather than drop,
	// because dropping pen samples mid-stroke produces visible polylines.
	// If the worker is genuinely stuck the read deadline will fire and the
	// session tears down cleanly.
	submitTask := func(task injectionTask) {
		taskCh <- task
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
			handleBinaryFrame(data, submitTask)
		case websocket.TextMessage:
			handleTextFrame(data, submitTask, sendMsg)
		}
	}

	// Cleanly shut down ping ticker, injection worker, and writer.
	close(pingStop)
	<-pingDone
	close(taskCh)
	<-workerDone
	close(outCh)
	writerWg.Wait()
	log.Printf("WebSocket client disconnected from %s", remoteAddr)
}

func handleTextFrame(data []byte, submit func(injectionTask), sendMsg func(string, any)) {
	var msg MessageInbound
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Tag {
	case "PointerEvent":
		var ev PointerEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.Inject(&ev) })
		}
	case "PointerEvents":
		var events []PointerEvent
		if json.Unmarshal(msg.Body, &events) == nil {
			submit(func(inj *PenInjector) { injectPointerBatch(inj, events) })
		}
	case "RelativeMouseMove":
		var ev RelativeMouseMoveEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.MoveMouseRelative(&ev) })
		}
	case "WheelEvent":
		var ev WheelEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.ScrollWheel(&ev) })
		}
	case "ZoomEvent":
		var ev ZoomEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.Zoom(&ev) })
		}
	case "ZoomState":
		var ev ZoomStateEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.SetZoomModifier(&ev) })
		}
	case "ModifierState":
		var ev ModifierStateEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.SetModifier(&ev) })
		}
	case "MouseClick":
		var ev MouseClickEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.ClickMouseButton(&ev) })
		}
	case "MouseButton":
		var ev MouseButtonEvent
		if json.Unmarshal(msg.Body, &ev) == nil {
			submit(func(inj *PenInjector) { inj.SetMouseButton(&ev) })
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
			submit(func(inj *PenInjector) { inj.SetGeometry(g) })
			sendMsg("ConfigOk", nil)
		}
	case "Ping":
		sendMsg("Pong", nil)
	}
}

// injectPointerBatch injects every event in the batch in arrival order. We
// intentionally do NOT deduplicate consecutive pointermove events: the
// intermediate positions define stroke shape, and dropping them turns a smooth
// curve into a polyline. InjectSyntheticPointerInput is a ~50µs syscall so
// 8–16 calls per WebSocket frame is well within budget.
func injectPointerBatch(injector *PenInjector, events []PointerEvent) {
	for i := range events {
		injector.Inject(&events[i])
	}
}

func handleBinaryFrame(data []byte, submit func(injectionTask)) {
	if len(data) == 0 {
		return
	}

	switch data[0] {
	case BinaryMsgPointerEvent:
		if ev, ok := parseBinaryPointerEvent(data[1:]); ok {
			submit(func(inj *PenInjector) { inj.Inject(ev) })
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
		submit(func(inj *PenInjector) { injectPointerBatch(inj, events) })
	}
}
