use serde::{Deserialize, Deserializer, Serialize};

// --- Inbound (client → server) ---

#[derive(Serialize, Deserialize, Debug)]
pub enum MessageInbound {
    PointerEvent(PointerEvent),
    PointerEvents(Vec<PointerEvent>),
    RelativeMouseMove(RelativeMouseMoveEvent),
    WheelEvent(WheelEvent),
    ZoomEvent(ZoomEvent),
    ZoomState(ZoomStateEvent),
    MouseClick(MouseClickEvent),
    MouseButton(MouseButtonEvent),
    RequestMonitorList,
    SelectMonitor(String),
}

// --- Outbound (server → client) ---

#[derive(Serialize, Deserialize, Debug)]
pub enum MessageOutbound {
    MonitorList(Vec<MonitorInfo>),
    ConfigOk,
    Error(String),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

// --- Pointer events ---

#[derive(Serialize, Deserialize, Debug)]
pub enum PointerEventType {
    #[serde(rename = "pointerdown")]
    Down,
    #[serde(rename = "pointerup")]
    Up,
    #[serde(rename = "pointercancel")]
    Cancel,
    #[serde(rename = "pointermove")]
    Move,
    #[serde(rename = "pointerenter")]
    Enter,
    #[serde(rename = "pointerleave")]
    Leave,
}

bitflags::bitflags! {
    #[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
    pub struct Button: u8 {
        const NONE      = 0b0000_0000;
        const PRIMARY   = 0b0000_0001;
        const SECONDARY = 0b0000_0010;
        const ERASER    = 0b0010_0000;
    }
}

fn button_from<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Button, D::Error> {
    let bits: u8 = Deserialize::deserialize(deserializer)?;
    Button::from_bits(bits).ok_or_else(|| serde::de::Error::custom("invalid button bits"))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PointerEvent {
    pub event_type: PointerEventType,
    pub pointer_id: i64,
    pub timestamp: u64,
    pub is_primary: bool,
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub tilt_x: i32,
    pub tilt_y: i32,
    pub twist: i32,
    #[serde(deserialize_with = "button_from")]
    pub button: Button,
    #[serde(deserialize_with = "button_from")]
    pub buttons: Button,
    pub hovering: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct RelativeMouseMoveEvent {
    pub dx: i32,
    pub dy: i32,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct WheelEvent {
    pub dx: i32,
    pub dy: i32,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct ZoomEvent {
    pub delta: i32,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct ZoomStateEvent {
    pub active: bool,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct MouseClickEvent {
    #[serde(deserialize_with = "button_from")]
    pub button: Button,
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct MouseButtonEvent {
    #[serde(deserialize_with = "button_from")]
    pub button: Button,
    pub pressed: bool,
    pub timestamp: u64,
}
