//! Window discovery on Windows.
//!
//! On Windows this module enumerates top-level visible windows, extracts
//! metadata (title, PID, process name, bounds, focus state), classifies
//! known browsers, and returns the results with window refs scoped to a
//! fresh state ID.
//!
//! On non-Windows platforms all entry points return a deterministic
//! `unsupported_platform` error.

use serde_json::Value;
#[cfg(windows)]
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

use crate::error::{ErrorCode, ProtocolError};
use crate::refs::RefStore;

#[cfg(windows)]
use crate::refs::NativeHandle;
#[cfg(windows)]
use crate::state::StateId;
#[cfg(windows)]
use serde_json::json;

// ---------------------------------------------------------------------------
// Browser classification  (cross-platform)
// ---------------------------------------------------------------------------

/// Classify a process name as one of the known browser families.
///
/// Returns `(is_browser, browser_family)` where `browser_family` is one of
/// `"chrome"`, `"edge"`, `"brave"`, or `None`.
///
/// Matching is case-insensitive and strips the `.exe` suffix when present.
pub fn classify_browser(process_name: &str) -> (bool, Option<&'static str>) {
    // Example inputs:  "chrome.exe", "msedge.exe", "NOTEPAD.EXE", "firefox"
    let lower = process_name.to_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    match stem {
        "chrome" | "chromium" => (true, Some("chrome")),
        "msedge" | "edge" => (true, Some("edge")),
        "brave" | "brave-browser" => (true, Some("brave")),
        "firefox" => (true, Some("firefox")),
        "vivaldi" => (true, Some("vivaldi")),
        "opera" | "opera_gx" => (true, Some("opera")),
        _ => (false, None),
    }
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

/// Enumerate visible top-level windows and return a JSON response value.
///
/// On non-Windows this always returns `UnsupportedPlatform`.
/// On Windows it enumerates visible top-level windows, inserts their native
/// handles into `store`, and returns a fresh stateId along with per-window
/// metadata.
///
/// If `filter_pid` is `Some(pid)`, only windows belonging to the given
/// process are returned. When `filter_pid` is `None`, all visible windows
/// are enumerated (used by the TypeScript `listApps` fallback).
pub fn list_windows(store: &mut RefStore, filter_pid: Option<u64>) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store; // unused on non-Windows
        let _ = filter_pid;
        Err(ProtocolError::new(
            "Window discovery is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        list_windows_impl(store, filter_pid)
    }
}

// ---------------------------------------------------------------------------
// Windows-specific implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
use std::{thread, time::Duration};
#[cfg(windows)]
use windows::core::PWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT, TRUE};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
#[cfg(windows)]
use windows::Win32::UI::HiDpi::GetDpiForWindow;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetForegroundWindow, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_HIDE, EVENT_SYSTEM_FOREGROUND, GA_ROOT, GWL_EXSTYLE, GW_OWNER, MSG,
    WINEVENT_OUTOFCONTEXT, WS_EX_DLGMODALFRAME,
};

#[cfg(windows)]
const ROOT_EVENT_CAPACITY: usize = 256;

#[cfg(windows)]
#[derive(Clone)]
struct JournalEvent {
    sequence: u64,
    pid: u64,
    payload: Value,
}

#[cfg(windows)]
#[derive(Default)]
struct RootEventJournal {
    events: VecDeque<JournalEvent>,
    roots: HashMap<isize, Value>,
}

#[cfg(windows)]
fn event_journal() -> &'static Mutex<RootEventJournal> {
    static JOURNAL: OnceLock<Mutex<RootEventJournal>> = OnceLock::new();
    JOURNAL.get_or_init(|| Mutex::new(RootEventJournal::default()))
}

#[cfg(windows)]
fn event_sequence() -> &'static AtomicU64 {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    &SEQUENCE
}

