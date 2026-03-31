use tracing_subscriber::fmt;

pub fn setup_logging() {
    let level = get_log_level();
    fmt()
        .with_max_level(level)
        .with_target(false)
        .compact()
        .init();
}

pub fn get_log_level() -> tracing::Level {
    #[cfg(debug_assertions)]
    let mut level = tracing::Level::DEBUG;
    #[cfg(not(debug_assertions))]
    let mut level = tracing::Level::INFO;

    if let Ok(var) = std::env::var("PIPATAB_LOG_LEVEL") {
        if let Ok(l) = var.parse() {
            level = l;
        }
    }
    level
}
