//! Native window tweaks that aren't exposed via tauri.conf.json.
//!
//! Attaching an empty NSToolbar bumps the title bar's effective height,
//! which moves the traffic-light cluster down to roughly the centre of our
//! 48 px header. `trafficLightPosition` and direct `setFrameOrigin` both
//! turned out to be unreliable on modern macOS with Overlay style.

#[cfg(target_os = "macos")]
pub fn extend_titlebar(window: &tauri::WebviewWindow) {
    use cocoa::base::{id, nil, NO};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    let ns_window: id = match window.ns_window() {
        Ok(p) => p as id,
        Err(_) => return,
    };

    unsafe {
        let toolbar_class = class!(NSToolbar);
        let alloc: id = msg_send![toolbar_class, alloc];
        let ident: id = NSString::alloc(nil).init_str("conveyer.toolbar");
        let toolbar: id = msg_send![alloc, initWithIdentifier: ident];
        let _: () = msg_send![toolbar, setShowsBaselineSeparator: NO];
        let _: () = msg_send![ns_window, setToolbar: toolbar];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn extend_titlebar(_window: &tauri::WebviewWindow) {}

