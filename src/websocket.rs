use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;

use fastwebsockets::{FragmentCollectorRead, Frame, OpCode, WebSocket, WebSocketError};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tracing::{info, trace, warn};

use crate::input::PenInjector;
use crate::monitor::{enumerate_monitors, MonitorGeometry};
use crate::protocol::{MessageInbound, MessageOutbound, MonitorInfo};

struct WsSender {
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

impl WsSender {
    fn send_message(&self, msg: MessageOutbound) {
        if let Ok(json) = serde_json::to_vec(&msg) {
            let _ = self.tx.try_send(json);
        }
    }
}

pub fn handle_client(
    ws: WebSocket<TokioIo<Upgraded>>,
    initial_monitor: usize,
    semaphore: Arc<tokio::sync::Semaphore>,
    remote_addr: SocketAddr,
) {
    let (rx_ws, mut tx_ws) = ws.split(tokio::io::split);
    let mut rx_ws = FragmentCollectorRead::new(rx_ws);

    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    // Writer task — sends outbound messages to the WebSocket as text (JSON)
    let _permit = semaphore.clone();
    tokio::spawn(async move {
        while let Some(data) = out_rx.recv().await {
            let frame = Frame::text(fastwebsockets::Payload::Owned(data));
            if tx_ws.write_frame(frame).await.is_err() {
                break;
            }
        }
    });

    let sender = WsSender { tx: out_tx };

    // Build monitor list and pen injector on a dedicated thread (blocking Win32 calls)
    thread::spawn(move || {
        let monitors = enumerate_monitors();
        let monitor_infos: Vec<MonitorInfo> = monitors.iter().map(|(info, _)| info.clone()).collect();

        // Select initial monitor
        let geom = select_monitor_by_index(&monitors, initial_monitor);
        let mut injector = PenInjector::new(geom);

        // Send monitor list on connect
        sender.send_message(MessageOutbound::MonitorList(monitor_infos));
        sender.send_message(MessageOutbound::ConfigOk);

        info!("WebSocket client connected from {}, {} monitor(s) available", remote_addr, monitors.len());

        // Read loop — runs on tokio runtime via block_on
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            loop {
                let frame = match rx_ws
                    .read_frame::<_, WebSocketError>(&mut |_| async { Ok(()) })
                    .await
                {
                    Ok(f) => f,
                    Err(_) => break,
                };

                match frame.opcode {
                    OpCode::Text | OpCode::Binary => {
                        let data = frame.payload.as_ref();
                        match serde_json::from_slice::<MessageInbound>(data) {
                            Ok(msg) => match msg {
                                MessageInbound::PointerEvent(event) => {
                                    injector.inject(&event);
                                }
                                MessageInbound::PointerEvents(events) => {
                                    for event in &events {
                                        injector.inject(event);
                                    }
                                }
                                MessageInbound::RelativeMouseMove(event) => {
                                    injector.move_mouse_relative(&event);
                                }
                                MessageInbound::WheelEvent(event) => {
                                    injector.scroll_wheel(&event);
                                }
                                MessageInbound::ZoomEvent(event) => {
                                    injector.zoom(&event);
                                }
                                MessageInbound::ZoomState(event) => {
                                    injector.set_zoom_modifier(&event);
                                }
                                MessageInbound::MouseClick(event) => {
                                    injector.click_mouse_button(&event);
                                }
                                MessageInbound::MouseButton(event) => {
                                    injector.set_mouse_button(&event);
                                }
                                MessageInbound::RequestMonitorList => {
                                    let mons = enumerate_monitors();
                                    let infos: Vec<MonitorInfo> =
                                        mons.iter().map(|(i, _)| i.clone()).collect();
                                    sender.send_message(MessageOutbound::MonitorList(infos));
                                }
                                MessageInbound::SelectMonitor(id) => {
                                    let mons = enumerate_monitors();
                                    let geom = select_monitor_by_id(&mons, &id);
                                    info!(
                                        "Monitor switched to {id}: rect=({},{}) {}x{} offset=({},{})",
                                        geom.left,
                                        geom.top,
                                        geom.width,
                                        geom.height,
                                        geom.offset_x,
                                        geom.offset_y
                                    );
                                    injector.set_geometry(geom);
                                    sender.send_message(MessageOutbound::ConfigOk);
                                }
                            },
                            Err(err) => {
                                trace!("Failed to parse message: {err}");
                            }
                        }
                    }
                    OpCode::Close => break,
                    _ => {}
                }
            }
        });

        info!("WebSocket client disconnected from {}", remote_addr);
    });
}

fn select_monitor_by_index(
    monitors: &[(MonitorInfo, MonitorGeometry)],
    index: usize,
) -> MonitorGeometry {
    if let Some((_, geom)) = monitors.get(index) {
        MonitorGeometry {
            left: geom.left,
            top: geom.top,
            width: geom.width,
            height: geom.height,
            offset_x: geom.offset_x,
            offset_y: geom.offset_y,
        }
    } else if let Some((_, geom)) = monitors.first() {
        warn!("Monitor index {index} not found, falling back to first monitor");
        MonitorGeometry {
            left: geom.left,
            top: geom.top,
            width: geom.width,
            height: geom.height,
            offset_x: geom.offset_x,
            offset_y: geom.offset_y,
        }
    } else {
        warn!("No monitors found, using default 1920x1080");
        MonitorGeometry {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
            offset_x: 0,
            offset_y: 0,
        }
    }
}

fn select_monitor_by_id(
    monitors: &[(MonitorInfo, MonitorGeometry)],
    id: &str,
) -> MonitorGeometry {
    if let Some((_, geom)) = monitors.iter().find(|(info, _)| info.id == id) {
        MonitorGeometry {
            left: geom.left,
            top: geom.top,
            width: geom.width,
            height: geom.height,
            offset_x: geom.offset_x,
            offset_y: geom.offset_y,
        }
    } else {
        warn!("Monitor id {id} not found, falling back to first monitor");
        select_monitor_by_index(monitors, 0)
    }
}
