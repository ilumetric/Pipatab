package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
)

const version = "2.0.0"

// preferredLocalIP returns the outbound IPv4 address via the UDP-dial trick
// (no packet is sent).
func preferredLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && !addr.IP.IsLoopback() {
		return addr.IP.String()
	}
	return ""
}

func main() {
	bindAddress := flag.String("bind", "0.0.0.0", "Bind address")
	port := flag.Int("port", 1701, "HTTP/WebSocket port")
	accessCode := flag.String("code", "", "Optional access code required in the URL (?code=...)")
	monitorID := flag.String("monitor", "", `Initial monitor device name (e.g. \\.\DISPLAY2); default = primary`)
	flag.Parse()

	log.SetFlags(log.Ltime)
	InitDPIAwareness()

	log.Printf("Pipatab v%s", version)
	for _, m := range EnumerateMonitors() {
		primary := ""
		if m.IsPrimary {
			primary = "  [primary]"
		}
		log.Printf("  %-14s %s  %dx%d at (%d,%d)%s", m.ID, m.Name, m.Width, m.Height, m.Left, m.Top, primary)
	}

	hub, err := NewHub(*monitorID)
	if err != nil {
		log.Fatalf("Pen injection unavailable: %v (Windows 10 1809+ required)", err)
	}

	suffix := ""
	if *accessCode != "" {
		suffix = "?code=" + *accessCode
	}
	log.Println("------------------------------------------")
	if ip := preferredLocalIP(); ip != "" {
		log.Printf("  Open on your iPad:  http://%s:%d%s", ip, *port, suffix)
	} else {
		log.Printf("  Listening on port %d (no LAN address detected)", *port)
	}
	log.Println("------------------------------------------")

	shutdown := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		close(shutdown)
	}()

	RunServer(hub, ServerConfig{
		BindAddr:   fmt.Sprintf("%s:%d", *bindAddress, *port),
		AccessCode: *accessCode,
	}, shutdown)
}
