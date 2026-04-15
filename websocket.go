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

	// Run injection + read loop on a dedicated OS thread (Win32 synthetic
	// pointer device is thread-bound).
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer conn.Close()

		monitors := EnumerateMonitors()
		geom := selectMonitorByIndex(monitors, initialMonitor)
		injector := NewPenInjector(geom)
		defer injector.Close()

		// Build monitor info list
		infos := make([]MonitorInfo, len(monitors))
		for i, m := range monitors {
			infos[i] = m.Info
		}

		// Outbound channel
		outCh := make(chan []byte, 256)
		writerDone := make(chan struct{})
		var writeWg sync.WaitGroup
		writeWg.Add(1)
		go func() {
			defer writeWg.Done()
			defer close(writerDone)
			for data := range outCh {
				conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					// Write failed — close connection so the reader unblocks.
					conn.Close()
					// Drain remaining messages to allow channel close.
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
			case <-writerDone:
			}
		}

		// Configure gorilla's built-in pong handler to extend the read deadline
		// every time we receive a transport-level pong from the client.
		conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
			return nil
		})

		// Server-side ping ticker keeps the transport alive and detects
		// silent disconnects even when no application messages flow.
		pingTicker := time.NewTicker(wsPingInterval)
		defer pingTicker.Stop()
		go func() {
			for {
				select {
				case <-pingTicker.C:
					conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
					if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
						conn.Close()
						return
					}
				case <-writerDone:
					return
				}
			}
		}()

		// Initial messages
		sendMsg("MonitorList", infos)
		sendMsg("ConfigOk", nil)

		log.Printf("Client %s: %d monitor(s) available", remoteAddr, len(monitors))

		// Read loop
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			// Extend deadline on every successfully received message.
			conn.SetReadDeadline(time.Now().Add(wsReadTimeout))

			switch msgType {
			case websocket.BinaryMessage:
				handleBinaryFrame(data, injector)

			case websocket.TextMessage:
				var msg MessageInbound
				if err := json.Unmarshal(data, &msg); err != nil {
					continue
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
						// Same deduplication as binary batches — only inject last move.
						var lastMove *PointerEvent
						for i := range events {
							if events[i].EventType == PointerMove {
								lastMove = &events[i]
							} else {
								if lastMove != nil {
									injector.Inject(lastMove)
									lastMove = nil
								}
								injector.Inject(&events[i])
							}
						}
						if lastMove != nil {
							injector.Inject(lastMove)
						}
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
		}

		close(outCh)
		writeWg.Wait()
		log.Printf("WebSocket client disconnected from %s", remoteAddr)
	}()
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
		// Binary batches contain coalesced pointermove events from the browser.
		// InjectSyntheticPointerInput has a 0.1 ms minimum interval between calls;
		// injecting every event in a tight loop triggers ERROR_NOT_READY.
		// We inject non-move events immediately and deduplicate consecutive moves
		// to only the last one, which carries the final position & pressure.
		var lastMove *PointerEvent
		for i := 0; i < count; i++ {
			offset := 2 + i*BinaryEventSize
			if offset+BinaryEventSize > len(data) {
				break
			}
			ev, ok := parseBinaryPointerEvent(data[offset:])
			if !ok {
				continue
			}
			if ev.EventType == PointerMove {
				lastMove = ev
			} else {
				// Flush any pending move before a non-move event
				if lastMove != nil {
					injector.Inject(lastMove)
					lastMove = nil
				}
				injector.Inject(ev)
			}
		}
		if lastMove != nil {
			injector.Inject(lastMove)
		}
	}
}
