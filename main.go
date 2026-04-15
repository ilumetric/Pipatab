package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
)

const version = "0.1.0"

func getLocalIPs() []net.IP {
	var ips []net.IP
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			ips = append(ips, addr.IP)
		}
	}
	loopback := net.ParseIP("127.0.0.1")
	has := false
	for _, ip := range ips {
		if ip.Equal(loopback) {
			has = true
			break
		}
	}
	if !has {
		ips = append(ips, loopback)
	}
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

	// Log virtual screen
	vx, vy, vw, vh := GetVirtualScreen()
	log.Printf("Virtual screen: origin=(%d,%d) size=%dx%d", vx, vy, vw, vh)

	// Enumerate & log monitors
	monitors := EnumerateMonitors()
	for _, m := range monitors {
		log.Printf("  Monitor %s: %s %dx%d screen=(%d,%d) vsOffset=(%d,%d) primary=%v",
			m.Info.ID, m.Info.Name, m.Info.Width, m.Info.Height,
			m.Geom.Left, m.Geom.Top,
			m.Geom.OffsetX, m.Geom.OffsetY,
			m.Info.IsPrimary)
	}

	addr := fmt.Sprintf("%s:%d", *bindAddress, *webPort)
	isAny := *bindAddress == "0.0.0.0" || *bindAddress == "::"

	if isAny {
		ips := getLocalIPs()
		log.Println("──────────────────────────────────────────")
		log.Println("Open on your iPad:")
		for _, ip := range ips {
			if !ip.IsLoopback() {
				log.Printf("  http://%s:%d", ip, *webPort)
			}
		}
		log.Printf("Local: http://127.0.0.1:%d", *webPort)
		log.Println("──────────────────────────────────────────")
	} else {
		log.Printf("Server: http://%s", addr)
	}

	shutdown := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		<-sig
		log.Println("Ctrl+C received, shutting down...")
		close(shutdown)
	}()

	RunServer(ServerConfig{
		BindAddr:       addr,
		AccessCode:     *accessCode,
		InitialMonitor: *monitor,
	}, shutdown)
}
