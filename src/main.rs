mod config;
mod input;
mod log;
mod monitor;
mod protocol;
mod web;
mod websocket;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::sync::Notify;
use tracing::info;

use config::get_config;
use web::{run_server, ServerConfig};

fn get_local_ips() -> Vec<IpAddr> {
    let mut ips = Vec::new();
    if let Ok(ifaces) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // Connect to a public address to determine which interface is used
        if ifaces.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = ifaces.local_addr() {
                ips.push(addr.ip());
            }
        }
    }
    // Fallback: also try loopback
    let loopback: IpAddr = "127.0.0.1".parse().unwrap();
    if !ips.contains(&loopback) {
        ips.push(loopback);
    }
    ips
}

#[tokio::main]
async fn main() {
    log::setup_logging();
    monitor::init_dpi_awareness();

    let conf = get_config();

    info!(
        "Pipatab v{} starting — monitor={}",
        env!("CARGO_PKG_VERSION"),
        conf.monitor
    );

    // Log virtual screen info for debugging
    unsafe {
        use winapi::um::winuser::*;
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        info!("Virtual screen: origin=({vx},{vy}) size={vw}x{vh}");
    }

    // Enumerate & log monitors
    let monitors = monitor::enumerate_monitors();
    for (m, g) in &monitors {
        info!(
            "  Monitor {}: {} {}x{} at ({},{}) primary={} offset=({},{})",
            m.id,
            m.name,
            m.width,
            m.height,
            g.left,
            g.top,
            m.is_primary,
            g.offset_x,
            g.offset_y
        );
    }

    let port = conf.web_port;
    let is_any = conf.bind_address.is_unspecified();

    if is_any {
        let ips = get_local_ips();
        info!("──────────────────────────────────────────");
        info!("Open on your iPad:");
        for ip in &ips {
            if !ip.is_loopback() {
                info!("  http://{}:{}", ip, port);
            }
        }
        info!("Local: http://127.0.0.1:{}", port);
        info!("──────────────────────────────────────────");
    } else {
        info!("Server: http://{}:{}", conf.bind_address, port);
    }

    let notify_shutdown = Arc::new(Notify::new());
    let notify = notify_shutdown.clone();

    // Ctrl+C handler
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("Ctrl+C received, shutting down...");
        notify.notify_one();
    });

    let server_config = ServerConfig {
        bind_addr: SocketAddr::new(conf.bind_address, conf.web_port),
        access_code: conf.access_code,
        initial_monitor: conf.monitor,
    };

    run_server(server_config, notify_shutdown).await;
}