/// Start the WinEvent message pump used as an acceleration and transient-root
/// journal. Final root snapshots remain authoritative.
pub fn start_root_event_journal() {
    #[cfg(windows)]
    std::thread::spawn(|| unsafe {
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(root_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let objects = SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_HIDE,
            None,
            Some(root_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if foreground.is_invalid() && objects.is_invalid() {
            return;
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}
    });
}

pub fn root_event_cursor() -> u64 {
    #[cfg(windows)]
    {
        event_sequence().load(Ordering::Acquire)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

pub fn root_events_since(cursor: u64, pid: u64) -> Vec<Value> {
    #[cfg(windows)]
    {
        event_journal()
            .lock()
            .map(|journal| {
                journal
                    .events
                    .iter()
                    .filter(|event| event.sequence > cursor && event.pid == pid)
                    .map(|event| event.payload.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (cursor, pid);
        Vec::new()
    }
}

#[cfg(windows)]
unsafe extern "system" fn root_event_callback(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object_id: i32,
    child_id: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.0.is_null() || (event != EVENT_SYSTEM_FOREGROUND && (object_id != 0 || child_id != 0)) {
        return;
    }
    if event != EVENT_OBJECT_DESTROY && GetAncestor(hwnd, GA_ROOT) != hwnd {
        return;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return;
    }
    let raw = hwnd.0 as isize;
    let mut journal = match event_journal().lock() {
        Ok(journal) => journal,
        Err(_) => return,
    };
    let change = match event {
        EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE => "closed",
        EVENT_SYSTEM_FOREGROUND => "focused",
        _ => "appeared",
    };
    let root = if change == "closed" {
        journal.roots.remove(&raw).unwrap_or_else(|| {
            json!({
                "kind": "window", "title": "", "pid": pid, "windowId": raw
            })
        })
    } else {
        let root = event_root_payload(hwnd, pid);
        journal.roots.insert(raw, root.clone());
        root
    };
    let sequence = event_sequence().fetch_add(1, Ordering::AcqRel) + 1;
    let payload = json!({
        "change": change,
        "kind": root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        "title": root.get("title").and_then(Value::as_str).unwrap_or(""),
        "pid": pid,
        "isModal": root.get("isModal").and_then(Value::as_bool).unwrap_or(false),
        "metadata": root.get("metadata").cloned().unwrap_or_else(|| json!({}))
    });
    journal.events.push_back(JournalEvent {
        sequence,
        pid: u64::from(pid),
        payload,
    });
    while journal.events.len() > ROOT_EVENT_CAPACITY {
        journal.events.pop_front();
    }
}

#[cfg(windows)]
unsafe fn event_root_payload(hwnd: HWND, pid: u32) -> Value {
    let class_name = get_window_class(hwnd);
    let title = get_window_title(hwnd);
    let owner = GetWindow(hwnd, GW_OWNER).ok();
    let kind = if class_name == "#32768" {
        "menu"
    } else if class_name == "#32770" {
        "dialog"
    } else if owner.map(|owner| !owner.0.is_null()).unwrap_or(false) {
        "popover"
    } else {
        "window"
    };
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    json!({
        "kind": kind,
        "title": title,
        "pid": pid,
        "windowId": hwnd.0 as isize,
        "isModal": class_name == "#32770" || (ex_style & WS_EX_DLGMODALFRAME.0) != 0,
        "metadata": { "className": class_name, "exStyle": ex_style }
    })
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let handles = &mut *(lparam.0 as *mut Vec<HWND>);
    handles.push(hwnd);
    TRUE
}

#[cfg(windows)]
unsafe fn get_window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(windows)]
unsafe fn get_window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(windows)]
unsafe fn get_process_name_by_pid(pid: u32) -> String {
    let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(handle) => handle,
        Err(_) => return String::new(),
    };

    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        Default::default(),
        PWSTR(buf.as_mut_ptr()),
        &mut size,
    )
    .is_ok();
    let _ = CloseHandle(handle);

    if !ok || size == 0 {
        return String::new();
    }

    let full_path = String::from_utf16_lossy(&buf[..size as usize]);
    std::path::Path::new(&full_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(full_path)
}

#[cfg(windows)]
unsafe fn get_window_bounds_json(hwnd: HWND) -> Value {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return json!({ "x": 0, "y": 0, "width": 0, "height": 0 });
    }
    json!({
        "x": rect.left,
        "y": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    })
}

#[cfg(windows)]
fn list_windows_impl(
    store: &mut RefStore,
    filter_pid: Option<u64>,
) -> Result<Value, ProtocolError> {
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut hwnds as *mut Vec<HWND> as isize),
        )
        .map_err(|e| {
            ProtocolError::new(format!("EnumWindows failed: {e}"), ErrorCode::InternalError)
        })?;
    }

    let foreground = unsafe { GetForegroundWindow() };
    let mut windows_info = Vec::new();

    for hwnd in hwnds {
        if !unsafe { IsWindowVisible(hwnd).as_bool() } {
            continue;
        }

        let title = unsafe { get_window_title(hwnd) };
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }

        if let Some(requested_pid) = filter_pid {
            if u64::from(pid) != requested_pid {
                continue;
            }
        }

        let process_name = if pid != 0 {
            unsafe { get_process_name_by_pid(pid) }
        } else {
            String::new()
        };
        let bounds = unsafe { get_window_bounds_json(hwnd) };
        let class_name = unsafe { get_window_class(hwnd) };
        let (is_browser, browser_family) = classify_browser(&process_name);
        let wref = store.insert_window(NativeHandle::new(hwnd.0 as isize));
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let scale_factor = if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 };
        let owner = unsafe { GetWindow(hwnd, GW_OWNER).ok() };
        let is_minimized = unsafe { IsIconic(hwnd).as_bool() };
        let kind = if class_name == "#32768" {
            "menu"
        } else if class_name == "#32770" {
            "dialog"
        } else if owner.map(|hwnd| !hwnd.0.is_null()).unwrap_or(false) {
            "popover"
        } else {
            "window"
        };
        let role = if kind == "menu" { "Menu" } else { "Window" };
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let is_modal = class_name == "#32770" || (ex_style & WS_EX_DLGMODALFRAME.0) != 0;

        windows_info.push(json!({
            "kind": kind,
            "rootRef": wref.to_string(),
            "windowRef": wref.to_string(),
            "ref": wref.to_string(),
            "windowId": hwnd.0 as isize,
            "title": title,
            "pid": pid,
            "appName": process_name.trim_end_matches(".exe"),
            "processName": process_name,
            "role": role,
            "subrole": class_name,
            "zOrder": windows_info.len(),
            "framePoints": bounds,
            "bounds": bounds,
            "scaleFactor": scale_factor,
            "isFocused": hwnd == foreground,
            "isMain": hwnd == foreground,
            "isMinimized": is_minimized,
            "isOnscreen": !is_minimized,
            "isModal": is_modal,
            "metadata": { "className": class_name, "exStyle": ex_style, "isBrowser": is_browser, "browserFamily": browser_family },
            "isBrowser": is_browser,
            "browserFamily": browser_family,
        }));
    }

    Ok(json!({
        "stateId": StateId::fresh("w"),
        "windows": windows_info,
        "roots": windows_info,
    }))
}

