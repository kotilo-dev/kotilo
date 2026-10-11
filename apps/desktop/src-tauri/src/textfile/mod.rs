//! Pure text-file detection / EOL-normalization / encode-decode (Faz 3 spec §1, §5.9,
//! §5.10, §5.12). No I/O in this module — every function takes bytes/strings in and
//! returns bytes/strings out, which is what makes the byte-identical round-trip test
//! matrix in §5.12 possible without touching the filesystem.
//!
//! The only impure input either function needs is the system ANSI code page
//! (`GetACP()`); [`decode`]/[`encode`] read it themselves, but the actual logic lives in
//! [`decode_with_codepage`]/[`encode_with_codepage`], which take it as a plain `u32` —
//! that's what the unit tests call, so they're hermetic instead of depending on the
//! locale of whatever machine happens to run `cargo test`.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Ansi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

/// Result of [`decode`]/[`decode_with_codepage`]: `text` is always LF-normalized (a lone
/// `\r` is folded in too, per §5.9), never containing a bare `\r`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    pub text: String,
    pub encoding: TextEncoding,
    pub eol: Eol,
    pub mixed_eol: bool,
    /// `true` when the byte sequence could not be decoded losslessly in its detected
    /// encoding and a lossy (replacement-character) decode was used instead — the caller
    /// must force `readOnly = true` in that case (spec §5.10: "asla lossy yazılmaz").
    pub lossy: bool,
}

/// First-8-KB binary sniff (former `fs_sniff`, folded into `fs_read_text` per spec
/// §5.3): a UTF-16 BOM makes a file "text" unconditionally (UTF-16 text is full of NUL
/// bytes for any ASCII character), otherwise a NUL byte anywhere in the first 8 KB means
/// "binary".
pub fn is_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    let probe_len = bytes.len().min(8192);
    bytes[..probe_len].contains(&0)
}

/// Decodes `bytes` using the live system ANSI code page (`GetACP()`) if it falls back to
/// `ansi`. See [`decode_with_codepage`] for the actual (pure, testable) logic.
pub fn decode(bytes: &[u8]) -> Decoded {
    decode_with_codepage(bytes, get_acp())
}

pub fn decode_with_codepage(bytes: &[u8], acp: u32) -> Decoded {
    let (raw_text, encoding, lossy) = decode_bytes(bytes, acp);
    let (text, eol, mixed_eol) = normalize_eol(&raw_text);
    Decoded {
        text,
        encoding,
        eol,
        mixed_eol,
        lossy,
    }
}

fn decode_bytes(bytes: &[u8], acp: u32) -> (String, TextEncoding, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEFu8, 0xBB, 0xBF]) {
        return match encoding_rs::UTF_8.decode_without_bom_handling_and_without_replacement(rest) {
            Some(text) => (text.into_owned(), TextEncoding::Utf8Bom, false),
            None => (
                lossy_decode(encoding_rs::UTF_8, rest),
                TextEncoding::Utf8Bom,
                true,
            ),
        };
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFFu8, 0xFE]) {
        return match encoding_rs::UTF_16LE.decode_without_bom_handling_and_without_replacement(rest)
        {
            Some(text) => (text.into_owned(), TextEncoding::Utf16Le, false),
            None => (
                lossy_decode(encoding_rs::UTF_16LE, rest),
                TextEncoding::Utf16Le,
                true,
            ),
        };
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFEu8, 0xFF]) {
        return match encoding_rs::UTF_16BE.decode_without_bom_handling_and_without_replacement(rest)
        {
            Some(text) => (text.into_owned(), TextEncoding::Utf16Be, false),
            None => (
                lossy_decode(encoding_rs::UTF_16BE, rest),
                TextEncoding::Utf16Be,
                true,
            ),
        };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), TextEncoding::Utf8, false);
    }
    decode_ansi(bytes, acp)
}

