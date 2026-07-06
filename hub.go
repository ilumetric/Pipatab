package main

import (
	"log"
	"runtime"
	"strings"
	"sync"
	"time"
)

// injectionTask runs on the hub's locked OS thread — the only place allowed
// to touch the Injector (the synthetic pointer device is thread-bound).
type injectionTask func(*Injector)

// Hub owns the process-wide pen injector and enforces the single-controller
// policy: at most one WebSocket session drives the pen at a time, and a new
// connection displaces the old one (so a reloaded Safari tab always works).
type Hub struct {
	tasks chan injectionTask

	mu         sync.Mutex
	active     *Session
	monitorIDs []string // current selection (1..n monitors), survives reconnects
}

// Sized to absorb ~2 seconds of 240 Hz pen batches plus headroom; the reader
// blocks briefly if the worker falls behind rather than dropping mid-stroke
// samples (drops turn smooth curves into polylines).
const injectQueueSize = 1024

// NewHub starts the injection worker thread and creates the synthetic pen
// device on it. Returns an error if the device can't be created (e.g. the
// platform is too old).
func NewHub(initialMonitorID string) (*Hub, error) {
	var initial []string
	if initialMonitorID != "" {
		initial = []string{initialMonitorID}
	}
	monitors := EnumerateMonitors()
	union, rects, effective := SelectionGeometry(monitors, initial)

	h := &Hub{
		tasks:      make(chan injectionTask, injectQueueSize),
		monitorIDs: effective,
	}

	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		injector, err := NewInjector(union, rects)
		ready <- err
		if err != nil {
			return
		}
		defer injector.Close()

		// A motionless pen produces no client events, but Windows expires an
		// idle synthetic contact after ~100ms — the ticker keeps it warm.
		keepAlive := time.NewTicker(15 * time.Millisecond)
		defer keepAlive.Stop()

		for {
			select {
			case task, ok := <-h.tasks:
				if !ok {
					return
				}
				task(injector)
			case <-keepAlive.C:
				injector.KeepAlive()
			}
		}
	}()

	if err := <-ready; err != nil {
		return nil, err
	}
	return h, nil
}

// Submit queues a task for the injection thread. Blocks briefly when the
// queue is full; if the worker is truly wedged, the session's read deadline
// tears the connection down.
func (h *Hub) Submit(task injectionTask) {
	h.tasks <- task
}

// Attach registers a session as the active controller, displacing any
// previous one. The displaced session is told why and closed, and any pen
// contact it left behind is released — queued here, so it lands before the
// new controller's first events.
func (h *Hub) Attach(s *Session) {
	h.mu.Lock()
	prev := h.active
	h.active = s
	h.mu.Unlock()

	if prev != nil && prev != s {
		log.Printf("Session %s displaced by %s", prev.remoteAddr, s.remoteAddr)
		prev.Displace()
		h.Submit(func(inj *Injector) { inj.ForcePenUp() })
	}
}

// Detach unregisters a session and releases any held pen contact — but only
// if it is still the active controller. A displaced session tears down
// seconds later; injecting a pen-up then would cut its successor's stroke.
func (h *Hub) Detach(s *Session) {
	h.mu.Lock()
	wasActive := h.active == s
	if wasActive {
		h.active = nil
	}
	h.mu.Unlock()

	if wasActive {
		h.Submit(func(inj *Injector) { inj.ForcePenUp() })
	}
}

// IsActive reports whether the session currently controls the pen.
func (h *Hub) IsActive(s *Session) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.active == s
}

// SelectMonitors re-enumerates displays, points the injector at the union of
// the requested monitors and remembers the choice for future sessions.
// Returns the fresh monitor list and the effective selection.
func (h *Hub) SelectMonitors(ids []string) ([]Monitor, []string) {
	monitors := EnumerateMonitors()
	union, rects, effective := SelectionGeometry(monitors, ids)

	h.mu.Lock()
	h.monitorIDs = effective
	h.mu.Unlock()

	h.Submit(func(inj *Injector) { inj.SetGeometry(union, rects) })
	log.Printf("Mapping to %d monitor(s) [%s]: union %dx%d at (%d,%d)",
		len(effective), strings.Join(effective, ", "),
		union.Width, union.Height, union.OffsetX, union.OffsetY)
	return monitors, effective
}

// Monitors returns a fresh monitor list and the current selection, updating
// the injector geometry in case the display topology changed underneath us
// (resolution change, monitor unplugged).
func (h *Hub) Monitors() ([]Monitor, []string) {
	h.mu.Lock()
	ids := append([]string(nil), h.monitorIDs...)
	h.mu.Unlock()
	return h.SelectMonitors(ids)
}
