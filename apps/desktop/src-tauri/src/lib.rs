pub mod adapters;
pub mod adfs;
pub mod assistant;
pub mod agents;
pub mod brand;
pub mod commands;
pub mod diagnostics;
pub mod dictation;
pub mod error;
pub mod fsguard;
pub mod gitcli;
pub mod gitignore_tree;
pub mod hub;
pub mod ipc_server;
pub mod logging;
pub mod persistence;
pub mod platform;
pub mod pty;
pub mod quickopen;
pub mod settings;
pub mod textfile;
pub mod watcher;
pub mod workspace;

use tauri::{Emitter, Manager, State};

use error::AppResult;
use gitignore_tree::GitignoreTreeCache;
use persistence::StateStore;
use quickopen::QuickOpenIndex;
use settings::SettingsStore;
use watcher::WatcherRegistry;
use workspace::WorkspaceStore;

/// Returns the whole in-memory state (see [`StateStore::snapshot`]) — the in-memory
/// copy is the single source of truth once the app has started, not the file on disk.
#[tauri::command]
fn load_state(store: State<'_, StateStore>) -> serde_json::Value {
    store.snapshot()
}

/// Faz 2 §1: replaces the old whole-file `save_state`. Only ever replaces the named
/// top-level slice (`obj[key] = value`, no deep merge) and persists the whole object —
/// so two independent writers (e.g. the frontend's `"layout"` slice and Rust's own
/// `"workspaces"` slice) can never clobber each other.
#[tauri::command]
fn save_state_slice(
    store: State<'_, StateStore>,
    key: String,
    value: serde_json::Value,
) -> AppResult<()> {
    store
        .set_slice(&key, value)
        .map_err(|e| error::AppError::io(e.to_string()))
}

