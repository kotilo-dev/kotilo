//! Link extraction from a Markdown doc without a Markdown library: links / images / reference
//! definitions, `file=` on fenced code blocks, path-like inline code and the optional front
//! matter `covers:` list. Targets come back raw (not yet resolved against the repo).

use crate::LinkSource;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLink {
    /// `Link`: as written (relative to the doc's folder, or `/`-rooted). `CodeBlock`,
    /// `FrontMatter`: relative to the repo root. `Inline`: the code span's text.
    pub target: String,
    pub source: LinkSource,
    /// 1-based line in the doc.
    pub line: u32,
}

pub fn extract(text: &str) -> Vec<RawLink> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut start = 0;
    if lines.first().map(|l| l.trim_end()) == Some("---") {
        if let Some(end) = lines.iter().skip(1).position(|l| matches!(l.trim_end(), "---" | "...")) {
            front_matter(&lines[1..=end], &mut out);
            start = end + 2;
        }
    }
    let mut fence: Option<(u8, usize)> = None;
    for (index, line) in lines.iter().enumerate().skip(start) {
        let no = line_no(index);
        if let Some((ch, len)) = fence {
            if is_closing_fence(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some((ch, len, info)) = opening_fence(line) {
            fence = Some((ch, len));
            for token in info.split(|c: char| c.is_whitespace() || c == ',' || c == '{' || c == '}') {
                if let Some(path) = token.strip_prefix("file=") {
                    let path = path.trim_matches(|c| c == '"' || c == '\'');
                    if !path.is_empty() {
                        out.push(RawLink { target: path.to_string(), source: LinkSource::CodeBlock, line: no });
                    }
                }
            }
            continue;
        }
        scan_line(line, no, &mut out);
    }
    out
}

fn line_no(index: usize) -> u32 {
    u32::try_from(index + 1).unwrap_or(u32::MAX)
}

/// ```` ``` ```` / `~~~` (3+) opening a fenced block: `(char, length, info string)`.
fn opening_fence(line: &str) -> Option<(u8, usize, &str)> {
    let trimmed = line.trim_start();
    let ch = *trimmed.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = trimmed.bytes().take_while(|b| *b == ch).count();
    if len < 3 {
        return None;
    }
    let info = &trimmed[len..];
    if ch == b'`' && info.contains('`') {
        return None;
    }
    Some((ch, len, info.trim()))
}

fn is_closing_fence(line: &str, ch: u8, open_len: usize) -> bool {
    let trimmed = line.trim();
    let len = trimmed.bytes().take_while(|b| *b == ch).count();
    len >= open_len && len == trimmed.len()
}

/// `covers:` as a flow list (`[a, b]`, may span lines), a block list (`- a`) or one scalar.
fn front_matter(lines: &[&str], out: &mut Vec<RawLink>) {
    let mut i = 0;
    while i < lines.len() {
        let Some(rest) = lines[i].strip_prefix("covers:") else {
            i += 1;
            continue;
        };
        let no = line_no(i + 1);
        let rest = rest.trim();
        if let Some(flow) = rest.strip_prefix('[') {
            let mut body = flow.to_string();
            while !body.contains(']') && i + 1 < lines.len() {
                i += 1;
                body.push(',');
                body.push_str(lines[i]);
            }
            let body = body.split(']').next().unwrap_or("");
            for item in body.split(',') {
                push_front_matter_item(item, no, out);
            }
        } else if rest.is_empty() || rest.starts_with('#') {
            while i + 1 < lines.len() {
                let next = lines[i + 1];
                let Some(item) = next.trim_start().strip_prefix('-') else {
                    if next.trim().is_empty() || next.trim_start().starts_with('#') {
                        i += 1;
                        continue;
                    }
                    break;
                };
                i += 1;
                push_front_matter_item(item, line_no(i + 1), out);
            }
        } else {
            push_front_matter_item(rest, no, out);
        }
        i += 1;
    }
}

fn push_front_matter_item(item: &str, line: u32, out: &mut Vec<RawLink>) {
    let item = item.split(" #").next().unwrap_or("").trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if !item.is_empty() {
        out.push(RawLink { target: item.to_string(), source: LinkSource::FrontMatter, line });
    }
}

fn scan_line(line: &str, no: u32, out: &mut Vec<RawLink>) {
    if let Some(target) = reference_definition(line) {
        out.push(RawLink { target, source: LinkSource::Link, line: no });
        return;
    }
    let (text, spans) = split_code_spans(line);
    for span in spans {
        if is_path_like(&span) {
            out.push(RawLink { target: span, source: LinkSource::Inline, line: no });
        }
    }
    let mut rest = text.as_str();
    while let Some(pos) = rest.find("](") {
        let after = &rest[pos + 2..];
        if let Some((target, used)) = link_destination(after) {
            if !target.is_empty() {
                out.push(RawLink { target, source: LinkSource::Link, line: no });
            }
            rest = &after[used..];
        } else {
            rest = after;
        }
    }
}

/// `[label]: target "title"` (up to 3 spaces of indent; footnotes `[^1]:` are not links).
fn reference_definition(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = line[indent..].strip_prefix('[')?;
    if rest.starts_with('^') {
        return None;
    }
    let close = rest.find("]:")?;
    if close == 0 || rest[..close].contains(']') {
        return None;
    }
    let dest = rest[close + 2..].trim_start();
    let dest = if let Some(angled) = dest.strip_prefix('<') {
        angled.split('>').next().unwrap_or("")
    } else {
        dest.split_whitespace().next().unwrap_or("")
    };
    (!dest.is_empty()).then(|| dest.to_string())
}

/// The line with code spans blanked out, plus the spans' contents.
fn split_code_spans(line: &str) -> (String, Vec<String>) {
    let bytes = line.as_bytes();
    let mut text = String::with_capacity(line.len());
    let mut spans = Vec::new();
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
        let open_end = i + run;
        // Find a closing run of exactly the same length.
        let mut j = open_end;
        let mut close = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let r = bytes[j..].iter().take_while(|b| **b == b'`').count();
                if r == run {
                    close = Some(j);
                    break;
                }
                j += r;
            } else {
                j += 1;
            }
        }
        match close {
            Some(c) => {
                text.push_str(&line[copied..i]);
                text.push(' ');
                let content = &line[open_end..c];
                let content = if content.len() >= 2 && content.starts_with(' ') && content.ends_with(' ') {
                    &content[1..content.len() - 1]
                } else {
                    content
                };
                spans.push(content.to_string());
                i = c + run;
                copied = i;
            }
            None => i = open_end,
        }
    }
    text.push_str(&line[copied..]);
    (text, spans)
}

