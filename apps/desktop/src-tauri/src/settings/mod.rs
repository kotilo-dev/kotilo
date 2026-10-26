//! Faz 6 spec §1: user preferences, persisted to `%APPDATA%\kotilo\settings.json`
//! (a file separate from `state.json` — layout/workspace data must not be able to
//! corrupt user preferences or vice versa). Reuses [`crate::persistence`]'s generic
//! atomic-write + corrupt-backup helpers rather than duplicating them.
//!
//! `SettingsStore` (Tauri managed state) is the single in-process source of truth: it
//! also caches the compiled hidden-name `GlobSet` (§10.13/§10.14 — the walker, the tree
//! listing, and the watcher's own hidden-name check all read it) so a hot path like
//! `fs_read_dir` never recompiles it from the raw pattern strings.

use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::pty::ShellKind;

// ---------------------------------------------------------------------------------
// Model (spec §1.1)
// ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeName {
    #[default]
    Dark,
    Light,
    /// M2: follow the OS light/dark preference (resolved in the UI).
    System,
}

fn default_v() -> u32 {
    1
}

fn default_editor_font_family() -> String {
    "Cascadia Code, Consolas, monospace".to_string()
}

fn default_editor_font_size() -> u32 {
    13
}

fn default_terminal_font_family() -> String {
    "\"Geist Mono\", \"Cascadia Code\", Consolas, monospace".to_string()
}

fn default_terminal_font_size() -> u32 {
    15
}

fn default_true() -> bool {
    true
}

fn default_agent_commands() -> Vec<String> {
    vec!["claude".to_string(), "codex".to_string()]
}

/// Spec §5: the names hidden at every depth by default, kept identical to the Faz 2–5
/// defaults so an existing install's tree doesn't change shape on upgrade.
fn default_hidden_patterns() -> Vec<String> {
    vec![
        ".git".to_string(),
        "node_modules".to_string(),
        "dist".to_string(),
        "target".to_string(),
        ".DS_Store".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default = "default_editor_font_family")]
    pub font_family: String,
    #[serde(default = "default_editor_font_size")]
    pub font_size: u32,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_family: default_editor_font_family(),
            font_size: default_editor_font_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default = "default_terminal_font_family")]
    pub font_family: String,
    #[serde(default = "default_terminal_font_size")]
    pub font_size: u32,
    /// §10.2: read only by the frontend when opening a new terminal (`pty_profiles`
    /// lookup, falling back to automatic) — Rust's own `pty_spawn`/profile selection
    /// logic never reads this field.
    #[serde(default)]
    pub default_shell: Option<ShellKind>,
    #[serde(default)]
    pub copy_on_select: bool,
    #[serde(default = "default_true")]
    pub warn_multiline_paste: bool,
    /// D-055: load Microsoft's bundled ConPTY (`conpty` next to the exe) instead of the one
    /// built into Windows; read once at startup, so a change applies after a restart.
    #[serde(default = "default_true")]
    pub bundled_conpty: bool,
    /// D-057: `"app"` (follow the app theme), a built-in theme id, or `"imported:<name>"`.
    #[serde(default = "default_color_scheme")]
    pub color_scheme: String,
    /// D-057: schemes copied from Windows Terminal (read-only import, see
    /// `platform::wt_settings`).
    #[serde(default)]
    pub imported_schemes: Vec<TerminalScheme>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family: default_terminal_font_family(),
            font_size: default_terminal_font_size(),
            default_shell: None,
            copy_on_select: false,
            warn_multiline_paste: true,
            bundled_conpty: true,
            color_scheme: default_color_scheme(),
            imported_schemes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSettings {
    #[serde(default = "default_agent_commands")]
    pub commands: Vec<String>,
    #[serde(default = "default_true")]
    pub notifications: bool,
    /// D-056: one "while you were away" summary when input resumes after
    /// `away_summary_minutes` without input (`platform::idle`).
    #[serde(default = "default_true")]
    pub away_summary: bool,
    #[serde(default = "default_away_summary_minutes")]
    pub away_summary_minutes: u32,
}

impl Default for AgentsSettings {
    fn default() -> Self {
        Self {
            commands: default_agent_commands(),
            notifications: true,
            away_summary: true,
            away_summary_minutes: default_away_summary_minutes(),
        }
    }
}

fn default_away_summary_minutes() -> u32 {
    10
}

fn default_color_scheme() -> String {
    "app".to_string()
}

fn default_dark_theme() -> String {
    "kotilo-dark".to_string()
}

fn default_light_theme() -> String {
    "kotilo-light".to_string()
}

fn default_window_opacity() -> u32 {
    MAX_WINDOW_OPACITY
}

/// D-057: the colour theme used in dark and in light mode (`theme` picks the mode). Ids come
/// from the UI's built-in catalogue; an unknown id falls back to Kotilo there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    /// D-065: the window background's opacity in percent (Windows Terminal's "Background
    /// opacity"); text stays opaque. 100 = solid.
    #[serde(default = "default_window_opacity")]
    pub window_opacity: u32,
    /// D-065: blur what shows through a translucent window (Windows acrylic).
    #[serde(default)]
    pub acrylic: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            dark_theme: default_dark_theme(),
            light_theme: default_light_theme(),
            window_opacity: default_window_opacity(),
            acrylic: false,
        }
    }
}

