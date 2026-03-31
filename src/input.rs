use std::cell::Cell;

use crate::monitor::MonitorGeometry;
use crate::protocol::{
    Button, MouseButtonEvent, MouseClickEvent, PointerEvent, PointerEventType,
    RelativeMouseMoveEvent, WheelEvent, ZoomEvent, ZoomStateEvent,
};
use tracing::{trace, warn};
use winapi::shared::minwindef::{DWORD, WORD};
use winapi::shared::windef::{HWND, POINT};
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::winuser::*;

pub struct PenInjector {
    device_handle: *mut HSYNTHETICPOINTERDEVICE__,
    geometry: MonitorGeometry,
    zoom_modifier_active: Cell<bool>,
}

unsafe impl Send for PenInjector {}

impl PenInjector {
    pub fn new(geometry: MonitorGeometry) -> Self {
        let handle = unsafe { CreateSyntheticPointerDevice(PT_PEN, 1, 1) };
        if handle.is_null() {
            let err = unsafe { GetLastError() };
            panic!("Failed to create synthetic pointer device, error={err}");
        }
        Self {
            device_handle: handle,
            geometry,
            zoom_modifier_active: Cell::new(false),
        }
    }

    pub fn set_geometry(&mut self, geometry: MonitorGeometry) {
        self.geometry = geometry;
    }

    pub fn inject(&self, event: &PointerEvent) {
        // Clamp input to [0, 1] before mapping to screen coordinates
        let ex = event.x.clamp(0.0, 1.0);
        let ey = event.y.clamp(0.0, 1.0);

        // Pen injection on Windows expects coordinates in virtual-desktop space.
        // Map [0, 1] into an inclusive pixel range so the far edge stays inside
        // the target monitor instead of landing one pixel past it.
        let max_x = self.geometry.width.saturating_sub(1) as f64;
        let max_y = self.geometry.height.saturating_sub(1) as f64;
        let x = (ex * max_x).round() as i32 + self.geometry.offset_x;
        let y = (ey * max_y).round() as i32 + self.geometry.offset_y;

        let mut pointer_flags = match event.event_type {
            PointerEventType::Down => {
                POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_DOWN
            }
            PointerEventType::Move | PointerEventType::Enter => {
                POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE
            }
            PointerEventType::Up => POINTER_FLAG_INRANGE | POINTER_FLAG_UP,
            PointerEventType::Cancel | PointerEventType::Leave => {
                POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE | POINTER_FLAG_CANCELED
            }
        };

        // INCONTACT based on currently pressed buttons (pen touching surface)
        if event.buttons.contains(Button::PRIMARY) || event.buttons.contains(Button::SECONDARY) {
            pointer_flags |= POINTER_FLAG_INCONTACT;
        }

        // ButtonChangeType only on actual DOWN/UP transitions, never on Move
        let button_change = match event.event_type {
            PointerEventType::Down => {
                if event.button.contains(Button::SECONDARY) {
                    POINTER_CHANGE_SECONDBUTTON_DOWN
                } else {
                    POINTER_CHANGE_FIRSTBUTTON_DOWN
                }
            }
            PointerEventType::Up => {
                if event.button.contains(Button::SECONDARY) {
                    POINTER_CHANGE_SECONDBUTTON_UP
                } else {
                    POINTER_CHANGE_FIRSTBUTTON_UP
                }
            }
            _ => POINTER_CHANGE_NONE,
        };

        if event.is_primary {
            pointer_flags |= POINTER_FLAG_PRIMARY;
        }

        let mut pen_flags = PEN_FLAG_NONE;
        if event.button.contains(Button::ERASER) || event.buttons.contains(Button::ERASER) {
            pen_flags |= PEN_FLAG_ERASER;
        }

        let pressure = (event.pressure * 1024.0) as u32;

        unsafe {
            let mut pointer_type_info: POINTER_TYPE_INFO = std::mem::zeroed();
            pointer_type_info.type_ = PT_PEN;

            *pointer_type_info.u.penInfo_mut() = POINTER_PEN_INFO {
                pointerInfo: POINTER_INFO {
                    pointerType: PT_PEN,
                    pointerId: 0, // must be in [0, maxCount), and maxCount=1
                    frameId: 0,
                    pointerFlags: pointer_flags,
                    sourceDevice: std::ptr::null_mut(),
                    hwndTarget: 0 as HWND,
                    ptPixelLocation: POINT { x, y },
                    ptHimetricLocation: POINT { x: 0, y: 0 },
                    ptPixelLocationRaw: POINT { x, y },
                    ptHimetricLocationRaw: POINT { x: 0, y: 0 },
                    dwTime: 0,
                    historyCount: 1,
                    InputData: 0,
                    dwKeyStates: 0,
                    PerformanceCount: 0,
                    ButtonChangeType: button_change,
                },
                penFlags: pen_flags,
                penMask: PEN_MASK_PRESSURE | PEN_MASK_ROTATION | PEN_MASK_TILT_X | PEN_MASK_TILT_Y,
                pressure,
                rotation: event.twist as u32,
                tiltX: event.tilt_x,
                tiltY: event.tilt_y,
            };

            let result = InjectSyntheticPointerInput(self.device_handle, &pointer_type_info, 1);
            if result == 0 {
                let err = GetLastError();
                warn!(
                    "InjectSyntheticPointerInput failed (err={err}, flags=0x{pointer_flags:08X}, type={:?}, pos=({x},{y}))",
                    event.event_type
                );
            } else {
                trace!("Inject: {:?} ({x},{y}) p={pressure}", event.event_type);
            }
        }
    }

