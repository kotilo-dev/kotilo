//! Mutual handshake proofs (protocol §2.1): HMAC-SHA256 keyed with the 64-char token string
//! (its ASCII bytes, not hex-decoded). The server proves first; the client checks that proof in
//! constant time before it sends its own.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const LABEL: &str = "kotilo-companion-v1";

/// 32 random bytes as 64 lowercase hex chars (a nonce or a new token).
pub fn random_hex32() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(hex::encode(bytes))
}

/// Exactly 64 hex chars (either case).
pub fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn mac(token: &str, message: &str) -> HmacSha256 {
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = <HmacSha256 as Mac>::new_from_slice(token.as_bytes()).unwrap_or_else(|_| unreachable!());
    mac.update(message.as_bytes());
    mac
}

fn server_message(client_nonce: &str, server_nonce: &str) -> String {
    format!("{LABEL}|server|{}|{}", client_nonce.to_ascii_lowercase(), server_nonce.to_ascii_lowercase())
}

fn client_message(client_nonce: &str, server_nonce: &str) -> String {
    format!("{LABEL}|client|{}|{}", server_nonce.to_ascii_lowercase(), client_nonce.to_ascii_lowercase())
}

/// The server's proof `Ps` (used by tests and fake servers).
pub fn server_proof(token: &str, client_nonce: &str, server_nonce: &str) -> String {
    hex::encode(mac(token, &server_message(client_nonce, server_nonce)).finalize().into_bytes())
}

/// The client's proof `Pc`.
pub fn client_proof(token: &str, client_nonce: &str, server_nonce: &str) -> String {
    hex::encode(mac(token, &client_message(client_nonce, server_nonce)).finalize().into_bytes())
}

/// Checks the server's proof in constant time. A malformed proof is simply wrong.
pub fn verify_server_proof(token: &str, client_nonce: &str, server_nonce: &str, proof: &str) -> bool {
    if !is_hex64(proof) {
        return false;
    }
    let Ok(bytes) = hex::decode(proof.to_ascii_lowercase()) else {
        return false;
    };
    mac(token, &server_message(client_nonce, server_nonce)).verify_slice(&bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const NC: &str = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
    const NS: &str = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
    const PS: &str = "7a405ce29b239672c5c818ed4755c62166745da6b19cc1a48bd9c14d501079e2";
    const PC: &str = "19dadb8ff84d74d2037f8d5e7860840d4719899023fc7f1e097c76a9984676cd";

    #[test]
    fn protocol_test_vector() {
        assert_eq!(server_proof(TOKEN, NC, NS), PS);
        assert_eq!(client_proof(TOKEN, NC, NS), PC);
        assert!(verify_server_proof(TOKEN, NC, NS, PS));
        assert!(verify_server_proof(TOKEN, NC, NS, &PS.to_ascii_uppercase()));
    }

    #[test]
    fn wrong_or_malformed_server_proofs_fail() {
        assert!(!verify_server_proof(TOKEN, NC, NS, PC));
        assert!(!verify_server_proof(TOKEN, NS, NC, PS));
        assert!(!verify_server_proof(&TOKEN.replace('0', "f"), NC, NS, PS));
        assert!(!verify_server_proof(TOKEN, NC, NS, ""));
        assert!(!verify_server_proof(TOKEN, NC, NS, &PS[..63]));
        assert!(!verify_server_proof(TOKEN, NC, NS, &format!("{}zz", &PS[..62])));
    }

    #[test]
    fn random_hex32_is_64_lowercase_hex_and_fresh() {
        let a = random_hex32().unwrap();
        let b = random_hex32().unwrap();
        assert!(is_hex64(&a) && a == a.to_ascii_lowercase());
        assert_ne!(a, b);
    }
}
