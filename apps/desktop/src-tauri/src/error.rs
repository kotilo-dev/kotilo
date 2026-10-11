//! Uniform command error type (Faz 2 spec §2, §8.1): every fallible command returns
//! `Result<T, AppError>`, which serializes to `{ "code": ErrorCode, "message": string }`
//! (plus `fields` for hub validation errors).

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    OutsideWorkspace,
    InvalidName,
    AlreadyExists,
    DuplicateWorkspace,
    NotADirectory,
    NoImage,
    Io,
    /// Faz 3 §1: `fs_read_text` on a file whose first 8 KB look binary (a NUL byte,
    /// unless it's UTF-16-BOM'd text).
    BinaryFile,
    /// Faz 3 §1: `fs_read_text` on a file over 50 MB, or `fs_read_bytes` over 100 MB.
    TooLarge,
    /// Faz 3 §1: `fs_write_text` with an `expected_hash` that no longer matches what's
    /// on disk (or the file vanished out from under it).
    Conflict,
    /// Faz 4 §1.2: `pty_spawn` failed to open a ConPTY pair or launch the child process
    /// (as distinct from a bad request like an unknown workspace/cwd, which use the
    /// existing `not_found`/`not_a_directory` codes).
    SpawnFailed,
    /// Faz 5 §1.6/§1.7: `hooks_install`/`hooks_uninstall` found an existing
    /// `~/.claude/settings.json` that isn't valid JSON — left byte-for-byte untouched.
    InvalidJson,
    /// Faz 6 §10.12: a well-formed request whose *value* is invalid — e.g. `settings_set`
    /// with a hidden pattern that doesn't compile as a glob (spec §1.1).
    InvalidArgument,
    /// M1: the hub background service is not running or not reachable.
    HubUnavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    /// Per-field messages of a hub validation error (`{"tasksGlob": ["required"]}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, Vec<String>>>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fields: None,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn outside_workspace(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OutsideWorkspace, message)
    }

    pub fn invalid_name(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidName, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AlreadyExists, message)
    }

    pub fn duplicate_workspace(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::DuplicateWorkspace, message)
    }

    pub fn not_a_directory(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotADirectory, message)
    }

    pub fn no_image(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NoImage, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    pub fn binary_file(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BinaryFile, message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TooLarge, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn spawn_failed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SpawnFailed, message)
    }

    pub fn invalid_json(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidJson, message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }

    pub fn hub_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::HubUnavailable, message)
    }

}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::io(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