pub fn foreground_pid() -> Option<u64> {
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        (pid != 0).then_some(u64::from(pid))
    }
}

pub fn focus_window(
    store: &RefStore,
    target_ref: &crate::refs::WindowRef,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = target_ref;
        Err(ProtocolError::new(
            "Window focus is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        let native = store.get_window(target_ref).ok_or_else(|| {
            ProtocolError::new(
                format!("Window ref '{}' not found", target_ref),
                ErrorCode::TargetNotFound,
            )
        })?;
        let hwnd = HWND(native.raw() as *mut _);
        let already_focused = unsafe { GetForegroundWindow() == hwnd };
        let focused = already_focused || unsafe { SetForegroundWindow(hwnd).as_bool() };
        Ok(json!({ "focused": focused, "alreadyFocused": already_focused }))
    }
}

/// Bring an HWND to the foreground and confirm ownership before physical input.
/// Windows can reject SetForegroundWindow, so success is based on observation,
/// not the API's advisory return value.
pub fn ensure_foreground(hwnd: isize) -> Result<(), ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        Err(ProtocolError::new(
            "Window focus is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }
    #[cfg(windows)]
    {
        let target = HWND(hwnd as *mut _);
        for _ in 0..4 {
            if unsafe { GetForegroundWindow() == target } {
                return Ok(());
            }
            let _ = unsafe { SetForegroundWindow(target) };
            thread::sleep(Duration::from_millis(20));
        }
        if unsafe { GetForegroundWindow() == target } {
            Ok(())
        } else {
            Err(ProtocolError::new(
                "Windows refused to foreground the target; physical input was not sent",
                ErrorCode::TargetNotFound,
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::error::ErrorCode;

    // -- Browser classification (cross-platform) ----------------------------

    #[test]
    fn test_classify_browser_chrome_exe() {
        let (is_browser, family) = classify_browser("chrome.exe");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_chromium_exe() {
        let (is_browser, family) = classify_browser("chromium.exe");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_chrome_no_ext() {
        // Some process names may not include .exe
        let (is_browser, family) = classify_browser("chrome");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    #[test]
    fn test_classify_browser_edge_exe() {
        let (is_browser, family) = classify_browser("msedge.exe");
        assert!(is_browser);
        assert_eq!(family, Some("edge"));
    }

    #[test]
    fn test_classify_browser_edge_no_ext() {
        let (is_browser, family) = classify_browser("edge");
        assert!(is_browser);
        assert_eq!(family, Some("edge"));
    }

    #[test]
    fn test_classify_browser_brave_exe() {
        let (is_browser, family) = classify_browser("brave.exe");
        assert!(is_browser);
        assert_eq!(family, Some("brave"));
    }

    #[test]
    fn test_classify_browser_brave_browser_exe() {
        let (is_browser, family) = classify_browser("brave-browser.exe");
        assert!(is_browser);
        assert_eq!(family, Some("brave"));
    }

    #[test]
    fn test_classify_browser_not_a_browser() {
        let (is_browser, family) = classify_browser("notepad.exe");
        assert!(!is_browser);
        assert_eq!(family, None);
    }

    #[test]
    fn test_classify_browser_empty_string() {
        let (is_browser, family) = classify_browser("");
        assert!(!is_browser);
        assert_eq!(family, None);
    }

    #[test]
    fn test_classify_browser_case_insensitive() {
        let (is_browser, family) = classify_browser("CHROME.EXE");
        assert!(is_browser);
        assert_eq!(family, Some("chrome"));
    }

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_list_windows_unsupported_platform() {
        let mut store = RefStore::new();
        let result = list_windows(&mut store, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
    }

    // -- JSON result shape --------------------------------------------------

    #[test]
    fn test_list_windows_result_shape_on_windows() {
        // On non-Windows this just verifies the error path works.
        #[cfg(not(windows))]
        {
            let mut store = RefStore::new();
            let result = list_windows(&mut store, None);
            assert!(result.is_err());
        }

        // On Windows we verify the result has the expected fields.
        #[cfg(windows)]
        {
            let mut store = RefStore::new();
            let result = list_windows(&mut store, None);
            assert!(
                result.is_ok(),
                "list_windows should succeed on Windows: {:?}",
                result.err()
            );
            let val = result.unwrap();

            // Top-level fields
            assert!(val.get("stateId").and_then(|v| v.as_str()).is_some());
            assert!(val.get("windows").and_then(|v| v.as_array()).is_some());

            if let Some(windows) = val["windows"].as_array() {
                for w in windows {
                    assert!(w.get("ref").and_then(|v| v.as_str()).is_some());
                    assert!(w.get("title").is_some());
                    assert!(w.get("pid").and_then(|v| v.as_u64()).is_some());
                    assert!(w.get("processName").and_then(|v| v.as_str()).is_some());
                    assert!(w.get("bounds").and_then(|v| v.as_object()).is_some());
                    if let Some(bounds) = w["bounds"].as_object() {
                        assert!(bounds.contains_key("x"));
                        assert!(bounds.contains_key("y"));
                        assert!(bounds.contains_key("width"));
                        assert!(bounds.contains_key("height"));
                    }
                    assert!(w.get("isFocused").and_then(|v| v.as_bool()).is_some());
                    assert!(w.get("isBrowser").and_then(|v| v.as_bool()).is_some());
                    // browserFamily is Option<&str>, so it's either null or a string
                    assert!(w.get("browserFamily").is_some());
                }
            }
        }
    }

    // -- Window refs and state IDs are fresh (Windows-only) -----------------

    #[test]
    #[cfg(windows)]
    fn test_list_windows_produces_unique_state_ids() {
        let mut store_a = RefStore::new();
        let mut store_b = RefStore::new();
        let result_a = list_windows(&mut store_a, None).unwrap();
        let result_b = list_windows(&mut store_b, None).unwrap();

        let id_a = result_a["stateId"].as_str().unwrap().to_owned();
        let id_b = result_b["stateId"].as_str().unwrap().to_owned();
        assert_ne!(
            id_a, id_b,
            "each listWindows call must produce a fresh stateId"
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_list_windows_window_ref_prefix() {
        let mut store = RefStore::new();
        let result = list_windows(&mut store, None).unwrap();
        if let Some(windows) = result["windows"].as_array() {
            for w in windows {
                let wref = w["ref"].as_str().unwrap();
                assert!(
                    wref.starts_with("@w"),
                    "window ref must start with @w, got {wref}"
                );
            }
        }
    }
}
