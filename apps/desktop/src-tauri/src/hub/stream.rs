//! One WebSocket to the hub's `/v1/stream`, relayed to the webview as Tauri events
//! (`hub:status` `{connected}`, `hub:event` `{type, data}`). The token stays here. Each
//! connect re-reads `port.json`, so a restarted hub (new port and token) is picked up.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::Message;

use super::{PortFile, TOKEN_HEADER};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(5);

/// One stream frame, forwarded as-is to the webview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// `None` for anything that isn't a `{type, data}` object (ignored, never fatal).
pub fn parse_frame(text: &str) -> Option<StreamEvent> {
    let event: StreamEvent = serde_json::from_str(text).ok()?;
    (!event.kind.is_empty()).then_some(event)
}

#[derive(Debug)]
pub enum StreamError {
    NoPortFile,
    Connect(String),
}

/// Connects once and pumps frames into `on_event` until the socket closes or errors.
/// `on_connected` runs after the handshake succeeded.
pub fn connect_and_pump(
    data_dir: &Path,
    on_connected: &mut dyn FnMut(),
    on_event: &mut dyn FnMut(StreamEvent),
) -> Result<(), StreamError> {
    let port = PortFile::read(data_dir).ok_or(StreamError::NoPortFile)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port.port));
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| StreamError::Connect(e.to_string()))?;
    let mut request = format!("ws://127.0.0.1:{}/v1/stream", port.port)
        .into_client_request()
        .map_err(|e| StreamError::Connect(e.to_string()))?;
    let token = HeaderValue::from_str(&port.token).map_err(|e| StreamError::Connect(e.to_string()))?;
    request.headers_mut().insert(TOKEN_HEADER, token);
    let (mut socket, _) = tungstenite::client::client(request, tcp).map_err(|e| StreamError::Connect(e.to_string()))?;
    on_connected();
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Some(event) = parse_frame(text.as_str()) {
                    on_event(event);
                }
            }
            Ok(Message::Close(_)) | Err(_) => return Ok(()),
            Ok(_) => {}
        }
    }
}

/// Runs forever on its own thread: connect, pump, report status, retry with backoff.
pub fn spawn(app: tauri::AppHandle, data_dir: PathBuf) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut retry = RETRY_MIN;
        loop {
            let result = connect_and_pump(
                &data_dir,
                &mut || {
                    log::info!("hub stream: connected");
                    crate::commands::dictation::on_hub_connected(&app);
                    let _ = app.emit("hub:status", serde_json::json!({ "connected": true }));
                },
                &mut |event| {
                    let _ = app.emit("hub:event", event);
                },
            );
            let was_connected = result.is_ok();
            if was_connected {
                log::info!("hub stream: disconnected");
                let _ = app.emit("hub:status", serde_json::json!({ "connected": false }));
                retry = RETRY_MIN;
            } else if let Err(StreamError::Connect(e)) = &result {
                log::debug!("hub stream: connect failed: {e}");
            }
            std::thread::sleep(retry);
            if !was_connected {
                retry = (retry * 2).min(RETRY_MAX);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn parse_frame_accepts_type_and_data_and_ignores_junk() {
        let e = parse_frame(r#"{"type":"sessions","data":[{"sessionId":"s"}]}"#).unwrap();
        assert_eq!(e.kind, "sessions");
        assert_eq!(e.data[0]["sessionId"], "s");
        assert_eq!(parse_frame(r#"{"type":"health"}"#).unwrap().data, serde_json::Value::Null);
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame(r#"{"type":""}"#).is_none());
        assert!(parse_frame(r#"[1,2]"#).is_none());
    }

    #[test]
    // The handshake callback's Result type is fixed by tungstenite's Callback trait.
    #[allow(clippy::result_large_err)]
    fn pumps_frames_from_a_fake_hub_and_sends_the_token() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut token = None;
            let mut ws = tungstenite::accept_hdr(tcp, |req: &tungstenite::handshake::server::Request, resp| {
                token = req.headers().get(TOKEN_HEADER).map(|v| v.to_str().unwrap().to_string());
                Ok(resp)
            })
            .unwrap();
            ws.send(Message::text(r#"{"type":"sessions","data":[]}"#)).unwrap();
            ws.send(Message::text("garbage")).unwrap();
            ws.send(Message::text(r#"{"type":"usage","data":{"at":"x"}}"#)).unwrap();
            ws.close(None).unwrap();
            let _ = ws.flush();
            token
        });

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(super::super::PORT_FILE_NAME),
            format!(r#"{{"v":1,"port":{port},"token":"secret","pid":1}}"#),
        )
        .unwrap();
        let mut connected = false;
        let mut events = Vec::new();
        connect_and_pump(dir.path(), &mut || connected = true, &mut |e| events.push(e.kind)).unwrap();

        assert!(connected);
        assert_eq!(events, vec!["sessions", "usage"]);
        assert_eq!(server.join().unwrap().as_deref(), Some("secret"));
    }

    #[test]
    fn no_port_file_is_reported_without_connecting() {
        let dir = tempfile::tempdir().unwrap();
        let result = connect_and_pump(dir.path(), &mut || {}, &mut |_| {});
        assert!(matches!(result, Err(StreamError::NoPortFile)));
    }
}
