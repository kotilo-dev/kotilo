//! Files only the current user may read: mode `0600` on Unix; on Windows the user profile's
//! default ACL already limits a file under it to the user.

use std::io::{self, Write};
use std::path::Path;

/// Creates (or truncates) `path` owner-only and writes `bytes` to it.
pub fn write_owner_only(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
