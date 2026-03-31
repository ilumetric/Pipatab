use crate::protocol::MonitorInfo;
use std::mem;
use std::ptr;
use tracing::info;
use winapi::shared::minwindef::{BOOL, DWORD, LPARAM, TRUE};
use winapi::shared::windef::{HDC, HMONITOR, LPRECT, RECT};
use winapi::um::winuser::{
    EnumDisplayMonitors, GetMonitorInfoW, SetProcessDPIAware, LPMONITORINFO, MONITORINFOEXW,
    MONITORINFOF_PRIMARY,
};

pub struct MonitorGeometry {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub offset_x: i32,
    pub offset_y: i32,
}

/// Must be called once at startup before any display/input operations.
/// Ensures the process sees real physical pixel coordinates (not DPI-scaled).
pub fn init_dpi_awareness() {
    unsafe {
        SetProcessDPIAware();
    }
}

unsafe extern "system" fn monitor_enum_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _lprect: LPRECT,
    lparam: LPARAM,
) -> BOOL {
    let monitors = &mut *(lparam as *mut Vec<(String, RECT, bool)>);

    let mut mi: MONITORINFOEXW = mem::zeroed();
    mi.cbSize = mem::size_of::<MONITORINFOEXW>() as DWORD;

    if GetMonitorInfoW(hmonitor, &mut mi as *mut MONITORINFOEXW as LPMONITORINFO) != 0 {
        let name = String::from_utf16_lossy(&mi.szDevice)
            .trim_end_matches('\0')
            .to_string();
        let is_primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
        monitors.push((name, mi.rcMonitor, is_primary));
    }

    TRUE
}

fn friendly_monitor_name(device_name: &str, fallback_index: usize) -> String {
    if let Some(display_index) = device_name
        .strip_prefix(r"\\.\DISPLAY")
        .and_then(|suffix| suffix.parse::<usize>().ok())
    {
        return format!("Display {display_index}");
    }

    format!("Display {}", fallback_index + 1)
}

pub fn enumerate_monitors() -> Vec<(MonitorInfo, MonitorGeometry)> {
    let mut raw: Vec<(String, RECT, bool)> = Vec::new();

    unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(monitor_enum_proc),
            &mut raw as *mut _ as LPARAM,
        );
    }

    let virtual_left = raw.iter().map(|(_, rect, _)| rect.left).min().unwrap_or(0);
    let virtual_top = raw.iter().map(|(_, rect, _)| rect.top).min().unwrap_or(0);

    // Keep the list deterministic for the UI and config while not relying on
    // transient enumeration order. Primary first, then spatial order.
    raw.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.1.left.cmp(&b.1.left))
            .then_with(|| a.1.top.cmp(&b.1.top))
            .then_with(|| a.0.cmp(&b.0))
    });

    raw.into_iter()
        .enumerate()
        .map(|(idx, (device_name, rect, is_primary))| {
            let w = (rect.right - rect.left) as u32;
            let h = (rect.bottom - rect.top) as u32;
            let friendly_name = friendly_monitor_name(&device_name, idx);
            info!(
                "Monitor {idx}: {friendly_name} ({device_name}) {w}x{h} at ({},{}) primary={is_primary}",
                rect.left, rect.top
            );
            (
                MonitorInfo {
                    id: device_name,
                    name: friendly_name,
                    width: w,
                    height: h,
                    is_primary,
                },
                MonitorGeometry {
                    left: rect.left,
                    top: rect.top,
                    width: w,
                    height: h,
                    offset_x: rect.left - virtual_left,
                    offset_y: rect.top - virtual_top,
                },
            )
        })
        .collect()
}