/// M1: the hub supervisor's view of the background service.
#[tauri::command]
fn hub_status(supervisor: State<'_, hub::supervisor::HubSupervisor>) -> hub::supervisor::HubStatus {
    supervisor.status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Faz 7 §9.1/§9.2: the panic hook is the very first statement of `run()` — installed
    // before the logger is even attached, so a panic during Tauri's own startup still
    // gets *some* handling (the log line is simply lost if it fires before the logger
    // plugin's setup runs; every panic once the app is up does not).
    logging::install_panic_hook();
    // U-3: before anything reads the environment (and while still single-threaded): a
    // Finder/Dock start on macOS gets the login shell's PATH, so agents, git and the hub
    // (started below with this environment) are found.
    let login_path = platform::login_path::apply();
    logging::mark_start();
    // After a rename: move the legacy-named data folders before anything reads them
    // (logged once the logger is attached, in `.setup()`).
    let brand_migrations = brand::migrate_legacy_data();

    // Faz 7 §9.1 acceptance: read whatever the *previous* session logged, before this
    // session's own logger attaches (still `Append`-only — see `RotatingFile::open_file`
    // — so nothing here is destructive either way). `.corrupt`/missing-file cases both
    // just mean "no previous session". Rotation can happen mid-session (see
    // `read_previous_log_contents_all`'s doc comment), so this reads every log file, not
    // just the current `kotilo.log` — the previous session's `--- start` may already
    // have been rotated out of the active file by the time this runs.
    let previous_session_unclean =
        logging::previous_session_unclean(&logging::read_previous_log_contents_all(&logging::log_dir()));

    // Faz 7 §9.4: `Reload` (any `Started` page-load event on "main" other than the very
    // first one) kills every running pane — tracked here since `on_page_load` only gets
    // a `Webview` reference, not enough on its own to distinguish "app just started" from
    // "the user (or the crash-loop recovery screen) reloaded".
    let main_first_load_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let builder = platform::app_lifecycle::configure(tauri::Builder::default());
    builder
        // Faz 7 §9.1: registered first — its own `.setup()` runs, and attaches the
        // global logger, before the app-level `.setup()` below (where every store now
        // loads) ever starts.
        .plugin(logging::plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // M2b: the dictation overlay places itself; never restore it (it would reappear).
                // M6: the mascot window places itself too. M7: so does the assistant popup.
                .with_denylist(&[
                    platform::dictation::OVERLAY_LABEL,
                    platform::mascot::MASCOT_LABEL,
                    platform::assistant::ASSISTANT_LABEL,
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // M5: self-update. Only the app's own `update_*` commands use it (no JS permissions).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::update::PendingUpdate::default())
        .manage(pty::PtyRegistry::default())
        .manage(WatcherRegistry::default())
        .manage(agents::AgentTracker::new())
        .manage(QuickOpenIndex::default())
        .manage(GitignoreTreeCache::default())
        .manage(hub::supervisor::HubSupervisor::default())
        .manage(platform::mascot::Mascot::default())
        .manage(platform::assistant::Assistant::default())
        .manage(assistant::chat::ChatSlot::default())
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            if !main_first_load_done.swap(true, std::sync::atomic::Ordering::SeqCst) {
                // The very first "Started" event for "main" is the app's own initial
                // load, not a reload — nothing to tear down yet.
                return;
            }
            log::info!("reload: killing all panes");
            if let Some(registry) = webview.try_state::<pty::PtyRegistry>() {
                // Faz 8 / M3: an agent pane with a close sequence (Claude Code, or its
                // adapter.json `gracefulClose`) gets a graceful close (its own background thread)
                // instead of the immediate kill every other pane still gets here — this
                // must never block the reload itself, so the returned per-pane completion
                // receivers are simply dropped; the threads keep running detached.
                let tracker = webview.try_state::<agents::AgentTracker>();
                let _ = registry.clear_with(|pane_id| {
                    tracker.as_ref().and_then(|t| t.close_plan(pane_id))
                });
            }
            if let Some(tracker) = webview.try_state::<agents::AgentTracker>() {
                tracker.clear_all();
            }
            let _ = webview.emit("agents:changed", Vec::<agents::Agent>::new());
        })
        // M2b: the hidden dictation overlay must not keep the app alive once the main
        // window is gone.
        .on_window_event(|window, event| {
            // M7: closing the assistant popup (Alt+F4) only hides it; the page state goes
            // with `assistant:closed`. Hidden off this (UI) thread.
            if window.label() == platform::assistant::ASSISTANT_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn_blocking(move || app.state::<platform::assistant::Assistant>().hide(&app));
                }
                return;
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(overlay) = window.app_handle().get_webview_window(platform::dictation::OVERLAY_LABEL) {
                    let _ = overlay.destroy();
                }
                // M6: stop the mascot's threads and close its window.
                let app = window.app_handle();
                app.state::<platform::mascot::Mascot>().shutdown(app);
                // M7: the hidden assistant popup must not keep the app alive either.
                app.state::<platform::assistant::Assistant>().shutdown(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::dialog::pick_folders,
            load_state,
            save_state_slice,
            pty::pty_profiles,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_write_bytes,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_busy,
            pty::pty_stop_leftovers,
            pty::pty_processes,
            commands::agents::agents_list,
            commands::agents::agent_ack,
            commands::agents::agent_set_focus,
            commands::agents::agents_definitions,
            commands::agents::agents_definitions_reload,
            commands::agents::agents_installed,
            commands::agents::agents_save_user_definition,
            commands::agents::agents_delete_user_definition,
            commands::agents::pane_send_keys,
            commands::hooks::hooks_status,
            commands::hooks::hooks_install,
            commands::hooks::hooks_uninstall,
            hub_status,
            commands::hub::hub_request,
            commands::hub::hub_export,
            commands::dictation::dictation_reload,
            commands::dictation::dictation_cancel,
            commands::dictation::dictation_status,
            commands::dictation::dictation_start_composer,
            commands::dictation::dictation_stop_composer,
            commands::mascot::mascot_set_config,
            commands::mascot::mascot_update,
            commands::mascot::mascot_ready,
            commands::mascot::mascot_clicked,
            commands::mascot::mascot_context_menu,
            commands::mascot::mascot_drag,
            commands::mascot::mascot_drag_end,
            commands::assistant::assistant_set_config,
            commands::assistant::assistant_open,
            commands::assistant::assistant_hide,
            commands::assistant::assistant_info,
            commands::assistant::assistant_chat,
            commands::assistant::assistant_stop,
            commands::app::app_info,
            commands::app::terminal_font_suggestion,
            commands::app::terminal_wt_schemes,
            commands::app::taskbar_set_badge,
            commands::update::update_check,
            commands::update::update_install,
            commands::workspace::workspace_list,
            commands::workspace::workspace_add,
            commands::workspace::workspace_remove,
            commands::workspace::workspace_rename,
            commands::workspace::workspace_reorder,
            commands::workspace::workspace_set_active,
            commands::workspace::workspace_set_expanded,
            commands::fs::fs_read_dir,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_reveal,
            commands::fs::fs_read_text,
            commands::fs::fs_write_text,
            commands::fs::fs_stat,
            commands::fs::fs_exists,
            commands::fs::fs_read_bytes,
            commands::fs::fs_open_default,
            commands::fs::open_external_url,
            commands::clipboard::clipboard_save_image,
            commands::clipboard::clipboard_write_text,
            commands::clipboard::clipboard_read_text,
            commands::fs::fs_resolve_link,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::git::git_head,
            commands::git::git_changes,
            commands::git::git_show_head,
            commands::diagnostics::diagnostics_collect,
            commands::diagnostics::diagnostics_open_logs,
            quickopen::fs_quick_open,
        ])
        .register_asynchronous_uri_scheme_protocol("adfs", adfs::handler)
        .setup(move |app| {
            // Faz 7 §9.1: `StateStore`/`WorkspaceStore`/`SettingsStore` load here, inside
            // `.setup()` — AFTER the log plugin's own setup already attached the global
            // logger (plugins initialize before this closure runs) — so a corrupt
            // `state.json`/`settings.json` (see `persistence::load_json_from`) always has
            // somewhere to log its `.corrupt` line to.
            brand::log_migrations(&brand_migrations);
            if login_path != platform::login_path::Outcome::Skipped {
                log::info!("login shell PATH: {login_path:?}");
            }
            let state_store = StateStore::load();
            let workspace_store = WorkspaceStore::load_from_state_store(&state_store);
            // Snapshot the roots to watch *before* moving the store into `.manage()`.
            let initial_roots = workspace_store.roots();
            let settings_store = SettingsStore::load();
            let verbose_logging = settings_store.get().diagnostics.verbose_logging;
            // Faz 7 §9.1: the live level ceiling, applied at startup too (not just on a
            // later `settings_set`).
            logging::apply_verbose_logging(verbose_logging);
            // D-055: before any terminal exists – picks the bundled or the system ConPTY.
            platform::conpty::select(settings_store.get().terminal.bundled_conpty);

            let appearance = settings_store.get().appearance;

            app.manage(state_store);
            app.manage(workspace_store);
            app.manage(settings_store);
            // D-056: emits `user:returned` when input resumes after a long absence.
            platform::idle::start_watcher(app.handle().clone());

            // D18 (moved to `platform::webview` in M7, shared with the assistant popup).
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = platform::webview::disable_browser_accelerator_keys(&window) {
                    log::warn!("WebView2 browser accelerator keys could not be disabled: {err}");
                }
                // D-065: the page paints the translucent background itself (`main.tsx`).
                platform::window_backdrop::apply(&window, appearance.acrylic && appearance.is_translucent());
            }

            // M1: the hub background service (ingest, adapters, usage). Hooks still reach
            // this app directly over the named pipe below for live pane state.
            // M3: adapter definitions (built-in resources + user files) feed detection,
            // graceful close and screen rules; the hub reads the same built-in folder.
            let adapter_dirs = adapters::AdapterDirs {
                builtin: adapters::builtin_dir(app.path().resource_dir().ok().as_deref()),
                user: Some(adapters::user_dir()),
            };
            if adapter_dirs.builtin.is_none() {
                log::warn!("adapters: built-in definitions not found");
            }
            app.state::<agents::AgentTracker>().set_definitions(adapter_dirs.load());
            let builtin_adapters = adapter_dirs.builtin.clone();
            app.manage(adapter_dirs);

            let app_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(std::path::Path::to_path_buf));
            let hub_exe = hub::locate_hub_exe(&|k| std::env::var(k).ok(), app_dir.as_deref());
            app.state::<hub::supervisor::HubSupervisor>().start(hub_exe, app_dir, builtin_adapters);
            if let Some(data_dir) = hub::data_dir(&|k| std::env::var(k).ok()) {
                hub::stream::spawn(app.handle().clone(), data_dir);
            }

            // M7: one app-wide global hotkey thread (dictation + assistant); before dictation
            // starts, which installs its handler on it.
            app.manage(platform::hotkeys::Hotkeys::start());
            platform::assistant::Assistant::install_hotkey(app.handle());

            // M2b: live dictation (global hotkey, microphone, overlay). Needs the hub for
            // transcription; the hotkeys register once the hub settings load.
            commands::dictation::start(app.handle());

            // Faz 5 §1.3: named pipe hook endpoint, one per app process
            // (`\\.\pipe\agenthub-<pid>`), started in the background for the whole app
            // lifetime.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(ipc_server::run(app_handle));

            // Faz 5 §1.4: the agent tracker's periodic tick/emit loop.
            let app_handle_agents = app.handle().clone();
            tauri::async_runtime::spawn(agents::run_loop(app_handle_agents));

            // Faz 2 §5: start the watcher for every registered workspace at launch.
            // A root that no longer exists on disk is skipped (`WatcherRegistry::start`
            // logs and no-ops) rather than removing the workspace from the list.
            let watchers = app.state::<WatcherRegistry>();
            for (workspace_id, path) in initial_roots {
                watchers.start(app.handle().clone(), workspace_id, path);
            }

            // Faz 7 §9.1: the `--- start` marker (+ the previous-session clean-exit
            // check) — logged last, now that every store/service above is up, using the
            // exact same `app_info` fields the About section and diagnostics zip use.
            let info = commands::app::app_info(app.handle().clone()).unwrap_or_else(|_| commands::app::AppInfo {
                os_build: 0,
                version: app.package_info().version.to_string(),
                git_sha: env!("AGENTHUB_GIT_SHA").to_string(),
                webview2: "unknown".to_string(),
                os: commands::app::os_label(crate::platform::os_id(), None),
                build_date: env!("AGENTHUB_BUILD_DATE").to_string(),
                ..commands::app::brand_info()
            });
            let level_label = if verbose_logging { "debug" } else { "info" };
            log::info!(
                "{}",
                logging::start_message(std::process::id(), &info.version, &info.git_sha, &info.os, &info.webview2, level_label)
            );
            if previous_session_unclean {
                log::warn!("previous session ended without clean exit");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            platform::app_lifecycle::on_run_event(app, &event);
            // Faz 4 §4.20: on app exit, drop every PTY pane — closing each one's Job
            // Object handle (D8) kills every subprocess tree (`pwsh`, `claude`, ...)
            // still alive, rather than leaving them running after the window closes.
            if let tauri::RunEvent::Exit = event {
                shutdown(app);
            }
        });
}

