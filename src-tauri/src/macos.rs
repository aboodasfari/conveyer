//! Native window tweaks that aren't exposed via tauri.conf.json.
//!
//! Right now: positioning the macOS traffic-light buttons so they line up
//! vertically with our custom 48 px header. The `trafficLightPosition` config
//! field is unreliable on modern macOS, so we set the frame origin via the
//! Cocoa runtime instead.

#[cfg(target_os = "macos")]
pub fn position_traffic_lights(window: &tauri::WebviewWindow, x: f64, y: f64) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use cocoa::foundation::NSPoint;
    use objc::{msg_send, sel, sel_impl};

    let ns_window_ptr: id = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };

    let buttons = [
        NSWindowButton::NSWindowCloseButton,
        NSWindowButton::NSWindowMiniaturizeButton,
        NSWindowButton::NSWindowZoomButton,
    ];

    unsafe {
        for (i, btn_kind) in buttons.iter().enumerate() {
            let btn: id = ns_window_ptr.standardWindowButton_(*btn_kind);
            if btn.is_null() {
                continue;
            }
            // Standard inter-button spacing on macOS is ~20 px.
            let origin = NSPoint::new(x + (i as f64) * 20.0, y);
            let _: () = msg_send![btn, setFrameOrigin: origin];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn position_traffic_lights(_window: &tauri::WebviewWindow, _x: f64, _y: f64) {}
