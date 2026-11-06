//! The shared secret `~/.kotilo/companion.token` (protocol §2): 64 lowercase hex chars, readers
//! trim whitespace. Whichever side starts first creates it (temp file in the same folder, then
//! rename); a valid token is never overwritten. It is ours and the deck's, not an agent
//! credential. Its content never goes to logs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::auth;

pub const DIR_NAME: &str = ".kotilo";
pub const FILE_NAME: &str = "companion.token";

pub fn token_path(home: &Path) -> PathBuf {
    home.join(DIR_NAME).join(FILE_NAME)
}

#[derive(Debug)]
pub enum TokenError {
    Io(io::Error),
    /// The file holds no valid token.
    Invalid,
    /// The OS gave no randomness.
    Random(String),
}

impl From<io::Error> for TokenError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "token file: {}", e.kind()),
            Self::Invalid => write!(f, "token file holds no valid token"),
            Self::Random(e) => write!(f, "no randomness: {e}"),
        }
    }
}

/// The token in the file, trimmed and lowercased; `Invalid` when it is not 64 hex chars.
pub fn read(path: &Path) -> Result<String, TokenError> {
    let text = fs::read_to_string(path)?;
    let token = text.trim();
    if auth::is_hex64(token) {
        Ok(token.to_ascii_lowercase())
    } else {
        Err(TokenError::Invalid)
    }
}

/// The existing valid token, else a new one written to the file. An existing file with
/// invalid content is left alone (the deck may be writing it, or the user edited it).
pub fn read_or_create(path: &Path) -> Result<String, TokenError> {
    match read(path) {
        Ok(token) => return Ok(token),
        Err(TokenError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let token = auth::random_hex32().map_err(|e| TokenError::Random(e.to_string()))?;
    let dir = path.parent().ok_or(TokenError::Invalid)?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    crate::platform::private_file::write_owner_only(&temp, token.as_bytes())?;
    // The other side may have created it meanwhile: keep theirs.
    if path.exists() {
        let _ = fs::remove_file(&temp);
        return read(path);
    }
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return read(path).map_err(|_| TokenError::Io(e));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn missing_file_is_created_with_a_new_token() {
        let home = tempfile::tempdir().unwrap();
        let path = token_path(home.path());
        let token = read_or_create(&path).unwrap();
        assert!(auth::is_hex64(&token));
        assert_eq!(fs::read_to_string(&path).unwrap(), token);
        // Next start reads the same token; no temp file is left behind.
        assert_eq!(read_or_create(&path).unwrap(), token);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn valid_token_is_trimmed_and_never_overwritten() {
        let home = tempfile::tempdir().unwrap();
        let path = token_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("  {}\r\n", VALID.to_ascii_uppercase())).unwrap();
        assert_eq!(read_or_create(&path).unwrap(), VALID);
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("  {}\r\n", VALID.to_ascii_uppercase()));
    }

    #[test]
    fn invalid_content_is_an_error_and_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let path = token_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bad in ["", "abc", &VALID[..63], &format!("{VALID}0"), &VALID.replace('0', "g")] {
            fs::write(&path, bad).unwrap();
            assert!(matches!(read_or_create(&path), Err(TokenError::Invalid)), "{bad:?}");
            assert_eq!(fs::read_to_string(&path).unwrap(), bad);
        }
    }

    #[cfg(unix)]
    #[test]
    fn created_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let path = token_path(home.path());
        read_or_create(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
