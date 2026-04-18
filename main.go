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

const version = "0.1.0"

// getLocalIPs returns the preferred outbound IPv4 address (via a UDP dial
// trick — no packet is actually sent) plus loopback as a fallback.
func getLocalIPs() []net.IP {
	ips := []net.IP{}
	if conn, err := net.Dial("udp", "8.8.8.8:80"); err == nil {
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && !addr.IP.IsLoopback() {
			ips = append(ips, addr.IP)
		}
		conn.Close()
	}
	ips = append(ips, net.IPv4(127, 0, 0, 1))
	return ips
}

func main() {
	accessCode := flag.String("access-code", "", "Access code to restrict connections")
	bindAddress := flag.String("bind-address", "0.0.0.0", "Bind address")
	webPort := flag.Int("web-port", 1701, "Web server port")
	monitor := flag.Int("monitor", 0, "Target monitor index (0 = primary)")
	flag.Parse()

	InitDPIAwareness()

	log.Printf("Pipatab v%s starting — monitor=%d", version, *monitor)

	vx, vy, vw, vh := GetVirtualScreen()
	log.Printf("Virtual screen: origin=(%d,%d) size=%dx%d", vx, vy, vw, vh)

	monitors := EnumerateMonitors()
	for i, m := range monitors {
		log.Printf("  [%d] %s (%s) %dx%d screen=(%d,%d) vsOffset=(%d,%d) primary=%v",
			i, m.Info.Name, m.Info.ID, m.Info.Width, m.Info.Height,
			m.Geom.Left, m.Geom.Top, m.Geom.OffsetX, m.Geom.OffsetY, m.Info.IsPrimary)
	}

	addr := fmt.Sprintf("%s:%d", *bindAddress, *webPort)
	isAny := *bindAddress == "0.0.0.0" || *bindAddress == "::"

	log.Println("──────────────────────────────────────────")
	if isAny {
		log.Println("Open on your iPad:")
		for _, ip := range getLocalIPs() {
			if ip.IsLoopback() {
				log.Printf("  http://127.0.0.1:%d  (local only)", *webPort)
			} else {
				log.Printf("  http://%s:%d", ip, *webPort)
			}
		}
	} else {
		log.Printf("Server: http://%s", addr)
	}
	log.Println("──────────────────────────────────────────")

	shutdown := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Println("Shutdown signal received, stopping...")
		close(shutdown)
	}()

	RunServer(ServerConfig{
		BindAddr:       addr,
		AccessCode:     *accessCode,
		InitialMonitor: *monitor,
	}, shutdown)
}

