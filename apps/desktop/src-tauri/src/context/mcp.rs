//! MCP servers from JSON / JSONC / TOML config files. Only what is safe to show leaves
//! this module: server names, the executable's basename, the argument count, the URL's
//! origin and the NAMES of secret-bearing keys. Values of `env`, `headers`, `args`, URL
//! paths/queries and everything else in the file (for `~/.claude.json`: account, history,
//! …) stay in the parsed value, which is dropped here. Parse errors carry only a line
//! number, never text from the file.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::adapters::{ContextScope, ContextWalk, McpFormat, McpSourceDef};

use super::{ContextSource, Env, McpServer, McpTransport};

/// Config files above this size are not parsed (`~/.claude.json` with a long history is a
/// few MB).
const MAX_CONFIG_BYTES: u64 = 32 * 1024 * 1024;
/// Keys whose children are secrets: only their names are reported.
const SECRET_FIELDS: [&str; 7] = ["env", "headers", "http_headers", "env_http_headers", "environment", "oauth", "envFile"];

/// Strips `//` and `/* */` comments and trailing commas (outside strings) so `serde_json`
/// can read JSONC.
pub fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            ('/', Some('*')) => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    // Keep line numbers for error messages.
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i += 2;
                continue;
            }
            (',', _) => {
                if !matches!(next_significant(&chars, i + 1), Some('}') | Some(']')) {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// The next character after `from` that is neither whitespace nor inside a comment.
fn next_significant(chars: &[char], mut i: usize) -> Option<char> {
    while i < chars.len() {
        match (chars[i], chars.get(i + 1)) {
            (c, _) if c.is_whitespace() => i += 1,
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
            }
            (c, _) => return Some(c),
        }
    }
    None
}

fn parse(text: &str, format: McpFormat) -> Result<Value, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    match format {
        McpFormat::Json => serde_json::from_str(text).map_err(|e| format!("invalid JSON (line {})", e.line())),
        McpFormat::Jsonc => serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("invalid JSON (line {})", e.line())),
        McpFormat::Toml => {
            let value: toml::Value = toml::from_str(text).map_err(|e| match e.span() {
                Some(span) => format!("invalid TOML (line {})", text[..span.start.min(text.len())].matches('\n').count() + 1),
                None => "invalid TOML".to_string(),
            })?;
            serde_json::to_value(value).map_err(|_| "invalid TOML".to_string())
        }
    }
}

/// `scheme://host[:port]` (no user info, path, query or fragment).
pub fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty()).then(|| format!("{}://{host}", scheme.to_ascii_lowercase()))
}

/// Basename of an executable path (`C:\tools\uvx.exe` → `uvx.exe`).
pub fn basename(command: &str) -> String {
    command.trim().rsplit(['/', '\\']).next().unwrap_or_default().to_string()
}

fn secret_keys(server: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for field in SECRET_FIELDS {
        match server.get(field) {
            Some(Value::Object(m)) => out.extend(m.keys().map(|k| format!("{field}.{k}"))),
            Some(Value::Array(items)) => out.extend(items.iter().filter_map(Value::as_str).map(|s| {
                let name = s.split_once('=').map_or(s, |(k, _)| k);
                format!("{field}.{name}")
            })),
            Some(Value::String(_)) => out.push(field.to_string()),
            _ => {}
        }
    }
    out
}

fn server(name: &str, v: &Value, scope: ContextScope, source: &str) -> Option<McpServer> {
    let m = v.as_object()?;
    let typ = m.get("type").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let args = m.get("args").and_then(Value::as_array).map_or(0, Vec::len);
    // OpenCode: `"command": ["npx", "-y", "pkg"]`.
    let (command, extra_args) = match m.get("command") {
        Some(Value::String(s)) => (Some(basename(s)), 0),
        Some(Value::Array(a)) => (a.first().and_then(Value::as_str).map(basename), a.len().saturating_sub(1)),
        _ => (None, 0),
    };
    let raw_url = ["url", "httpUrl", "serverUrl"].iter().find_map(|k| m.get(*k).and_then(Value::as_str));
    let typ = typ.as_deref();
    let transport = if command.is_some() || matches!(typ, Some("stdio" | "local")) {
        McpTransport::Stdio
    } else if typ == Some("sse") {
        McpTransport::Sse
    } else if raw_url.is_some() || matches!(typ, Some("http" | "streamable-http" | "streamablehttp" | "remote")) {
        McpTransport::Http
    } else {
        McpTransport::Unknown
    };
    Some(McpServer {
        name: name.to_string(),
        scope,
        source: source.to_string(),
        transport,
        command: command.filter(|c| !c.is_empty()),
        arg_count: u32::try_from(args + extra_args).unwrap_or(u32::MAX),
        url: raw_url.and_then(url_origin),
        secret_keys: secret_keys(m),
        disabled: m.get("disabled") == Some(&Value::Bool(true)) || m.get("enabled") == Some(&Value::Bool(false)),
        shadowed_by: None,
    })
}