/// Parses an inline link destination after `](`: `<dest>` or a run without whitespace with
/// balanced parentheses. Returns the destination and the bytes consumed.
fn link_destination(s: &str) -> Option<(String, usize)> {
    let lead = s.len() - s.trim_start().len();
    let body = &s[lead..];
    if let Some(angled) = body.strip_prefix('<') {
        let end = angled.find('>')?;
        return Some((angled[..end].to_string(), lead + end + 2));
    }
    let mut depth = 0usize;
    let mut dest = String::new();
    let mut chars = body.char_indices();
    while let Some((idx, c)) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some((_, escaped)) => dest.push(escaped),
                None => dest.push('\\'),
            },
            '(' => {
                depth += 1;
                dest.push(c);
            }
            ')' if depth == 0 => return Some((dest, lead + idx + 1)),
            ')' => {
                depth -= 1;
                dest.push(c);
            }
            c if c.is_whitespace() => {
                // A title follows; the link ends at the next `)`.
                let end = body[idx..].find(')').map(|p| idx + p + 1).unwrap_or(body.len());
                return Some((dest, lead + end));
            }
            c => dest.push(c),
        }
    }
    None
}

/// Inline code that looks like a repo path: `^[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@*-]+)+/?$`.
pub fn is_path_like(s: &str) -> bool {
    let s = s.strip_suffix('/').unwrap_or(s);
    let mut segments = s.split('/');
    let first_ok = segments
        .next()
        .is_some_and(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || "_.@-".contains(c)));
    let mut rest = 0;
    for seg in segments {
        if seg.is_empty() || !seg.chars().all(|c| c.is_ascii_alphanumeric() || "_.@*-".contains(c)) {
            return false;
        }
        rest += 1;
    }
    first_ok && rest > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(text: &str) -> Vec<(String, LinkSource, u32)> {
        extract(text).into_iter().map(|l| (l.target, l.source, l.line)).collect()
    }

    fn t(target: &str, source: LinkSource, line: u32) -> (String, LinkSource, u32) {
        (target.to_string(), source, line)
    }

    #[test]
    fn markdown_links_images_and_references() {
        let text = "# Title\n\
                    See [a](../src/a.rs) and ![img](img/x.png \"title\").\n\
                    [ref]: src/b.rs#L10 \"Title\"\n\
                    [^1]: not a link\n\
                    [angle](<docs/with space.md>) [paren](src/f(1).rs) [esc](a\\_b.md)\n";
        assert_eq!(
            links(text),
            vec![
                t("../src/a.rs", LinkSource::Link, 2),
                t("img/x.png", LinkSource::Link, 2),
                t("src/b.rs#L10", LinkSource::Link, 3),
                t("docs/with space.md", LinkSource::Link, 5),
                t("src/f(1).rs", LinkSource::Link, 5),
                t("a_b.md", LinkSource::Link, 5),
            ]
        );
    }

    #[test]
    fn fenced_code_is_skipped_but_file_info_is_a_link() {
        let text = "```rust file=src/a.rs\n[x](inside.rs)\n`src/inside.rs`\n```\n\
                    ~~~~ {file=\"src/b.rs\"}\n~~~\nstill inside [y](y.rs)\n~~~~\n\
                    ```\nno info\n```\n[after](after.rs)\n";
        assert_eq!(
            links(text),
            vec![t("src/a.rs", LinkSource::CodeBlock, 1), t("src/b.rs", LinkSource::CodeBlock, 5), t("after.rs", LinkSource::Link, 12)]
        );
    }

    #[test]
    fn inline_code_paths_and_links_inside_code_spans() {
        let text = "Use `src/a.rs`, `npm run build`, `a/b c`, ``x/y/``, `@scope/pkg` and `[n](no.rs)`.\n";
        assert_eq!(
            links(text),
            vec![t("src/a.rs", LinkSource::Inline, 1), t("x/y/", LinkSource::Inline, 1), t("@scope/pkg", LinkSource::Inline, 1)]
        );
    }

    #[test]
    fn path_like_matches_the_contract_pattern() {
        for ok in ["src/a.rs", "a/b/", "crates/*/src", ".github/workflows/x.yml", "a-b/c_d.e"] {
            assert!(is_path_like(ok), "{ok}");
        }
        for bad in ["a", "a b/c", "http://x/y", "a//b", "/abs/path", "a/b c", "*/x", ""] {
            assert!(!is_path_like(bad), "{bad}");
        }
    }

    #[test]
    fn front_matter_flow_block_and_scalar() {
        let flow = "---\ntitle: X\ncovers: [src/a.rs, \"hub/**\"]\n---\n[l](x.md)\n";
        assert_eq!(
            links(flow),
            vec![t("src/a.rs", LinkSource::FrontMatter, 3), t("hub/**", LinkSource::FrontMatter, 3), t("x.md", LinkSource::Link, 5)]
        );
        let block = "---\ncovers:\n  - src/a.rs\n  - 'b/**' # comment\nother: [z]\n---\n";
        assert_eq!(links(block), vec![t("src/a.rs", LinkSource::FrontMatter, 3), t("b/**", LinkSource::FrontMatter, 4)]);
        let multi = "---\ncovers: [a/x,\n  b/y]\n---\n";
        assert_eq!(links(multi), vec![t("a/x", LinkSource::FrontMatter, 2), t("b/y", LinkSource::FrontMatter, 2)]);
        let scalar = "\u{feff}---\r\ncovers: src/only.rs\r\n---\r\n";
        assert_eq!(links(scalar), vec![t("src/only.rs", LinkSource::FrontMatter, 2)]);
        // No closing marker: not front matter, and `---` alone is a rule.
        assert_eq!(links("---\ncovers: [a/b]\n"), vec![]);
    }
}