    pub fn move_mouse_relative(&self, event: &RelativeMouseMoveEvent) {
        if event.dx == 0 && event.dy == 0 {
            return;
        }

        self.send_mouse_input(event.dx, event.dy, 0, MOUSEEVENTF_MOVE);
    }

    pub fn scroll_wheel(&self, event: &WheelEvent) {
        if event.dy != 0 {
            self.send_mouse_input(0, 0, event.dy as DWORD, MOUSEEVENTF_WHEEL);
        }
        if event.dx != 0 {
            self.send_mouse_input(0, 0, event.dx as DWORD, MOUSEEVENTF_HWHEEL);
        }
    }

    pub fn zoom(&self, event: &ZoomEvent) {
        if event.delta == 0 {
            return;
        }

        unsafe {
            let mut input: INPUT = std::mem::zeroed();
            input.type_ = INPUT_MOUSE;
            *input.u.mi_mut() = MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: event.delta as DWORD,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            };

            let sent = SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);
            if sent != 1 {
                let err = GetLastError();
                warn!("SendInput zoom failed (err={err}, delta={})", event.delta);
            }
        }
    }

    pub fn set_zoom_modifier(&self, event: &ZoomStateEvent) {
        if self.zoom_modifier_active.get() == event.active {
            return;
        }

        let flags = if event.active { 0 } else { KEYEVENTF_KEYUP };
        if self.send_keyboard_input(VK_CONTROL as WORD, flags) {
            self.zoom_modifier_active.set(event.active);
        }
    }

    pub fn click_mouse_button(&self, event: &MouseClickEvent) {
        match event.button {
            Button::PRIMARY => {
                self.send_mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN);
                self.send_mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP);
            }
            Button::SECONDARY => {
                self.send_mouse_input(0, 0, 0, MOUSEEVENTF_RIGHTDOWN);
                self.send_mouse_input(0, 0, 0, MOUSEEVENTF_RIGHTUP);
            }
            _ => {}
        }
    }

    pub fn set_mouse_button(&self, event: &MouseButtonEvent) {
        let flags = if event.button.contains(Button::PRIMARY) {
            if event.pressed {
                MOUSEEVENTF_LEFTDOWN
            } else {
                MOUSEEVENTF_LEFTUP
            }
        } else if event.button.contains(Button::SECONDARY) {
            if event.pressed {
                MOUSEEVENTF_RIGHTDOWN
            } else {
                MOUSEEVENTF_RIGHTUP
            }
        } else {
            return;
        };

        self.send_mouse_input(0, 0, 0, flags);
    }

    fn send_mouse_input(&self, dx: i32, dy: i32, mouse_data: DWORD, flags: DWORD) {
        unsafe {
            let mut input: INPUT = std::mem::zeroed();
            input.type_ = INPUT_MOUSE;
            *input.u.mi_mut() = MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            };

            if SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32) == 0 {
                let err = GetLastError();
                warn!(
                    "SendInput failed (err={err}, flags=0x{flags:08X}, dx={dx}, dy={dy}, data={mouse_data})"
                );
            }
        }
    }

    fn send_keyboard_input(&self, virtual_key: WORD, flags: DWORD) -> bool {
        unsafe {
            let mut input: INPUT = std::mem::zeroed();
            input.type_ = INPUT_KEYBOARD;
            *input.u.ki_mut() = KEYBDINPUT {
                wVk: virtual_key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            };

            if SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32) == 0 {
                let err = GetLastError();
                warn!("SendInput keyboard failed (err={err}, vk={virtual_key}, flags=0x{flags:08X})");
                false
            } else {
                true
            }
        }
    }
}

impl Drop for PenInjector {
    fn drop(&mut self) {
        if self.zoom_modifier_active.get() {
            let _ = self.send_keyboard_input(VK_CONTROL as WORD, KEYEVENTF_KEYUP);
            self.zoom_modifier_active.set(false);
        }
        unsafe {
            DestroySyntheticPointerDevice(self.device_handle);
        }
    }
}