fn servers_of(map: &Map<String, Value>, scope: ContextScope, source: &str) -> Vec<McpServer> {
    map.iter().filter_map(|(name, v)| server(name, v, scope, source)).collect()
}

/// `projects[<root>]` of `~/.claude.json`: keys are matched with `/` and `\` and, on
/// Windows, case-insensitively.
fn project_entry<'a>(value: &'a Value, env: &Env) -> Option<&'a Map<String, Value>> {
    let norm = |s: &str| {
        let s = s.replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if env.windows() {
            s.to_lowercase()
        } else {
            s
        }
    };
    let root = norm(&env.root.to_string_lossy());
    value
        .get("projects")?
        .as_object()?
        .iter()
        .find(|(k, _)| norm(k) == root)
        .and_then(|(_, v)| v.get("mcpServers"))
        .and_then(Value::as_object)
}

fn candidates(env: &Env, def: &McpSourceDef) -> Vec<PathBuf> {
    let relative = !def.path.starts_with('~') && !Path::new(&def.path).is_absolute();
    match def.walk {
        // Nearest directory first: it wins on a name clash.
        Some(ContextWalk::Repo) if relative => env
            .walk_dirs(ContextWalk::Repo)
            .iter()
            .rev()
            .filter_map(|d| env.resolve_from(&def.path, d))
            .collect(),
        _ => env.resolve(&def.path).into_iter().collect(),
    }
}

fn rank(scope: ContextScope) -> u8 {
    match scope {
        ContextScope::Local => 3,
        ContextScope::Project => 2,
        ContextScope::User => 1,
        ContextScope::Managed => 0,
    }
}

/// Servers and the config files looked at. Shadowing: a name defined in several places
/// is used from the highest scope (local > project > user); within a scope the source
/// listed first in adapter.json (for `walk`, the directory nearest the root) wins.
pub fn collect(env: &Env, defs: &[McpSourceDef]) -> (Vec<McpServer>, Vec<ContextSource>) {
    let mut servers: Vec<McpServer> = Vec::new();
    let mut sources = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for def in defs.iter().filter(|d| env.os_matches(d.os)) {
        for path in candidates(env, def) {
            if !seen.insert((env.key(&path), def.scope)) {
                continue;
            }
            let display = env.display(&path);
            let mut src = ContextSource {
                scope: def.scope,
                path: path.to_string_lossy().into_owned(),
                display: display.clone(),
                exists: path.is_file(),
                error: None,
                server_count: 0,
            };
            let mut local = def.project_pointer.then(|| ContextSource {
                scope: ContextScope::Local,
                ..src.clone()
            });
            if src.exists {
                let parsed = match std::fs::metadata(&path) {
                    Ok(m) if m.len() > MAX_CONFIG_BYTES => Err("file too large".to_string()),
                    _ => std::fs::read_to_string(&path).map_err(|e| e.kind().to_string()).and_then(|t| parse(&t, def.format)),
                };
                match parsed {
                    Ok(value) => {
                        let found = def.pointer.list().into_iter().find_map(|p| value.pointer(p));
                        match found {
                            Some(Value::Object(map)) => {
                                let list = servers_of(map, def.scope, &display);
                                src.server_count = list.len() as u32;
                                servers.extend(list);
                            }
                            Some(_) => src.error = Some("server list is not an object".to_string()),
                            None => {}
                        }
                        if let (Some(local), Some(map)) = (local.as_mut(), project_entry(&value, env)) {
                            let list = servers_of(map, ContextScope::Local, &display);
                            local.server_count = list.len() as u32;
                            servers.extend(list);
                        }
                    }
                    Err(e) => src.error = Some(e),
                }
            }
            sources.push(src);
            sources.extend(local);
        }
    }
    // Precedence: higher scope first, then discovery order (stable sort).
    let mut order: Vec<usize> = (0..servers.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(rank(servers[i].scope)));
    let mut winners: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for i in order {
        match winners.get(&servers[i].name) {
            Some(by) => servers[i].shadowed_by = Some(by.clone()),
            None => {
                winners.insert(servers[i].name.clone(), servers[i].source.clone());
            }
        }
    }
    (servers, sources)
}
