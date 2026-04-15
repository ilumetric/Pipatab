package main

import (
	_ "embed"
	"log"
	"net"
	"net/http"
	"net/url"
)

//go:embed www/templates/index.html
var indexHTML []byte

//go:embed www/static/style.css
var styleCSS []byte

//go:embed www/static/lib.js
var libJS []byte

type ServerConfig struct {
	BindAddr       string
	AccessCode     string
	InitialMonitor int
}

func RunServer(cfg ServerConfig, shutdown <-chan struct{}) {
	mux := http.NewServeMux()

	noCacheHeaders := func(w http.ResponseWriter) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	}

	checkAccess := func(r *http.Request) bool {
		if cfg.AccessCode == "" {
			return true
		}
		q, _ := url.ParseQuery(r.URL.RawQuery)
		return q.Get("access_code") == cfg.AccessCode
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if !checkAccess(r) {
			log.Printf("Unauthorized request from %s to /", r.RemoteAddr)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		noCacheHeaders(w)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})

	mux.HandleFunc("/style.css", func(w http.ResponseWriter, r *http.Request) {
		noCacheHeaders(w)
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Write(styleCSS)
	})

	mux.HandleFunc("/lib.js", func(w http.ResponseWriter, r *http.Request) {
		noCacheHeaders(w)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Write(libJS)
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !checkAccess(r) {
			log.Printf("Unauthorized WebSocket request from %s", r.RemoteAddr)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		log.Printf("WebSocket upgrade requested from %s", r.RemoteAddr)
		HandleWebSocket(w, r, cfg.InitialMonitor)
	})

	ln, err := net.Listen("tcp", cfg.BindAddr)
	if err != nil {
		log.Fatalf("Failed to bind to %s: %v", cfg.BindAddr, err)
	}

	// Set TCP_NODELAY on accepted connections via a custom listener.
	server := &http.Server{Handler: mux}
	server.ConnState = func(conn net.Conn, state http.ConnState) {
		if state == http.StateNew {
			if tc, ok := conn.(*net.TCPConn); ok {
				tc.SetNoDelay(true)
			}
		}
	}

	log.Printf("Server listening on http://%s", cfg.BindAddr)

	// Serve in background, wait for shutdown signal.
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	<-shutdown
	log.Println("Shutting down server")
	server.Close()
}