fn lossy_decode(encoding: &'static encoding_rs::Encoding, bytes: &[u8]) -> String {
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

/// `GetACP()` returns a `UINT`, but `codepage::to_encoding` (and every real code page
/// number) fits in `u16`; a value that doesn't (should never happen in practice) is
/// treated the same as "no mapping". Code page `65001` is special-cased to "no mapping"
/// too — see the doc comment on [`decode_ansi`].
fn codepage_to_encoding(acp: u32) -> Option<&'static encoding_rs::Encoding> {
    if acp == 65001 {
        return None;
    }
    u16::try_from(acp).ok().and_then(codepage::to_encoding)
}

/// §5.10: `GetACP()` → `codepage::to_encoding`. Code page `65001` (the bytes already
/// failed the strict-UTF-8 check above, so this is a contradiction — a system whose ANSI
/// code page is "UTF-8" but a file that isn't valid UTF-8) and a code page with no
/// `encoding_rs` mapping both fall back to a **lossy** decode (never a hard failure) with
/// `lossy = true`, so the caller can force the document read-only.
fn decode_ansi(bytes: &[u8], acp: u32) -> (String, TextEncoding, bool) {
    let mapped = codepage_to_encoding(acp);
    match mapped {
        Some(enc) => match enc.decode_without_bom_handling_and_without_replacement(bytes) {
            Some(text) => (text.into_owned(), TextEncoding::Ansi, false),
            None => (lossy_decode(enc, bytes), TextEncoding::Ansi, true),
        },
        None => (
            lossy_decode(encoding_rs::WINDOWS_1252, bytes),
            TextEncoding::Ansi,
            true,
        ),
    }
}

/// Folds CRLF, lone LF and lone CR into a single `\n` (spec §5.9 — a lone `\r` is
/// normalized too, and on its own forces `mixedEol = true` since Monaco treats it as a
/// line ending in its own right). `eol` is whichever of CRLF/LF is more frequent; when
/// neither appears at all (including "no line endings in the file"), it defaults to
/// `Crlf`. Leading/trailing content (in particular a trailing-newline's
/// presence/absence) is preserved exactly — this only ever rewrites `\r`/`\r\n` bytes to
/// `\n`, nothing else.
fn normalize_eol(input: &str) -> (String, Eol, bool) {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut crlf = 0u32;
    let mut lone_lf = 0u32;
    let mut lone_cr = 0u32;

    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\r' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                crlf += 1;
                out.push(b'\n');
                i += 2;
            } else {
                lone_cr += 1;
                out.push(b'\n');
                i += 1;
            }
        } else if b == b'\n' {
            lone_lf += 1;
            out.push(b'\n');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }

    let eol = if crlf >= lone_lf { Eol::Crlf } else { Eol::Lf };
    let mixed_eol = lone_cr > 0 || (crlf > 0 && lone_lf > 0);
    // SAFETY: `input` was valid UTF-8 and every byte we touched was an ASCII '\r' or
    // '\n' rewritten to another ASCII '\n' — a UTF-8 continuation/lead byte is never
    // 0x0D/0x0A, so every other byte is copied through unchanged and the sequence is
    // still valid UTF-8.
    let text = unsafe { String::from_utf8_unchecked(out) };
    (text, eol, mixed_eol)
}

/// Encodes `text` (LF-only, as it comes out of [`decode`]/Monaco) back to bytes: applies
/// `eol`, then the charset + BOM for `encoding`. Returns `Err(message)` only for `ansi`
/// when the text contains a character the system code page can't represent, or the code
/// page itself can't be resolved — writing a lossy ANSI file is never allowed (spec
/// §5.10).
pub fn encode(text: &str, encoding: TextEncoding, eol: Eol) -> Result<Vec<u8>, String> {
    encode_with_codepage(text, encoding, eol, get_acp())
}

