//! Minimal blocking client for the hub's loopback API. Reads `port.json` on every call, so
//! a restarted hub (new port, new token) is picked up without any reconnect logic.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{PortFile, TOKEN_HEADER};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubError {
    /// No `port.json`, or nothing listening on its port: the hub isn't running.
    Unavailable,
    /// The hub answered with a non-2xx status; `error`/`message`/`fields` from its JSON body if any.
    Status { code: u16, error: Option<String>, message: Option<String>, fields: Option<BTreeMap<String, Vec<String>>> },
    /// The response couldn't be read or decoded.
    Protocol(String),
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubError::Unavailable => write!(f, "the {} background service is not running", crate::brand::NAME),
            HubError::Status { code, message, .. } => match message {
                Some(m) => write!(f, "hub returned {code}: {m}"),
                None => write!(f, "hub returned {code}"),
            },
            HubError::Protocol(m) => write!(f, "hub response could not be read: {m}"),
        }
    }
}

/// `GET /v1/adapters` item.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: String,
    pub display_name: String,
    /// `null` for protocol (hookless) adapters, e.g. every user adapter.
    pub hooks: Option<HookInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    /// `missing | installed | outdated | invalidConfig | unsupported`.
    pub state: String,
    pub config_path: Option<String>,
}

/// Body of `POST /v1/adapters/{id}/hooks/{install,uninstall}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookActionResult {
    pub state: String,
    pub backup_path: Option<String>,
}

