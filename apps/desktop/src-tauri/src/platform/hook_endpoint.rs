//! The hook endpoint's transport (D-007, AGENTS.md rule 7): a named pipe
//! `\\.\pipe\<exePrefix>-<pid>` on Windows, a Unix domain socket
//! `/tmp/<exePrefix>-<pid>.sock` elsewhere (a fixed folder, not `$TMPDIR`: a hook started
//! with an empty environment must find the same path). `ipc_server` only sees
//! [`HookListener::accept`] and a readable [`HookConnection`]; the one-message-per-connection
//! protocol is the same on both. `agenthub-hook`'s platform layer builds the same names.

use std::io;

pub use self::os::HookConnection;

/// The endpoint for the Kotilo process `pid` (passed to every pane as `AGENTHUB_ENDPOINT`).
pub fn endpoint_name(pid: u32) -> String {
    os::endpoint_name(pid)
}

/// Accepts hook connections on one endpoint. Never panics: every failure comes back from
/// [`HookListener::accept`] so the caller can log it and retry with a backoff.
pub struct HookListener(os::Listener);

impl HookListener {
    pub fn new(name: &str) -> Self {
        Self(os::Listener::new(name))
    }

    pub async fn accept(&mut self) -> io::Result<HookConnection> {
        self.0.accept().await
    }
}

#[cfg(windows)]
mod os {
    use std::io;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub type HookConnection = NamedPipeServer;

    pub fn endpoint_name(pid: u32) -> String {
        format!(r"\\.\pipe\{}-{pid}", crate::brand::EXE_PREFIX)
    }

    pub struct Listener {
        name: String,
        /// The instance the next client connects to. Stood up before a connection is
        /// handed off, so a second client is never left waiting on a pipe with no free
        /// instance.
        next: Option<NamedPipeServer>,
        /// Whether this process owns the pipe name yet: the very first instance is created
        /// with `first_pipe_instance`, so another process holding the name is an error
        /// rather than a pipe we would silently share.
        owned: bool,
    }

    impl Listener {
        pub fn new(name: &str) -> Self {
            let mut listener = Self {
                name: name.to_string(),
                next: None,
                owned: false,
            };
            listener.next = listener.create().ok();
            listener
        }

        fn create(&mut self) -> io::Result<NamedPipeServer> {
            let mut opts = ServerOptions::new();
            if !self.owned {
                opts.first_pipe_instance(true);
            }
            let server = opts.create(&self.name)?;
            self.owned = true;
            Ok(server)
        }

        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            let server = match self.next.take() {
                Some(server) => server,
                None => self.create()?,
            };
            server.connect().await?;
            match self.create() {
                Ok(next) => self.next = Some(next),
                // The next `accept` tries again.
                Err(err) => log::warn!("failed to create the next hook pipe instance: {err}"),
            }
            Ok(server)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn endpoint_name_matches_expected_format() {
            assert_eq!(endpoint_name(1234), format!(r"\\.\pipe\{}-1234", crate::brand::EXE_PREFIX));
        }

        #[tokio::test]
        async fn a_second_owner_of_the_same_name_fails_without_panicking() {
            let name = r"\\.\pipe\agenthub-test-hook-listener-dup";
            let first = Listener::new(name);
            assert!(first.next.is_some(), "first instance should succeed");
            let mut second = Listener::new(name);
            assert!(second.next.is_none());
            assert!(second.create().is_err());
        }
    }
}

#[cfg(not(windows))]
mod os {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use tokio::net::{UnixListener, UnixStream};

    pub type HookConnection = UnixStream;

    pub fn endpoint_name(pid: u32) -> String {
        format!("/tmp/{}-{pid}.sock", crate::brand::EXE_PREFIX)
    }

    pub struct Listener {
        path: PathBuf,
        listener: Option<UnixListener>,
    }

    impl Listener {
        pub fn new(name: &str) -> Self {
            let mut listener = Self {
                path: PathBuf::from(name),
                listener: None,
            };
            if let Err(err) = listener.bind() {
                log::warn!("failed to bind the hook socket: {err}");
            }
            listener
        }

        fn bind(&mut self) -> io::Result<&UnixListener> {
            if self.listener.is_none() {
                // A socket file left by an earlier process with the same pid.
                let _ = std::fs::remove_file(&self.path);
                let listener = UnixListener::bind(&self.path)?;
                // Only this user may send hook messages.
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
                self.listener = Some(listener);
            }
            self.listener.as_ref().ok_or_else(|| io::Error::other("hook socket not bound"))
        }

        pub async fn accept(&mut self) -> io::Result<UnixStream> {
            let (stream, _) = self.bind()?.accept().await?;
            Ok(stream)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            if self.listener.is_some() {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        #[test]
        fn endpoint_name_is_a_socket_in_tmp() {
            assert_eq!(endpoint_name(1234), format!("/tmp/{}-1234.sock", crate::brand::EXE_PREFIX));
        }

        #[tokio::test]
        async fn accepts_a_message_and_removes_the_socket_on_drop() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("hook.sock");
            // A stale file from an earlier run is replaced.
            std::fs::write(&path, b"stale").unwrap();
            let mut listener = Listener::new(path.to_str().unwrap());
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);

            let client_path = path.clone();
            let client = tokio::spawn(async move {
                let mut stream = UnixStream::connect(&client_path).await.unwrap();
                stream.write_all(b"{\"a\":1}\n").await.unwrap();
            });
            let mut conn = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            conn.read_to_end(&mut buf).await.unwrap();
            client.await.unwrap();
            assert_eq!(buf, b"{\"a\":1}\n");

            drop(listener);
            assert!(!path.exists());
        }
    }
}
