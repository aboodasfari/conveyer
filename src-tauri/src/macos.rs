//! Native window tweaks that aren't exposed via tauri.conf.json.
//!
//! - `extend_titlebar`: attach an empty NSToolbar so the macOS title bar is
//!   tall enough for the traffic-light cluster to vertically centre against
//!   our 48 px header.
//! - `set_dock_icon`: in `tauri dev` we aren't running from a proper .app
//!   bundle, so macOS uses the default Tauri icon in the Dock. Setting
//!   `NSApplication.applicationIconImage` at runtime fixes that.

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

#[cfg(target_os = "macos")]
pub fn set_dock_icon(png_bytes: &[u8]) {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSData;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let data: id = NSData::dataWithBytes_length_(
            nil,
            png_bytes.as_ptr() as *const std::ffi::c_void,
            png_bytes.len() as u64,
        );
        let alloc: id = msg_send![class!(NSImage), alloc];
        let image: id = msg_send![alloc, initWithData: data];
        if image.is_null() {
            return;
        }
        let app = NSApp();
        let _: () = msg_send![app, setApplicationIconImage: image];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn extend_titlebar(_window: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon(_png_bytes: &[u8]) {}