/// Request body for [`HubClient::request_body`].
#[derive(Debug, Clone, Copy)]
pub enum Body<'a> {
    None,
    Json(&'a serde_json::Value),
    Bytes(&'a [u8]),
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: Option<String>,
    message: Option<String>,
    fields: Option<BTreeMap<String, Vec<String>>>,
}

pub struct HubClient {
    data_dir: PathBuf,
}

impl HubClient {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// Client for the hub data dir resolved from the real environment.
    pub fn from_env() -> Option<Self> {
        super::data_dir(&|k| std::env::var(k).ok()).map(Self::new)
    }

    pub fn adapters(&self) -> Result<Vec<AdapterInfo>, HubError> {
        self.request("GET", "/v1/adapters")
    }

    pub fn install_hooks(&self, adapter_id: &str) -> Result<HookActionResult, HubError> {
        self.request("POST", &format!("/v1/adapters/{adapter_id}/hooks/install"))
    }

    pub fn uninstall_hooks(&self, adapter_id: &str) -> Result<HookActionResult, HubError> {
        self.request("POST", &format!("/v1/adapters/{adapter_id}/hooks/uninstall"))
    }

    /// Any JSON route (`hub_request`). `body` is sent as JSON when present.
    pub fn request_json(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value, HubError> {
        let response = self.send(method, path, body)?;
        if response.header("Content-Length") == Some("0") || response.status() == 204 {
            return Ok(serde_json::Value::Null);
        }
        response.into_json().map_err(|e| HubError::Protocol(e.to_string()))
    }

    /// Raw response bytes (report exports).
    pub fn download(&self, path: &str) -> Result<Vec<u8>, HubError> {
        let mut bytes = Vec::new();
        self.send("GET", path, None)?
            .into_reader()
            .take(MAX_DOWNLOAD_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| HubError::Protocol(e.to_string()))?;
        Ok(bytes)
    }

    fn request<T: DeserializeOwned>(&self, method: &str, path: &str) -> Result<T, HubError> {
        self.send(method, path, None)?
            .into_json::<T>()
            .map_err(|e| HubError::Protocol(e.to_string()))
    }

    /// A JSON or raw-bytes request with its own timeout (dictation: long transcriptions,
    /// audio bodies). `Null` for an empty answer.
    pub fn request_body(&self, method: &str, path: &str, body: Body<'_>, timeout: Duration) -> Result<serde_json::Value, HubError> {
        let response = self.send_with(method, path, body, timeout)?;
        if response.header("Content-Length") == Some("0") || response.status() == 204 {
            return Ok(serde_json::Value::Null);
        }
        response.into_json().map_err(|e| HubError::Protocol(e.to_string()))
    }

    fn send(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<ureq::Response, HubError> {
        self.send_with(method, path, body.map_or(Body::None, Body::Json), TIMEOUT)
    }

    fn send_with(&self, method: &str, path: &str, body: Body<'_>, timeout: Duration) -> Result<ureq::Response, HubError> {
        let port = PortFile::read(&self.data_dir).ok_or(HubError::Unavailable)?;
        let url = format!("http://127.0.0.1:{}{path}", port.port);
        let agent = ureq::AgentBuilder::new().timeout(timeout).build();
        let request = agent.request(method, &url).set(TOKEN_HEADER, &port.token);
        let response = match body {
            Body::Json(json) => request.send_json(json),
            Body::Bytes(bytes) => request.set("Content-Type", "application/octet-stream").send_bytes(bytes),
            Body::None => request.call(),
        };
        match response {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(code, r)) => {
                let body: Option<ErrorBody> = r.into_json().ok();
                Err(HubError::Status {
                    code,
                    error: body.as_ref().and_then(|b| b.error.clone()),
                    message: body.as_ref().and_then(|b| b.message.clone()),
                    fields: body.and_then(|b| b.fields),
                })
            }
            Err(ureq::Error::Transport(_)) => Err(HubError::Unavailable),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// One-shot fake hub: answers a single request with `status`/`body` and returns the
    /// request head it received.
    pub(crate) fn fake_hub(status: &str, body: &str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                head.push_str(&line);
            }
            let mut stream = stream;
            stream.write_all(response.as_bytes()).unwrap();
            let _ = reader.read(&mut [0u8; 1]);
            head
        });
        (port, handle)
    }

    pub(crate) fn client_for(port: u16) -> (tempfile::TempDir, HubClient) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(super::super::PORT_FILE_NAME),
            format!(r#"{{"v":1,"port":{port},"token":"secret","pid":1}}"#),
        )
        .unwrap();
        let client = HubClient::new(dir.path().to_path_buf());
        (dir, client)
    }

    #[test]
    fn adapters_sends_the_token_and_decodes_the_list() {
        let (port, server) = fake_hub(
            "200 OK",
            r#"[{"id":"claude-code","displayName":"Claude Code","hooks":{"state":"installed","configPath":"C:/x/settings.json"}},{"id":"mine","displayName":"Mine","hooks":null,"source":"user"}]"#,
        );
        let (_dir, client) = client_for(port);
        let adapters = client.adapters().unwrap();
        assert_eq!(adapters.len(), 2);
        assert_eq!(adapters[0].id, "claude-code");
        assert_eq!(adapters[0].hooks.as_ref().unwrap().state, "installed");
        // A protocol (user) adapter has no hooks; it must not break the whole list.
        assert_eq!(adapters[1].hooks, None);
        let head = server.join().unwrap();
        assert!(head.starts_with("GET /v1/adapters "));
        assert!(head.to_ascii_lowercase().contains("x-agenthub-token: secret"));
    }

    #[test]
    fn error_status_carries_the_hub_error_body() {
        let (port, server) = fake_hub(
            "422 Unprocessable Entity",
            r#"{"error":"invalidConfig","message":"settings.json is not valid JSON"}"#,
        );
        let (_dir, client) = client_for(port);
        let err = client.install_hooks("claude-code").unwrap_err();
        assert_eq!(
            err,
            HubError::Status {
                code: 422,
                error: Some("invalidConfig".into()),
                message: Some("settings.json is not valid JSON".into()),
                fields: None,
            }
        );
        assert!(server.join().unwrap().starts_with("POST /v1/adapters/claude-code/hooks/install "));
    }

    #[test]
    fn validation_errors_keep_the_per_field_messages() {
        let (port, server) = fake_hub(
            "400 Bad Request",
            r#"{"error":"invalidRequest","message":"Some settings are not valid.","fields":{"tasksGlob":["required"]}}"#,
        );
        let (_dir, client) = client_for(port);
        let err = client.request_json("PUT", "/v1/settings", Some(&serde_json::json!({}))).unwrap_err();
        let HubError::Status { code, fields, .. } = err else { panic!("expected a status error") };
        assert_eq!(code, 400);
        assert_eq!(fields, Some(BTreeMap::from([("tasksGlob".to_string(), vec!["required".to_string()])])));
        server.join().unwrap();
    }

    #[test]
    fn missing_port_file_or_dead_port_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let client = HubClient::new(dir.path().to_path_buf());
        assert_eq!(client.adapters().unwrap_err(), HubError::Unavailable);

        // A port nothing listens on: bind, read the port, drop the listener.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (_dir, client) = client_for(port);
        assert_eq!(client.adapters().unwrap_err(), HubError::Unavailable);
    }
}
