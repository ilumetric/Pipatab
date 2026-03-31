use bytes::Bytes;
use fastwebsockets::upgrade;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tracing::{error, info};

use crate::websocket;

const INDEX_HTML: &[u8] = include_bytes!("../www/templates/index.html");
const STYLE_CSS: &[u8] = include_bytes!("../www/static/style.css");
const LIB_JS: &[u8] = include_bytes!("../www/static/lib.js");

#[derive(Clone)]
pub struct ServerConfig {
    pub bind_addr: SocketAddr,
    pub access_code: Option<String>,
    pub initial_monitor: usize,
}

fn response_ok(body: &'static [u8], content_type: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
    .body(Full::new(Bytes::from_static(body)))
        .unwrap()
}

fn response_not_found() -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
    .body(Full::new(Bytes::from_static(b"Not found")))
        .unwrap()
}

fn response_unauthorized() -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
    .body(Full::new(Bytes::from_static(b"Unauthorized")))
        .unwrap()
}

fn check_access(req: &Request<Incoming>, access_code: &Option<String>) -> bool {
    match access_code {
        None => true,
        Some(code) => req.uri().query().map_or(false, |query| {
            url::form_urlencoded::parse(query.as_bytes())
                .any(|(key, value)| key == "access_code" && value == code.as_str())
        }),
    }
}

async fn serve(
    mut req: Request<Incoming>,
    config: Arc<ServerConfig>,
    semaphore: Arc<tokio::sync::Semaphore>,
    remote_addr: SocketAddr,
) -> Result<Response<BoxBody<Bytes, Infallible>>, hyper::Error> {
    info!("HTTP {} {} from {}", req.method(), req.uri().path(), remote_addr);

    if req.method() != Method::GET {
        return Ok(response_not_found().map(|b| b.boxed()));
    }

    let authed = check_access(&req, &config.access_code);

    match req.uri().path() {
        "/" => {
            if !authed {
                info!("Unauthorized request from {} to /", remote_addr);
                return Ok(response_unauthorized().map(|b| b.boxed()));
            }
            Ok(response_ok(INDEX_HTML, "text/html; charset=utf-8").map(|b| b.boxed()))
        }
        "/style.css" => {
            Ok(response_ok(STYLE_CSS, "text/css; charset=utf-8").map(|b| b.boxed()))
        }
        "/lib.js" => {
            Ok(response_ok(LIB_JS, "text/javascript; charset=utf-8").map(|b| b.boxed()))
        }
        "/ws" => {
            if !authed {
                info!("Unauthorized WebSocket request from {}", remote_addr);
                return Ok(response_unauthorized().map(|b| b.boxed()));
            }
            info!("WebSocket upgrade requested from {}", remote_addr);
            let (response, fut) = upgrade::upgrade(&mut req).unwrap();
            let monitor = config.initial_monitor;
            tokio::spawn(async move {
                match fut.await {
                    Ok(ws) => {
                        websocket::handle_client(ws, monitor, semaphore, remote_addr);
                    }
                    Err(err) => {
                        error!("WebSocket upgrade error: {err}");
                    }
                }
            });
            Ok(response.map(|b| b.boxed()))
        }
        _ => Ok(response_not_found().map(|b| b.boxed())),
    }
}

pub async fn run_server(config: ServerConfig, notify_shutdown: Arc<Notify>) {
    let listener = match TcpListener::bind(config.bind_addr).await {
        Ok(l) => l,
        Err(err) => {
            error!("Failed to bind to {}: {err}", config.bind_addr);
            return;
        }
    };

    info!("Server listening on http://{}", config.bind_addr);

    let config = Arc::new(config);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(64));

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, _addr)) => {
                        let remote_addr = _addr;
                        let _ = stream.set_nodelay(true);
                        let config = config.clone();
                        let semaphore = semaphore.clone();
                        tokio::spawn(async move {
                            let io = TokioIo::new(stream);
                            let svc = service_fn(move |req| {
                                let config = config.clone();
                                let semaphore = semaphore.clone();
                                async move { serve(req, config, semaphore, remote_addr).await }
                            });
                            if let Err(err) = http1::Builder::new()
                                .serve_connection(io, svc)
                                .with_upgrades()
                                .await
                            {
                                if !err.to_string().contains("early eof") {
                                    error!("HTTP connection error: {err}");
                                }
                            }
                        });
                    }
                    Err(err) => {
                        error!("Accept error: {err}");
                    }
                }
            }
            _ = notify_shutdown.notified() => {
                info!("Shutting down server");
                break;
            }
        }
    }
}