/// Faz 4 §4.20 / M5: app shutdown work — on `RunEvent::Exit`, and from the updater right before
/// it starts the installer and exits the process (no `RunEvent::Exit` then).
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    // Review item 6: the `--- exit` marker is written and flushed BEFORE the
    // (up to `EXIT_GRACEFUL_CAP`) graceful-close wait below, not after it — a
    // relaunch that happens during that wait must see this session's own
    // clean exit already on disk, not report it as `previous session ended
    // without clean exit` just because it raced the wait.
    log::info!("{}", logging::exit_message(std::process::id()));
    log::logger().flush();
    platform::hook_endpoint::remove(&ipc_server::endpoint_name(std::process::id()));

    if let Some(registry) = app.try_state::<pty::PtyRegistry>() {
        // Faz 8 / M3: every agent pane with a close sequence gets a graceful close, all running in
        // parallel (one background thread each); every other pane keeps the
        // pre-existing immediate kill. Exit blocks on the graceful ones, but
        // never longer than `EXIT_GRACEFUL_CAP` combined — a hung pane must
        // never hang app shutdown itself, so this waits on completion
        // receivers (each with its own remaining share of the deadline)
        // rather than `JoinHandle::join`, which has no timeout.
        let tracker = app.try_state::<agents::AgentTracker>();
        let mut waiters = registry.clear_with(|pane_id| {
            tracker.as_ref().and_then(|t| t.close_plan(pane_id))
        });
        // Review item 5: a graceful close started earlier by a plain tab
        // close (`pty_kill`) may still be in flight — `clear_with` above only
        // ever sees panes still in the registry at exit time, not one
        // `pty_kill` already handed off to its own background thread before
        // that.
        waiters.extend(registry.take_pending_graceful_closes());
        let deadline = std::time::Instant::now() + pty::EXIT_GRACEFUL_CAP;
        for rx in waiters {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let _ = rx.recv_timeout(remaining);
        }
    }
    // Faz 7 §9.1 / review item 6: final flush — the wait above may have
    // logged more (e.g. a pane's own "graceful close: exited=..." line), so
    // this must run last, after the wait, not just once right after the
    // marker above.
    log::logger().flush();
}
