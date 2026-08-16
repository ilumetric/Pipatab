package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"io/fs"
	"log"
	"net"
	"net/http"
	"time"
)

//go:embed web/index.html web/app.css web/dist/app.js web/manifest.webmanifest web/icon.svg web/icon-180.png web/icon-192.png web/icon-512.png
var webFS embed.FS

type ServerConfig struct {
	BindAddr   string
	AccessCode string
}

func RunServer(hub *Hub, cfg ServerConfig, shutdown <-chan struct{}) {
	mux := http.NewServeMux()

	authorized := func(r *http.Request) bool {
		if cfg.AccessCode == "" {
			return true
		}
		got := r.URL.Query().Get("code")
		return subtle.ConstantTimeCompare([]byte(got), []byte(cfg.AccessCode)) == 1
	}

	serveEmbedded := func(path, contentType string) http.HandlerFunc {
		data, err := fs.ReadFile(webFS, path)
		if err != nil {
			log.Fatalf("embedded asset missing: %s: %v", path, err)
		}
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Content-Type", contentType)
			w.Write(data)
		}
	}

	index := serveEmbedded("web/index.html", "text/html; charset=utf-8")
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if !authorized(r) {
			log.Printf("Unauthorized page request from %s", r.RemoteAddr)
			http.Error(w, "Unauthorized: append ?code=<access code> to the URL", http.StatusUnauthorized)
			return
		}
		index(w, r)
	})

	mux.HandleFunc("/app.css", serveEmbedded("web/app.css", "text/css; charset=utf-8"))
	mux.HandleFunc("/app.js", serveEmbedded("web/dist/app.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("/manifest.webmanifest", serveEmbedded("web/manifest.webmanifest", "application/manifest+json"))
	mux.HandleFunc("/icon.svg", serveEmbedded("web/icon.svg", "image/svg+xml"))
	for _, size := range []string{"180", "192", "512"} {
		name := "icon-" + size + ".png"
		mux.HandleFunc("/"+name, serveEmbedded("web/"+name, "image/png"))
	}

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			log.Printf("Unauthorized WebSocket request from %s", r.RemoteAddr)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		HandleWebSocket(hub, w, r)
	})

	ln, err := net.Listen("tcp", cfg.BindAddr)
	if err != nil {
		log.Fatalf("Failed to bind %s: %v", cfg.BindAddr, err)
	}

	server := &http.Server{
		Handler: mux,
		// Disable Nagle on every accepted connection: pen frames are tiny and
		// latency-critical.
		ConnState: func(conn net.Conn, state http.ConnState) {
			if state == http.StateNew {
				if tc, ok := conn.(*net.TCPConn); ok {
					tc.SetNoDelay(true)
				}
			}
		},
	}

	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	<-shutdown
	log.Println("Shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		server.Close()
	}
}