impl AppearanceSettings {
    /// Whether anything behind the window shows through (then the window effect applies).
    pub fn is_translucent(&self) -> bool {
        self.window_opacity < MAX_WINDOW_OPACITY
    }
}

/// D-057: a terminal colour scheme (copied from Windows Terminal on import). Colours are
/// `#rrggbb`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalScheme {
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl TerminalScheme {
    /// Every colour field, for validation.
    fn colors_mut(&mut self) -> [&mut String; 20] {
        [
            &mut self.background,
            &mut self.foreground,
            &mut self.cursor,
            &mut self.selection,
            &mut self.black,
            &mut self.red,
            &mut self.green,
            &mut self.yellow,
            &mut self.blue,
            &mut self.magenta,
            &mut self.cyan,
            &mut self.white,
            &mut self.bright_black,
            &mut self.bright_red,
            &mut self.bright_green,
            &mut self.bright_yellow,
            &mut self.bright_blue,
            &mut self.bright_magenta,
            &mut self.bright_cyan,
            &mut self.bright_white,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesSettings {
    #[serde(default = "default_hidden_patterns")]
    pub hidden_patterns: Vec<String>,
    #[serde(default)]
    pub respect_gitignore: bool,
}

impl Default for FilesSettings {
    fn default() -> Self {
        Self {
            hidden_patterns: default_hidden_patterns(),
            respect_gitignore: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSettings {
    #[serde(default = "default_true")]
    pub copy_path_after_image_save: bool,
}

impl Default for ClipboardSettings {
    fn default() -> Self {
        Self {
            copy_path_after_image_save: true,
        }
    }
}

/// Faz 7 spec §6/§9.1: `verboseLogging` toggles the live log level ceiling between
/// `Info` (default) and `Debug` (`log::set_max_level`, applied both at startup and on
/// every `settings_set` — see `logging::apply_verbose_logging`). Missing from an old
/// `settings.json` -> `false`, same as every other field here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSettings {
    #[serde(default)]
    pub verbose_logging: bool,
}

/// M4 composer (DESIGN_SYSTEM §7.6): one user-authored saved prompt. Its `text` is the one
/// piece of prompt content Kotilo keeps at rest – an explicit, user-approved exception to
/// rule 5 (the user writes it here on purpose); it never goes into logs or a diagnostics zip
/// ([`settings_for_diagnostics`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettings {
    #[serde(default)]
    pub saved_prompts: Vec<SavedPrompt>,
    /// The one-time "add `.kotilo/` to `.gitignore`" hint after the first image paste.
    #[serde(default)]
    pub attachments_hint_shown: bool,
}

/// Spec §1.1: missing field -> default (`#[serde(default)]` on every field, recursively);
/// unknown field -> preserved via `extra` (forward compatibility) so a settings.json
/// written by a newer Kotilo version round-trips through an older one unharmed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_v")]
    pub v: u32,
    #[serde(default)]
    pub theme: ThemeName,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub agents: AgentsSettings,
    #[serde(default)]
    pub files: FilesSettings,
    #[serde(default)]
    pub clipboard: ClipboardSettings,
    #[serde(default)]
    pub diagnostics: DiagnosticsSettings,
    #[serde(default)]
    pub composer: ComposerSettings,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            v: default_v(),
            theme: ThemeName::default(),
            appearance: AppearanceSettings::default(),
            editor: EditorSettings::default(),
            terminal: TerminalSettings::default(),
            agents: AgentsSettings::default(),
            files: FilesSettings::default(),
            clipboard: ClipboardSettings::default(),
            diagnostics: DiagnosticsSettings::default(),
            composer: ComposerSettings::default(),
            extra: serde_json::Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------------
// Validation / normalization (spec §1.1) — the one place every field's shape is
// enforced, run on every `settings_set` (and, defensively, once more on load in case a
// hand-edited file slipped an out-of-range value in).
// ---------------------------------------------------------------------------------

const MIN_FONT_SIZE: u32 = 8;
const MAX_FONT_SIZE: u32 = 32;

fn clamp_font_size(size: u32) -> u32 {
    size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE)
}

fn normalize_font_family(family: &str, default: &str) -> String {
    let trimmed = family.trim();
    if trimmed.is_empty() {
        default.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Spec §10.13: a hidden pattern is a **name-only** glob applied to every entry's
/// basename at every depth — no path separators, and not a negation (negation would be
/// meaningless here since there's nothing to negate against; it's also how the walker's
/// own `!{p}` override-negation is built, so a leading `!` in a user pattern would
/// double-negate and confuse the override builder).
fn validate_hidden_pattern(pattern: &str) -> AppResult<()> {
    if pattern.is_empty()
        || pattern.contains('/')
        || pattern.contains('\\')
        || pattern.starts_with('!')
    {
        return Err(AppError::invalid_argument(format!(
            "Invalid pattern: {pattern}"
        )));
    }
    globset::Glob::new(pattern)
        .map_err(|_| AppError::invalid_argument(format!("Invalid pattern: {pattern}")))?;
    Ok(())
}

const MAX_SAVED_PROMPTS: usize = 200;
const MAX_PROMPT_TITLE_CHARS: usize = 80;
const MAX_PROMPT_TEXT_CHARS: usize = 20_000;

fn clip_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Saved prompts: trimmed id/title, text clipped, entries without id or text dropped,
/// duplicate ids dropped (first wins), at most [`MAX_SAVED_PROMPTS`].
fn normalize_saved_prompts(prompts: Vec<SavedPrompt>) -> Vec<SavedPrompt> {
    let mut seen = std::collections::HashSet::new();
    prompts
        .into_iter()
        .map(|p| SavedPrompt {
            id: p.id.trim().to_string(),
            title: clip_chars(p.title.trim(), MAX_PROMPT_TITLE_CHARS),
            text: clip_chars(&p.text, MAX_PROMPT_TEXT_CHARS),
        })
        .filter(|p| !p.id.is_empty() && !p.text.trim().is_empty())
        .filter(|p| seen.insert(p.id.clone()))
        .take(MAX_SAVED_PROMPTS)
        .collect()
}

const MAX_ID_CHARS: usize = 64;
const MAX_SCHEME_NAME_CHARS: usize = 64;
const MAX_IMPORTED_SCHEMES: usize = 50;
const MIN_AWAY_SUMMARY_MINUTES: u32 = 1;
const MIN_WINDOW_OPACITY: u32 = 30;
const MAX_WINDOW_OPACITY: u32 = 100;
const MAX_AWAY_SUMMARY_MINUTES: u32 = 240;

/// A theme id: `[a-z0-9-]{1,64}`.
fn is_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `"app"`, a theme id or `"imported:<name>"` (name 1–64 chars); anything else → `"app"`.
fn normalize_color_scheme(scheme: &str) -> String {
    let scheme = scheme.trim();
    let valid = match scheme.strip_prefix("imported:") {
        Some(name) => (1..=MAX_SCHEME_NAME_CHARS).contains(&name.chars().count()),
        None => is_theme_id(scheme),
    };
    if valid {
        scheme.to_string()
    } else {
        default_color_scheme()
    }
}

/// `#rrggbb` (any case) → lowercase; anything else → `None`.
pub fn normalize_hex_color(color: &str) -> Option<String> {
    let hex = color.trim().strip_prefix('#')?;
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// A scheme with a trimmed 1–64 char name and every colour a valid `#rrggbb`, or `None`.
pub fn normalize_scheme(mut scheme: TerminalScheme) -> Option<TerminalScheme> {
    scheme.name = scheme.name.trim().to_string();
    if !(1..=MAX_SCHEME_NAME_CHARS).contains(&scheme.name.chars().count()) {
        return None;
    }
    for color in scheme.colors_mut() {
        *color = normalize_hex_color(color)?;
    }
    Some(scheme)
}

/// Invalid schemes dropped; a duplicate name keeps the last one (at the first one's
/// position); at most [`MAX_IMPORTED_SCHEMES`].
fn normalize_imported_schemes(schemes: Vec<TerminalScheme>) -> Vec<TerminalScheme> {
    let mut out: Vec<TerminalScheme> = Vec::new();
    for scheme in schemes.into_iter().filter_map(normalize_scheme) {
        match out.iter_mut().find(|s| s.name == scheme.name) {
            Some(existing) => *existing = scheme,
            None => out.push(scheme),
        }
    }
    out.truncate(MAX_IMPORTED_SCHEMES);
    out
}

/// The settings as they go into a diagnostics zip: saved prompt texts (user-authored
/// content) are replaced by their count.
pub fn settings_for_diagnostics(settings: &Settings) -> serde_json::Value {
    let mut value = serde_json::to_value(settings).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(composer) = value.get_mut("composer").and_then(|c| c.as_object_mut()) {
        composer.remove("savedPrompts");
        composer.insert(
            "savedPromptCount".to_string(),
            serde_json::json!(settings.composer.saved_prompts.len()),
        );
    }
    value
}

/// Spec §1.1: validates and normalizes a whole `Settings` value for `settings_set`.
/// Every hidden pattern must compile — **the whole write is rejected** if even one
/// doesn't (rather than silently dropping the bad one), so the frontend's "value not
/// added to the list" behaviour has a single, precise error to react to.
pub fn validate_and_normalize(mut settings: Settings) -> AppResult<Settings> {
    settings.editor.font_size = clamp_font_size(settings.editor.font_size);
    settings.editor.font_family =
        normalize_font_family(&settings.editor.font_family, &default_editor_font_family());

    settings.terminal.font_size = clamp_font_size(settings.terminal.font_size);
    settings.terminal.font_family = normalize_font_family(
        &settings.terminal.font_family,
        &default_terminal_font_family(),
    );

    let mut seen = std::collections::HashSet::new();
    settings.agents.commands = settings
        .agents
        .commands
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .filter(|c| seen.insert(c.clone()))
        .collect();

    // Review finding #14: trim *before* validating, not after — otherwise a
    // whitespace-only pattern (e.g. `"   "`) sails past the `is_empty()` check (it isn't
    // empty *before* trimming) and a padded one (`" node_modules "`) gets validated as a
    // literal-with-spaces glob instead of as the `node_modules` it actually normalizes to
    // and gets matched as.
    settings.files.hidden_patterns = settings
        .files
        .hidden_patterns
        .into_iter()
        .map(|p| p.trim().to_string())
        .collect();
    for pattern in &settings.files.hidden_patterns {
        validate_hidden_pattern(pattern)?;
    }

    settings.composer.saved_prompts =
        normalize_saved_prompts(std::mem::take(&mut settings.composer.saved_prompts));

    if !is_theme_id(&settings.appearance.dark_theme) {
        settings.appearance.dark_theme = default_dark_theme();
    }
    if !is_theme_id(&settings.appearance.light_theme) {
        settings.appearance.light_theme = default_light_theme();
    }
    settings.appearance.window_opacity = settings
        .appearance
        .window_opacity
        .clamp(MIN_WINDOW_OPACITY, MAX_WINDOW_OPACITY);
    settings.agents.away_summary_minutes = settings
        .agents
        .away_summary_minutes
        .clamp(MIN_AWAY_SUMMARY_MINUTES, MAX_AWAY_SUMMARY_MINUTES);
    settings.terminal.color_scheme = normalize_color_scheme(&settings.terminal.color_scheme);
    settings.terminal.imported_schemes =
        normalize_imported_schemes(std::mem::take(&mut settings.terminal.imported_schemes));

    Ok(settings)
}

/// Spec §1.1, review finding #14: load-time recovery for a hand-edited `settings.json`
/// that carries one or more hidden patterns that no longer compile. Drops only the
/// offending pattern(s) — unlike [`SettingsStore::load_from`]'s old fallback, this must
/// never reset the *whole* `files` section, which would also silently discard the user's
/// `respectGitignore` choice and every other (perfectly valid) pattern in the list.
fn drop_invalid_hidden_patterns(mut settings: Settings) -> Settings {
    settings
        .files
        .hidden_patterns
        .retain(|p| validate_hidden_pattern(p.trim()).is_ok());
    settings
}

// ---------------------------------------------------------------------------------
// Hidden-pattern compilation (spec §5, §10.13/§10.14) — shared by `fs_read_dir`, the
// quick-open walker, and the watcher's own hidden-name check.
// ---------------------------------------------------------------------------------

/// Compiles `patterns` into a single case-insensitive, basename-only `GlobSet`. A
/// pattern that somehow fails to compile here (should be impossible — every pattern
/// stored by [`validate_and_normalize`] already compiled once) is skipped rather than
/// panicking; an empty/failed builder falls back to an always-empty `GlobSet`.
pub fn build_hidden_globset(patterns: &[String]) -> globset::GlobSet {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        if let Ok(glob) = globset::GlobBuilder::new(pattern)
            .case_insensitive(true)
            .build()
        {
            builder.add(glob);
        }
    }
    builder.build().unwrap_or_else(|_| {
        globset::GlobSetBuilder::new()
            .build()
            .expect("empty GlobSetBuilder always builds")
    })
}

/// Builds the `ignore::WalkBuilder` overrides that hide `patterns` at every depth under
/// `root` (spec §4, §10.13: each pattern becomes a `!{pattern}` override — the walker's
/// own negation-as-exclude convention).
pub fn build_hidden_overrides(
    root: &Path,
    patterns: &[String],
) -> Result<ignore::overrides::Override, ignore::Error> {
    let mut builder = ignore::overrides::OverrideBuilder::new(root);
    builder.case_insensitive(true)?;
    for pattern in patterns {
        builder.add(&format!("!{pattern}"))?;
    }
    builder.build()
}

// ---------------------------------------------------------------------------------
// SettingsStore (Tauri managed state)
// ---------------------------------------------------------------------------------

pub struct SettingsStore {
    dir: std::path::PathBuf,
    /// `Settings` and its derived compiled hidden-name `GlobSet` under **one** lock,
    /// updated atomically together (review finding #13). Two independent locks (as this
    /// used to be) allow a window — between committing the new `Settings` and separately
    /// committing the new `GlobSet` — where a reader can observe the *new*
    /// `files.hiddenPatterns` paired with the *stale* compiled matcher (or vice versa);
    /// a single `RwLock` over the pair makes that impossible.
    inner: RwLock<(Settings, Arc<globset::GlobSet>)>,
}

impl SettingsStore {
    pub fn load_from(dir: std::path::PathBuf) -> Self {
        let raw = crate::persistence::load_settings_json_from(&dir);
        let parsed: Settings = serde_json::from_value(raw).unwrap_or_default();
        // A hand-edited file could carry an out-of-range value; normalize defensively on
        // load too (never fails the whole app start). Review finding #14: recovery from
        // an invalid hidden pattern drops only that pattern (`drop_invalid_hidden_patterns`)
        // rather than resetting the whole `files` section — the user's `respectGitignore`
        // choice and every other valid pattern survive. `validate_and_normalize`'s only
        // failure mode is an uncompilable hidden pattern, so re-running it after dropping
        // every one that doesn't compile always succeeds; `unwrap_or_default` is just a
        // defensive fallback in case that ever stops being true.
        let normalized = validate_and_normalize(parsed.clone())
            .unwrap_or_else(|_| validate_and_normalize(drop_invalid_hidden_patterns(parsed)).unwrap_or_default());
        let hidden = Arc::new(build_hidden_globset(&normalized.files.hidden_patterns));
        Self {
            dir,
            inner: RwLock::new((normalized, hidden)),
        }
    }

    pub fn load() -> Self {
        Self::load_from(crate::persistence::state_dir())
    }

    fn lock(&self) -> std::sync::RwLockReadGuard<'_, (Settings, Arc<globset::GlobSet>)> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.lock().0.clone()
    }

    pub fn respect_gitignore(&self) -> bool {
        self.lock().0.files.respect_gitignore
    }

    /// Cached compiled hidden-name matcher (spec §5, §10.14) — the single source of
    /// truth `fs_read_dir` and the watcher both read. Always in sync with [`Self::get`]'s
    /// `files.hiddenPatterns` at the instant either is read (finding #13).
    pub fn hidden_globset(&self) -> Arc<globset::GlobSet> {
        self.lock().1.clone()
    }

    /// Fresh per call (cheap — the pattern list is small; unlike the `GlobSet` above this
    /// needs `root`, so it can't be cached independently of the caller's workspace).
    pub fn hidden_overrides(
        &self,
        root: &Path,
    ) -> Result<ignore::overrides::Override, ignore::Error> {
        build_hidden_overrides(root, &self.get().files.hidden_patterns)
    }

    /// Spec §10.5: validates/normalizes, then holds the write guard across the disk
    /// write itself (same "guard across the write" model as `StateStore::set_slice`) so
    /// two concurrent `settings_set` calls can never interleave their writes — the event
    /// is emitted by the caller only after this returns, i.e. after the guard is
    /// released. Review finding #13: the compiled `GlobSet` is recompiled and committed
    /// together with `Settings` in the same guarded assignment, so no reader can ever see
    /// one update without the other.
    pub fn set(&self, new_settings: Settings) -> AppResult<Settings> {
        let normalized = validate_and_normalize(new_settings)?;
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let value = serde_json::to_value(&normalized)
            .map_err(|e| AppError::io(format!("failed to serialize settings: {e}")))?;
        crate::persistence::save_settings_json_to(&self.dir, &value)
            .map_err(|e| AppError::io(e.to_string()))?;
        let hidden = Arc::new(build_hidden_globset(&normalized.files.hidden_patterns));
        *guard = (normalized.clone(), hidden);
        drop(guard);
        Ok(normalized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(id: &str, title: &str, text: &str) -> SavedPrompt {
        SavedPrompt { id: id.to_string(), title: title.to_string(), text: text.to_string() }
    }

    #[test]
    fn missing_composer_deserializes_to_empty_defaults() {
        let s: Settings = serde_json::from_value(serde_json::json!({ "theme": "dark" })).unwrap();
        assert!(s.composer.saved_prompts.is_empty());
        assert!(!s.composer.attachments_hint_shown);
    }

    #[test]
    fn composer_saved_prompts_round_trip_in_camel_case() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "composer": {
                "savedPrompts": [{ "id": "p1", "title": "Review", "text": "Review the diff" }],
                "attachmentsHintShown": true
            }
        }))
        .unwrap();
        assert_eq!(s.composer.saved_prompts, vec![prompt("p1", "Review", "Review the diff")]);
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["composer"]["savedPrompts"][0]["text"], "Review the diff");
        assert_eq!(back["composer"]["attachmentsHintShown"], true);
    }

    #[test]
    fn validate_normalizes_saved_prompts() {
        let mut s = Settings::default();
        s.composer.saved_prompts = vec![
            prompt(" p1 ", "  Title  ", "text"),
            prompt("p1", "dup", "dropped"),
            prompt("", "no id", "dropped"),
            prompt("p2", "blank", "   "),
            prompt("p3", &"t".repeat(200), &"x".repeat(MAX_PROMPT_TEXT_CHARS + 5)),
        ];
        let out = validate_and_normalize(s).unwrap();
        let ids: Vec<&str> = out.composer.saved_prompts.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["p1", "p3"]);
        assert_eq!(out.composer.saved_prompts[0].title, "Title");
        assert_eq!(out.composer.saved_prompts[1].title.chars().count(), MAX_PROMPT_TITLE_CHARS);
        assert_eq!(out.composer.saved_prompts[1].text.chars().count(), MAX_PROMPT_TEXT_CHARS);
    }

    #[test]
    fn validate_caps_the_number_of_saved_prompts() {
        let mut s = Settings::default();
        s.composer.saved_prompts =
            (0..MAX_SAVED_PROMPTS + 3).map(|i| prompt(&format!("p{i}"), "", "t")).collect();
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.composer.saved_prompts.len(), MAX_SAVED_PROMPTS);
    }

    #[test]
    fn diagnostics_settings_carry_only_the_saved_prompt_count() {
        let mut s = Settings::default();
        s.composer.saved_prompts = vec![prompt("p1", "secret title", "secret text")];
        let value = settings_for_diagnostics(&s);
        assert_eq!(value["composer"]["savedPromptCount"], 1);
        assert!(value["composer"].get("savedPrompts").is_none());
        assert!(!value.to_string().contains("secret"));
    }

    #[test]
    fn defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.v, 1);
        assert_eq!(s.theme, ThemeName::Dark);
        assert_eq!(s.editor.font_size, 13);
        assert_eq!(s.terminal.font_size, 15);
        assert_eq!(s.agents.commands, vec!["claude", "codex"]);
        assert!(s.agents.notifications);
        assert_eq!(
            s.files.hidden_patterns,
            vec![".git", "node_modules", "dist", "target", ".DS_Store"]
        );
        assert!(!s.files.respect_gitignore);
        assert!(s.clipboard.copy_path_after_image_save);
        assert!(s.terminal.default_shell.is_none());
        assert!(!s.terminal.copy_on_select);
        assert!(s.terminal.warn_multiline_paste);
        assert!(!s.diagnostics.verbose_logging);
    }

    /// Faz 7 spec §6: an old `settings.json` written before `diagnostics` existed must
    /// still load, defaulting `verboseLogging` to `false`.
    #[test]
    fn missing_diagnostics_field_deserializes_to_default_false() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "theme": "light"
        }))
        .unwrap();
        assert!(!s.diagnostics.verbose_logging);
    }

    #[test]
    fn diagnostics_verbose_logging_round_trips() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "diagnostics": { "verboseLogging": true }
        }))
        .unwrap();
        assert!(s.diagnostics.verbose_logging);
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["diagnostics"]["verboseLogging"], serde_json::json!(true));
    }

    fn scheme(name: &str, bg: &str) -> TerminalScheme {
        let c = || "#AABBCC".to_string();
        TerminalScheme {
            name: name.to_string(),
            background: bg.to_string(),
            foreground: c(),
            cursor: c(),
            selection: c(),
            black: c(),
            red: c(),
            green: c(),
            yellow: c(),
            blue: c(),
            magenta: c(),
            cyan: c(),
            white: c(),
            bright_black: c(),
            bright_red: c(),
            bright_green: c(),
            bright_yellow: c(),
            bright_blue: c(),
            bright_magenta: c(),
            bright_cyan: c(),
            bright_white: c(),
        }
    }

    #[test]
    fn appearance_away_summary_and_scheme_defaults() {
        let s: Settings =
            serde_json::from_value(serde_json::json!({ "terminal": {}, "agents": {} })).unwrap();
        assert_eq!(s.appearance.dark_theme, "kotilo-dark");
        assert_eq!(s.appearance.light_theme, "kotilo-light");
        assert!(s.agents.away_summary);
        assert_eq!(s.agents.away_summary_minutes, 10);
        assert_eq!(s.terminal.color_scheme, "app");
        assert!(s.terminal.imported_schemes.is_empty());
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["appearance"]["darkTheme"], "kotilo-dark");
        assert_eq!(back["appearance"]["lightTheme"], "kotilo-light");
        assert_eq!(back["appearance"]["windowOpacity"], 100);
        assert_eq!(back["appearance"]["acrylic"], false);
        assert!(!s.appearance.is_translucent());
        assert_eq!(back["agents"]["awaySummary"], true);
        assert_eq!(back["agents"]["awaySummaryMinutes"], 10);
        assert_eq!(back["terminal"]["colorScheme"], "app");
        assert_eq!(back["terminal"]["importedSchemes"], serde_json::json!([]));
    }

    #[test]
    fn validate_resets_invalid_theme_ids() {
        let mut s = Settings::default();
        s.appearance.dark_theme = "catppuccin-mocha".into();
        s.appearance.light_theme = "Bad Id".into();
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.appearance.dark_theme, "catppuccin-mocha");
        assert_eq!(out.appearance.light_theme, "kotilo-light");

        let mut s = Settings::default();
        s.appearance.dark_theme = "a".repeat(65);
        s.appearance.light_theme = String::new();
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.appearance.dark_theme, "kotilo-dark");
        assert_eq!(out.appearance.light_theme, "kotilo-light");
    }

    #[test]
    fn validate_clamps_window_opacity() {
        let mut s = Settings::default();
        s.appearance.window_opacity = 5;
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.appearance.window_opacity, MIN_WINDOW_OPACITY);
        assert!(out.appearance.is_translucent());

        let mut s = Settings::default();
        s.appearance.window_opacity = 250;
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.appearance.window_opacity, MAX_WINDOW_OPACITY);
        assert!(!out.appearance.is_translucent());
    }

    #[test]
    fn validate_clamps_away_summary_minutes() {
        let mut s = Settings::default();
        s.agents.away_summary_minutes = 0;
        assert_eq!(validate_and_normalize(s).unwrap().agents.away_summary_minutes, 1);
        let mut s = Settings::default();
        s.agents.away_summary_minutes = 1000;
        assert_eq!(validate_and_normalize(s).unwrap().agents.away_summary_minutes, 240);
    }

    #[test]
    fn validate_normalizes_color_scheme() {
        for (input, expected) in [
            ("app", "app"),
            ("gruvbox-dark", "gruvbox-dark"),
            ("imported:One Half Dark", "imported:One Half Dark"),
            ("imported:", "app"),
            ("Gruvbox Dark", "app"),
            ("", "app"),
        ] {
            let mut s = Settings::default();
            s.terminal.color_scheme = input.into();
            assert_eq!(validate_and_normalize(s).unwrap().terminal.color_scheme, expected, "{input}");
        }
        let mut s = Settings::default();
        s.terminal.color_scheme = format!("imported:{}", "x".repeat(65));
        assert_eq!(validate_and_normalize(s).unwrap().terminal.color_scheme, "app");
    }

    #[test]
    fn validate_normalizes_imported_schemes() {
        let mut s = Settings::default();
        s.terminal.imported_schemes = vec![
            scheme("  One Half Dark ", "#282C34"),
            scheme("Bad colour", "#28C34"),
            scheme("Not hex", "#zzzzzz"),
            scheme("   ", "#000000"),
            scheme(&"n".repeat(65), "#000000"),
            scheme("Campbell", "#0C0C0C"),
            scheme("One Half Dark", "#111111"),
        ];
        let out = validate_and_normalize(s).unwrap().terminal.imported_schemes;
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["One Half Dark", "Campbell"]);
        assert_eq!(out[0].background, "#111111", "duplicate name keeps the last");
        assert_eq!(out[0].foreground, "#aabbcc", "colours are lowercased");
        assert_eq!(out[1].background, "#0c0c0c");
    }

    #[test]
    fn validate_caps_imported_schemes() {
        let mut s = Settings::default();
        s.terminal.imported_schemes = (0..60).map(|i| scheme(&format!("s{i}"), "#000000")).collect();
        assert_eq!(validate_and_normalize(s).unwrap().terminal.imported_schemes.len(), 50);
    }

    #[test]
    fn imported_scheme_round_trips_in_camel_case() {
        let mut s = Settings::default();
        s.terminal.imported_schemes = vec![scheme("X", "#000000")];
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["terminal"]["importedSchemes"][0]["brightMagenta"], "#AABBCC");
        let again: Settings = serde_json::from_value(back).unwrap();
        assert_eq!(again, s);
    }

    #[test]
    fn missing_fields_deserialize_to_defaults() {
        let s: Settings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn unknown_top_level_field_is_preserved_through_round_trip() {
        let s: Settings =
            serde_json::from_value(serde_json::json!({ "futureField": 42 })).unwrap();
        assert_eq!(s.extra.get("futureField"), Some(&serde_json::json!(42)));
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["futureField"], serde_json::json!(42));
    }

    #[test]
    fn partial_object_fills_in_missing_leaves_with_defaults() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "theme": "light",
            "editor": { "fontSize": 20 }
        }))
        .unwrap();
        assert_eq!(s.theme, ThemeName::Light);
        assert_eq!(s.editor.font_size, 20);
        assert_eq!(s.editor.font_family, default_editor_font_family());
    }

    #[test]
    fn validate_clamps_out_of_range_font_sizes() {
        let mut s = Settings::default();
        s.editor.font_size = 999;
        s.terminal.font_size = 1;
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.editor.font_size, MAX_FONT_SIZE);
        assert_eq!(out.terminal.font_size, MIN_FONT_SIZE);
    }

    #[test]
    fn validate_replaces_empty_font_family_with_default() {
        let mut s = Settings::default();
        s.editor.font_family = "   ".to_string();
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.editor.font_family, default_editor_font_family());
    }

    #[test]
    fn validate_trims_dedupes_and_drops_empty_agent_commands() {
        let mut s = Settings::default();
        s.agents.commands = vec![
            "  claude  ".to_string(),
            "".to_string(),
            "claude".to_string(),
            "codex".to_string(),
        ];
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.agents.commands, vec!["claude", "codex"]);
    }

    #[test]
    fn validate_allows_empty_agent_command_list() {
        let mut s = Settings::default();
        s.agents.commands = vec![];
        let out = validate_and_normalize(s).unwrap();
        assert!(out.agents.commands.is_empty());
    }

    #[test]
    fn validate_rejects_uncompilable_hidden_pattern_and_whole_write_fails() {
        let mut s = Settings::default();
        s.files.hidden_patterns = vec!["ok".to_string(), "[".to_string()];
        let err = validate_and_normalize(s).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidArgument);
        assert!(err.message.contains('['));
    }

    #[test]
    fn validate_rejects_hidden_pattern_with_path_separator() {
        let mut s = Settings::default();
        s.files.hidden_patterns = vec!["a/b".to_string()];
        let err = validate_and_normalize(s).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidArgument);
    }

    #[test]
    fn validate_rejects_hidden_pattern_starting_with_bang() {
        let mut s = Settings::default();
        s.files.hidden_patterns = vec!["!node_modules".to_string()];
        let err = validate_and_normalize(s).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidArgument);
    }

    /// Review finding #14: trimming happens *before* validation, so a padded pattern is
    /// judged (and stored) by what it normalizes to, not by its raw, whitespace-including
    /// form.
    #[test]
    fn validate_trims_hidden_pattern_before_validating() {
        let mut s = Settings::default();
        s.files.hidden_patterns = vec!["  node_modules  ".to_string()];
        let out = validate_and_normalize(s).unwrap();
        assert_eq!(out.files.hidden_patterns, vec!["node_modules".to_string()]);
    }

    /// Review finding #14: a whitespace-only pattern must be rejected as empty — it would
    /// pass the old `is_empty()` check before trimming even ran.
    #[test]
    fn validate_rejects_whitespace_only_hidden_pattern() {
        let mut s = Settings::default();
        s.files.hidden_patterns = vec!["   ".to_string()];
        let err = validate_and_normalize(s).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidArgument);
    }

    #[test]
    fn hidden_globset_matches_basenames_case_insensitively() {
        let set = build_hidden_globset(&["node_modules".to_string(), "*.log".to_string()]);
        assert!(set.is_match("node_modules"));
        assert!(set.is_match("NODE_MODULES"));
        assert!(set.is_match("debug.log"));
        assert!(!set.is_match("src"));
    }

    // -- SettingsStore ------------------------------------------------------------

    #[test]
    fn store_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load_from(dir.path().to_path_buf());
        let mut s = store.get();
        s.theme = ThemeName::Light;
        s.editor.font_size = 18;
        let saved = store.set(s).unwrap();
        assert_eq!(saved.theme, ThemeName::Light);

        let reloaded = SettingsStore::load_from(dir.path().to_path_buf());
        assert_eq!(reloaded.get().theme, ThemeName::Light);
        assert_eq!(reloaded.get().editor.font_size, 18);
    }

    #[test]
    fn store_rejects_invalid_pattern_and_keeps_previous_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load_from(dir.path().to_path_buf());
        let mut s = store.get();
        s.files.hidden_patterns = vec!["[".to_string()];
        let err = store.set(s).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidArgument);
        // Nothing was written -- the store still reports the untouched defaults.
        assert_eq!(store.get(), Settings::default());
    }

    /// Review finding #14: a hand-edited `settings.json` with one bad hidden pattern
    /// alongside otherwise-valid settings must only lose that one pattern on load — not
    /// the whole `files` section (which would also silently discard `respectGitignore`
    /// and every other, perfectly valid, pattern).
    #[test]
    fn store_load_drops_only_the_offending_hidden_pattern() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::json!({
                "files": {
                    "hiddenPatterns": ["node_modules", "[", "*.log"],
                    "respectGitignore": true
                }
            })
            .to_string(),
        )
        .unwrap();

        let store = SettingsStore::load_from(dir.path().to_path_buf());
        let loaded = store.get();
        assert_eq!(
            loaded.files.hidden_patterns,
            vec!["node_modules".to_string(), "*.log".to_string()]
        );
        assert!(loaded.files.respect_gitignore, "respectGitignore must survive load-time recovery");
    }

    #[test]
    fn store_missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load_from(dir.path().to_path_buf());
        assert_eq!(store.get(), Settings::default());
    }

    #[test]
    fn store_corrupt_file_falls_back_to_defaults_and_keeps_corrupt_copy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), b"{ not json").unwrap();
        let store = SettingsStore::load_from(dir.path().to_path_buf());
        assert_eq!(store.get(), Settings::default());
        assert!(dir.path().join("settings.json.corrupt").exists());
    }

    #[test]
    fn hidden_globset_cache_updates_after_set() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load_from(dir.path().to_path_buf());
        assert!(store.hidden_globset().is_match("node_modules"));

        let mut s = store.get();
        s.files.hidden_patterns = vec!["only_this".to_string()];
        store.set(s).unwrap();

        assert!(!store.hidden_globset().is_match("node_modules"));
        assert!(store.hidden_globset().is_match("only_this"));
    }

    #[test]
    fn concurrent_set_calls_leave_disk_matching_memory() {
        use std::sync::Arc as StdArc;
        use std::thread;

        let dir = tempfile::tempdir().unwrap();
        let store = StdArc::new(SettingsStore::load_from(dir.path().to_path_buf()));

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let store = StdArc::clone(&store);
                thread::spawn(move || {
                    for n in 0..20 {
                        let mut s = store.get();
                        s.editor.font_size = 8 + ((i * 20 + n) % 24) as u32;
                        let _ = store.set(s);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let in_memory = store.get();
        let on_disk_raw = crate::persistence::load_settings_json_from(dir.path());
        let on_disk: Settings = serde_json::from_value(on_disk_raw).unwrap();
        assert_eq!(on_disk, in_memory);
    }
}
