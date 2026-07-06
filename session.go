package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// The client pings every 2s and the server sends transport pings every
	// 5s; 20s of silence means the client is gone.
	readTimeout  = 20 * time.Second
	writeTimeout = 10 * time.Second
	pingInterval = 5 * time.Second

	// Outbound queue carries only control messages (pongs, monitor lists),
	// never pen events.
	outboundQueueSize = 64

	// Pen batches are ≤ ~3 KB and control messages are tiny; anything larger
	// is a broken or hostile client.
	maxMessageSize = 64 * 1024
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// LAN tool: the page is served from this same host and the socket is
	// already gated by the access code check in the HTTP handler.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Session is one WebSocket client. The hub designates a single active
// session; only it may inject pen input.
type Session struct {
	hub        *Hub
	conn       *websocket.Conn
	remoteAddr string

	// outMu guards out against send-after-close: Displace() is called from
	// the attaching session's goroutine and can race this session's teardown.
	outMu     sync.Mutex
	outClosed bool
	out       chan []byte
}

// HandleWebSocket upgrades the connection and runs the session to completion.
func HandleWebSocket(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	s := &Session{
		hub:        hub,
		conn:       conn,
		remoteAddr: r.RemoteAddr,
		out:        make(chan []byte, outboundQueueSize),
	}
	go s.run()
}

// Displace tells a session it lost control to a newer connection and closes it.
func (s *Session) Displace() {
	s.send(serverMessage{Type: "replaced"})
	// Give the writer a moment to flush the notice, then drop the socket.
	time.AfterFunc(250*time.Millisecond, func() { s.conn.Close() })
}

func (s *Session) send(msg serverMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	if s.outClosed {
		return
	}
	select {
	case s.out <- data:
	default:
		// Queue full means the writer has been stuck for a long time — the
		// client is effectively gone; the read deadline will clean us up.
		log.Printf("Outbound queue full for %s, dropping %s", s.remoteAddr, msg.Type)
	}
}

func (s *Session) run() {
	defer s.conn.Close()
	log.Printf("Client connected: %s", s.remoteAddr)

	s.hub.Attach(s)
	defer s.hub.Detach(s)

	// Writer: sole owner of WriteMessage. Control pings go through
	// WriteControl, which gorilla allows concurrently with a writer.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for data := range s.out {
			s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := s.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				s.conn.Close() // unblock the reader
				for range s.out {
				}
				return
			}
		}
	}()

	// Transport-level keepalive pings.
	pingStop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				deadline := time.Now().Add(writeTimeout)
				if err := s.conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
					s.conn.Close()
					return
				}
			case <-pingStop:
				return
			}
		}
	}()

	s.conn.SetReadLimit(maxMessageSize)
	s.conn.SetReadDeadline(time.Now().Add(readTimeout))
	s.conn.SetPongHandler(func(string) error {
		s.conn.SetReadDeadline(time.Now().Add(readTimeout))
		return nil
	})

	// Handshake: current monitor list and selection.
	monitors, selected := s.hub.Monitors()
	s.send(serverMessage{
		Type:       "welcome",
		Version:    version,
		Monitors:   monitors,
		MonitorIDs: selected,
	})

	// Reusable event buffer: pen batches are parsed into it and injected
	// synchronously per task, so it is never aliased across tasks.
	var eventBuf [256]PenEvent

	for {
		msgType, data, err := s.conn.ReadMessage()
		if err != nil {
			break
		}
		s.conn.SetReadDeadline(time.Now().Add(readTimeout))

		switch msgType {
		case websocket.BinaryMessage:
			if !s.hub.IsActive(s) {
				continue
			}
			events := ParsePenBatch(data, eventBuf[:0])
			if len(events) == 0 {
				continue
			}
			// Copy out of the shared buffer: the task runs asynchronously on
			// the injection thread while the reader parses the next frame.
			batch := make([]PenEvent, len(events))
			copy(batch, events)
			s.hub.Submit(func(inj *Injector) {
				for i := range batch {
					inj.Inject(&batch[i])
				}
			})

		case websocket.TextMessage:
			s.handleControl(data)
		}
	}

	close(pingStop)
	s.outMu.Lock()
	s.outClosed = true
	close(s.out)
	s.outMu.Unlock()
	<-writerDone
	log.Printf("Client disconnected: %s", s.remoteAddr)
}

func (s *Session) handleControl(data []byte) {
	var msg controlMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "ping":
		s.send(serverMessage{Type: "pong", T: msg.T})

	case "monitors":
		monitors, selected := s.hub.Monitors()
		s.send(serverMessage{Type: "monitors", Monitors: monitors, MonitorIDs: selected})

	case "selectMonitors":
		if !s.hub.IsActive(s) {
			return
		}
		monitors, selected := s.hub.SelectMonitors(msg.MonitorIDs)
		s.send(serverMessage{Type: "monitors", Monitors: monitors, MonitorIDs: selected})
	}
}