pub fn encode_with_codepage(
    text: &str,
    encoding: TextEncoding,
    eol: Eol,
    acp: u32,
) -> Result<Vec<u8>, String> {
    let with_eol: Cow<'_, str> = match eol {
        Eol::Lf => Cow::Borrowed(text),
        Eol::Crlf => Cow::Owned(text.replace('\n', "\r\n")),
    };
    match encoding {
        TextEncoding::Utf8 => Ok(with_eol.as_bytes().to_vec()),
        TextEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(with_eol.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(with_eol.as_bytes());
            Ok(out)
        }
        TextEncoding::Utf16Le => {
            let mut out = Vec::with_capacity(with_eol.len() * 2 + 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for unit in with_eol.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        TextEncoding::Utf16Be => {
            let mut out = Vec::with_capacity(with_eol.len() * 2 + 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for unit in with_eol.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(out)
        }
        TextEncoding::Ansi => encode_ansi(&with_eol, acp),
    }
}

fn encode_ansi(text: &str, acp: u32) -> Result<Vec<u8>, String> {
    let mapped = codepage_to_encoding(acp);
    let enc = mapped.ok_or_else(|| {
        format!("this file cannot be saved: the system code page ({acp}) is not supported")
    })?;
    let (encoded, _, had_unmappable) = enc.encode(text);
    if had_unmappable {
        return Err(format!("cannot be saved in {}", enc.name()));
    }
    Ok(encoded.into_owned())
}

/// `xxh3-64` of raw bytes, formatted as lowercase hex (spec §1: "dosyanın ham byte'larının
/// xxh3-64 hex'i").
pub fn hash_hex(bytes: &[u8]) -> String {
    hash_from_digest(xxhash_rust::xxh3::xxh3_64(bytes))
}

pub fn hash_from_digest(digest: u64) -> String {
    format!("{digest:016x}")
}

#[cfg(windows)]
fn get_acp() -> u32 {
    // SAFETY: `GetACP` takes no arguments and only reads global OS state.
    unsafe { windows::Win32::Globalization::GetACP() }
}

#[cfg(not(windows))]
fn get_acp() -> u32 {
    // Kotilo is Windows-only; this exists purely so `cargo check`/non-Windows tooling
    // still compiles. windows-1252 is `encoding_rs`'s own fallback default (see the doc
    // comment on `Encoding::for_label`).
    1252
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_binary -------------------------------------------------------------

    #[test]
    fn nul_byte_in_first_8kb_is_binary() {
        assert!(is_binary(b"hello\0world"));
    }

    #[test]
    fn plain_ascii_text_is_not_binary() {
        assert!(!is_binary(b"hello world\n"));
    }

    #[test]
    fn utf16_bom_bypasses_nul_sniff() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "hi".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert!(!is_binary(&bytes));
    }

    #[test]
    fn nul_byte_past_8kb_probe_is_not_flagged() {
        let mut bytes = vec![b'a'; 8192];
        bytes.push(0);
        assert!(!is_binary(&bytes));
    }

    // ---- EOL detection & normalization -----------------------------------------

    #[test]
    fn lf_only_is_detected_and_not_mixed() {
        let d = decode(b"a\nb\nc\n");
        assert_eq!(d.eol, Eol::Lf);
        assert!(!d.mixed_eol);
        assert_eq!(d.text, "a\nb\nc\n");
    }

    #[test]
    fn crlf_only_is_detected_and_not_mixed() {
        let d = decode(b"a\r\nb\r\nc\r\n");
        assert_eq!(d.eol, Eol::Crlf);
        assert!(!d.mixed_eol);
        assert_eq!(d.text, "a\nb\nc\n");
    }

    #[test]
    fn crlf_and_lf_both_present_is_mixed_and_dominant_wins() {
        // 2 CRLF vs 1 lone LF -> dominant is CRLF.
        let d = decode(b"a\r\nb\nc\r\n");
        assert!(d.mixed_eol);
        assert_eq!(d.eol, Eol::Crlf);
    }

    #[test]
    fn lone_cr_alone_normalizes_to_lf_and_is_flagged_mixed() {
        let d = decode(b"a\rb\rc");
        assert_eq!(d.text, "a\nb\nc");
        assert!(d.mixed_eol);
        assert_eq!(d.eol, Eol::Crlf); // no CRLF/LF present -> default
    }

    #[test]
    fn no_line_endings_defaults_to_crlf_not_mixed() {
        let d = decode(b"single line, no terminator");
        assert_eq!(d.eol, Eol::Crlf);
        assert!(!d.mixed_eol);
    }

    #[test]
    fn empty_file_decodes_to_empty_text() {
        let d = decode(b"");
        assert_eq!(d.text, "");
        assert_eq!(d.eol, Eol::Crlf);
        assert!(!d.mixed_eol);
    }

    // ---- round trips (§5.12 acceptance matrix) ---------------------------------

    fn roundtrip(bytes: &[u8]) -> Vec<u8> {
        let d = decode(bytes);
        encode(&d.text, d.encoding, d.eol).expect("encode should not fail in these tests")
    }

    #[test]
    fn lf_roundtrips_byte_identical() {
        let bytes = b"line1\nline2\nline3\n";
        assert_eq!(roundtrip(bytes), bytes);
    }

    #[test]
    fn crlf_roundtrips_byte_identical() {
        let bytes = b"line1\r\nline2\r\nline3\r\n";
        assert_eq!(roundtrip(bytes), bytes);
    }

    /// Deliberate, disclosed deviation from a literal reading of spec §5.12's test
    /// matrix: `fs_write_text` (§5.2) takes a single document-wide `eol`, so a file that
    /// genuinely mixes real CRLF *and* real lone-LF terminators cannot round-trip
    /// byte-for-byte on an unchanged save — only the dominant style survives, exactly
    /// like the lone-CR case just below (which the spec *does* call out as expected to
    /// change). Only 2 CRLF vs. 1 lone LF here, so CRLF (the dominant style) wins and the
    /// single LF line is the one that changes.
    #[test]
    fn mixed_crlf_lf_is_normalized_to_dominant_eol_not_byte_identical() {
        let bytes = b"a\r\nb\nc\r\n";
        assert_eq!(roundtrip(bytes), b"a\r\nb\r\nc\r\n".to_vec());
    }

    #[test]
    fn lone_cr_roundtrip_is_the_documented_lossy_conversion_not_byte_identical() {
        let bytes = b"a\rb\rc";
        let rewritten = roundtrip(bytes);
        assert_ne!(rewritten, bytes.to_vec(), "lone CR is expected to change on save");
        assert_eq!(rewritten, b"a\r\nb\r\nc".to_vec());
    }

    #[test]
    fn trailing_newline_present_is_preserved() {
        let bytes = b"a\nb\n";
        assert_eq!(roundtrip(bytes), bytes);
    }

    #[test]
    fn trailing_newline_absent_is_preserved() {
        let bytes = b"a\nb";
        assert_eq!(roundtrip(bytes), bytes);
    }

    #[test]
    fn empty_file_roundtrips_byte_identical() {
        let bytes: &[u8] = b"";
        assert_eq!(roundtrip(bytes), bytes.to_vec());
    }

    #[test]
    fn utf8_bom_with_crlf_roundtrips_byte_identical_xml_acceptance_case() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"<?xml version=\"1.0\"?>\r\n<root>\r\n  <a/>\r\n</root>\r\n");
        let d = decode(&bytes);
        assert_eq!(d.encoding, TextEncoding::Utf8Bom);
        assert_eq!(d.eol, Eol::Crlf);
        assert!(!d.mixed_eol);
        assert_eq!(encode(&d.text, d.encoding, d.eol).unwrap(), bytes);
    }

    #[test]
    fn utf16_le_with_crlf_roundtrips_byte_identical() {
        let text = "hello\r\nworld\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let d = decode(&bytes);
        assert_eq!(d.encoding, TextEncoding::Utf16Le);
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(encode(&d.text, d.encoding, d.eol).unwrap(), bytes);
    }

    #[test]
    fn utf16_be_with_crlf_roundtrips_byte_identical() {
        let text = "hello\r\nworld\r\n";
        let mut bytes = vec![0xFE, 0xFF];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        let d = decode(&bytes);
        assert_eq!(d.encoding, TextEncoding::Utf16Be);
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(encode(&d.text, d.encoding, d.eol).unwrap(), bytes);
    }

    #[test]
    fn utf16_le_no_bom_variant_is_plain_lf() {
        let text = "hello\nworld\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let d = decode(&bytes);
        assert_eq!(d.eol, Eol::Lf);
        assert!(!d.mixed_eol);
        assert_eq!(encode(&d.text, d.encoding, d.eol).unwrap(), bytes);
    }

    // ---- ANSI (windows-1254 Turkish) -------------------------------------------

    const TURKISH_TEXT: &str = "ğüşİıç";

    #[test]
    fn ansi_windows1254_roundtrips_byte_identical() {
        let (encoded, _, had_unmappable) = encoding_rs::WINDOWS_1254.encode(TURKISH_TEXT);
        assert!(!had_unmappable);
        let bytes = encoded.into_owned();

        let d = decode_with_codepage(&bytes, 1254);
        assert_eq!(d.encoding, TextEncoding::Ansi);
        assert!(!d.lossy);
        assert_eq!(d.text, TURKISH_TEXT);
        assert_eq!(
            encode_with_codepage(&d.text, d.encoding, d.eol, 1254).unwrap(),
            bytes
        );
    }

    #[test]
    fn ansi_windows1254_with_crlf_roundtrips_byte_identical() {
        let text = format!("{TURKISH_TEXT}\r\nsecond line\r\n");
        let (encoded, _, had_unmappable) = encoding_rs::WINDOWS_1254.encode(&text);
        assert!(!had_unmappable);
        let bytes = encoded.into_owned();

        let d = decode_with_codepage(&bytes, 1254);
        assert_eq!(d.encoding, TextEncoding::Ansi);
        assert_eq!(d.eol, Eol::Crlf);
        assert!(!d.mixed_eol);
        assert_eq!(
            encode_with_codepage(&d.text, d.encoding, d.eol, 1254).unwrap(),
            bytes
        );
    }

    #[test]
    fn ansi_unknown_codepage_falls_back_to_lossy_and_marks_readonly() {
        // 10003 (x-mac-korean) has no encoding_rs mapping (see codepage crate docs) and
        // these bytes (a lone UTF-8 continuation byte followed by two C1-range bytes)
        // are not valid UTF-8, so this must fall into the ansi branch.
        let bytes = [0x81u8, 0x8D, 0x8F];
        let d = decode_with_codepage(&bytes, 10003);
        assert_eq!(d.encoding, TextEncoding::Ansi);
        assert!(d.lossy);
    }

    #[test]
    fn ansi_acp_65001_is_lossy_even_though_codepage_crate_maps_it_to_utf8() {
        let bytes = [0x81u8, 0x8D, 0x8F];
        let d = decode_with_codepage(&bytes, 65001);
        assert_eq!(d.encoding, TextEncoding::Ansi);
        assert!(d.lossy);
    }

    #[test]
    fn ansi_encode_rejects_unmappable_character_without_writing_lossy() {
        // U+4E2D ("中") is a CJK ideograph, not representable in any single-byte Windows
        // ANSI code page (windows-1254 included) — unlike, say, the euro sign, which
        // windows-1254 *does* map (it inherits windows-1252's 0x80 assignment).
        let err = encode_with_codepage("price: 5\u{4e2d}", TextEncoding::Ansi, Eol::Lf, 1254)
            .unwrap_err();
        assert!(err.contains("windows-1254") || err.contains("cannot be saved"));
    }

    #[test]
    fn ansi_encode_rejects_when_codepage_unmapped() {
        let err = encode_with_codepage("hello", TextEncoding::Ansi, Eol::Lf, 10003).unwrap_err();
        assert!(err.contains("10003"));
    }

    // ---- plain UTF-8 / UTF-8 BOM sanity -----------------------------------------

    #[test]
    fn plain_utf8_no_bom_roundtrips() {
        let bytes = "hello \u{00e9}\u{00e8}".as_bytes();
        let d = decode(bytes);
        assert_eq!(d.encoding, TextEncoding::Utf8);
        assert!(!d.lossy);
        assert_eq!(encode(&d.text, d.encoding, d.eol).unwrap(), bytes);
    }

    #[test]
    fn hash_hex_is_stable_and_16_lowercase_hex_chars() {
        let h1 = hash_hex(b"hello");
        let h2 = hash_hex(b"hello");
        let h3 = hash_hex(b"hellp");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 16);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
