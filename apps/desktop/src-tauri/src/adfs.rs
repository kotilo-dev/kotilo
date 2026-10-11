//! `adfs://` asynchronous URI scheme protocol (Faz 3 spec §1, §5.13).
//!
//! Serves workspace files directly to the webview (`<img src>`, `<iframe src>`, ...)
//! without going through IPC/JSON. Addressed exactly like every command —
//! `(workspaceId, rel)` — but as a URL. On Windows a custom scheme is always exposed as
//! `http://<scheme>.localhost/<path>` (see the doc comment on
//! `Builder::register_asynchronous_uri_scheme_protocol`), so the frontend's `adfsUrl`
//! helper builds `http://adfs.localhost/<workspaceId>/<rel, percent-encoded per
//! segment>`.
//!
//! Every request is handled on its own `std::thread` (spec §5.13: reading must not block
//! the calling/webview thread, especially for a large image/PDF/video), and any failure
//! — unknown workspace, `rel` escaping the root, missing file, a directory instead of a
//! file, an I/O error — collapses to a bare 404. The response never explains *why*, so a
//! script-enabled HTML preview probing the scheme learns nothing extra.

use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::fsguard;
use crate::workspace::WorkspaceStore;

/// Spec §5.13, widened by review finding #9: every `adfs://` response gets this header,
/// not just `.html`/`.htm` ones — an image/PDF/etc. response never executes anything so
/// the CSP is harmless there, but sending it unconditionally means an `.html` file served
/// with a misdetected/absent extension (or reached some other way in the future) doesn't
/// silently lose the protection. Blocks a script-enabled HTML preview from using
/// `fetch`/`XHR`/form-post to reach anything outside this scheme's own files (it can
/// still load further `adfs.localhost` resources, e.g. its own images).
const CSP: &str =
    "default-src http://adfs.localhost data: 'unsafe-inline'; connect-src 'none'; form-action 'none'";

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Vec::new())
        .expect("a status-only response is always a valid http::Response")
}

/// Splits the request path (`/<workspaceId>/<rel segments...>`) into `(workspaceId,
/// rel)`, percent-decoding **each segment separately** (spec §5.13) so a `%2F` inside a
/// filename can never be mistaken for a `/` separator. `rel` is rejoined with `/`; an
/// empty/missing workspace id segment is rejected.
fn decode_request_path(path: &str) -> Option<(String, String)> {
    let mut segments = path.trim_start_matches('/').split('/');

    let workspace_id = percent_encoding::percent_decode_str(segments.next()?)
        .decode_utf8()
        .ok()?
        .into_owned();
    if workspace_id.is_empty() {
        return None;
    }

    let mut rel_parts = Vec::new();
    for segment in segments {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .ok()?;
        rel_parts.push(decoded.into_owned());
    }
    Some((workspace_id, rel_parts.join("/")))
}

/// Builds the `200 OK` response for a successfully-read file. Split out from [`handle`]
/// so the header set — in particular that [`CSP`] is unconditional, not just for
/// `.html`/`.htm` (review finding #9) — is directly unit testable without a full
/// `AppHandle`/`WorkspaceStore`.
fn success_response(bytes: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("Content-Security-Policy", CSP);
    builder.body(bytes).unwrap_or_else(|_| not_found())
}

fn handle<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some((workspace_id, rel)) = decode_request_path(request.uri().path()) else {
        return not_found();
    };

    let store = app.state::<WorkspaceStore>();
    let Ok(root) = store.find_path(&workspace_id) else {
        return not_found();
    };
    let Ok(target) = fsguard::resolve(Path::new(&root), &rel) else {
        return not_found();
    };
    if !target.is_file() {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return not_found();
    };

    let mime = mime_guess::from_path(&target)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    success_response(bytes, &mime)
}

/// The protocol handler passed to
/// [`tauri::Builder::register_asynchronous_uri_scheme_protocol`]. Hands the actual work
/// off to a fresh thread and responds from there, so the caller (the webview's IPC/net
/// thread) is never blocked on disk I/O.
pub fn handler<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let response = handle(&app, &request);
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_workspace_id_and_rel_segments() {
        let (ws, rel) = decode_request_path("/ws-1/src/a%20b.txt").unwrap();
        assert_eq!(ws, "ws-1");
        assert_eq!(rel, "src/a b.txt");
    }

    #[test]
    fn decodes_percent_encoded_hash_and_turkish_chars() {
        let (ws, rel) = decode_request_path("/ws-1/%C4%9F%C3%BC%C5%9F%20%23.md").unwrap();
        assert_eq!(ws, "ws-1");
        assert_eq!(rel, "ğüş #.md");
    }

    #[test]
    fn root_file_has_empty_rel() {
        let (ws, rel) = decode_request_path("/ws-1/readme.md").unwrap();
        assert_eq!(ws, "ws-1");
        assert_eq!(rel, "readme.md");
    }

    #[test]
    fn missing_workspace_segment_is_none() {
        assert!(decode_request_path("/").is_none());
        assert!(decode_request_path("").is_none());
    }

    /// Review finding #9: the CSP header must be present on *every* response, not just
    /// `.html`/`.htm` ones — checked here for an image and a PDF mime type, neither of
    /// which the old code sent it for.
    #[test]
    fn csp_header_is_sent_for_non_html_mime_types() {
        for mime in ["image/png", "application/pdf", "text/plain"] {
            let response = success_response(b"bytes".to_vec(), mime);
            let csp = response
                .headers()
                .get("Content-Security-Policy")
                .and_then(|v| v.to_str().ok());
            assert_eq!(csp, Some(CSP), "missing/wrong CSP header for mime {mime}");
        }
    }

    #[test]
    fn csp_header_is_still_sent_for_html() {
        let response = success_response(b"<html></html>".to_vec(), "text/html");
        assert_eq!(
            response
                .headers()
                .get("Content-Security-Policy")
                .and_then(|v| v.to_str().ok()),
            Some(CSP)
        );
    }
}
