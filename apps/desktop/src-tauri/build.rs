//! Faz 5 §1.2 / §4 item 2: builds the `agenthub-hook` sidecar *before*
//! `tauri_build::build()` runs, so `bundle.externalBin` in `tauri.conf.json` always
//! finds `src-tauri/binaries/agenthub-hook-<TARGET>.exe` — both for `npm run tauri
//! dev` (Tauri copies the sidecar into the dev target dir) and `npm run tauri build`
//! (Tauri bundles it), from a clean clone with no manual steps.
//!
//! The sidecar is built with a *separate* `--target-dir` (`<workspace>/target/sidecar`)
//! so this nested `cargo build` never contends for the same `target/` lock the outer
//! `cargo build`/`cargo test` invocation (which is *running this very build script*)
//! already holds — using the same target dir would deadlock.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let brand = read_brand(&workspace_root(&manifest_dir));
    check_tauri_config(&manifest_dir, &brand);
    build_notify_sidecar(brand_str(&brand, "exePrefix"));
    set_git_sha();
    set_build_date();
    tauri_build::build();
}

/// Faz 7 §11: bakes `AGENTHUB_BUILD_DATE` (UTC, `YYYY-MM-DD`) into the binary
/// (`env!("AGENTHUB_BUILD_DATE")` in `commands::app`, `app_info().buildDate`). Honors
/// `SOURCE_DATE_EPOCH` (the reproducible-builds convention) when set, so two builds from
/// the same source snapshot produce the same date; no new dependency — the
/// seconds-since-epoch -> civil-date conversion is Howard Hinnant's well-known small
/// integer algorithm (see `civil_from_days`'s doc comment), not `chrono` (a
/// build-dependency `chrono` would work too, but every other date computed in this crate
/// already goes through the one `chrono` the crate itself depends on, at runtime, not at
/// build time — pulling in a whole extra copy of it here just to format one date is not
/// worth it).
fn set_build_date() {
    let epoch_seconds: i64 = env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });
    let days_since_epoch = epoch_seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days_since_epoch);
    println!("cargo:rustc-env=AGENTHUB_BUILD_DATE={year:04}-{month:02}-{day:02}");
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch (1970-01-01) -> a
/// proleptic-Gregorian `(year, month, day)`, `month`/`day` both 1-based. Public-domain
/// algorithm, see <http://howardhinnant.github.io/date_algorithms.html#civil_from_days>.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    #[test]
    fn civil_from_days_epoch_is_1970_01_01() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn civil_from_days_known_date() {
        // 2026-09-28 is 20724 days after the Unix epoch.
        assert_eq!(civil_from_days(20_724), (2026, 9, 28));
    }

    #[test]
    fn civil_from_days_handles_a_leap_day() {
        // 2024-02-29.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}

/// Faz 7 §9.1: bakes `AGENTHUB_GIT_SHA` into the binary (`env!("AGENTHUB_GIT_SHA")` in
/// `commands::app`/the `--- start` log line) — the repo's short commit hash, `+ "-dirty"`
/// if the working tree had uncommitted changes at build time, or `"unknown"` when git
/// itself isn't available (a source tarball with no `.git`, e.g.) so a from-scratch build
/// never fails just because of this.
/// The monorepo root (`apps/desktop/src-tauri` -> repo root), where `.git`, the Cargo
/// workspace and `crates/` live.
fn workspace_root(manifest_dir: &Path) -> PathBuf {
    manifest_dir
        .ancestors()
        .nth(3)
        .expect("src-tauri lives at <repo>/apps/desktop/src-tauri")
        .to_path_buf()
}

fn set_git_sha() {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let workspace_root = workspace_root(&manifest_dir);
    let git_dir = workspace_root.join(".git");

    // Precise rerun triggers: the current branch's ref file (so a new commit on the
    // checked-out branch is picked up) and `.git/HEAD` itself (so switching branches, or
    // detaching, is too). Missing paths are fine to pass here — cargo treats a
    // rerun-if-changed path that doesn't exist as always out of date, which is exactly
    // what we want when `.git` isn't there at all (no spurious rebuild loop: the env var
    // still resolves to the same `"unknown"` every time in that case).
    println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    if let Some(ref_file) = current_ref_file(&git_dir) {
        println!("cargo:rerun-if-changed={}", ref_file.display());
    }

    let sha = git_sha(&workspace_root).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=AGENTHUB_GIT_SHA={sha}");
}

/// Resolves `.git/HEAD`'s target ref file (e.g. `.git/refs/heads/faz7`) when `HEAD` is a
/// symbolic ref, so `rerun-if-changed` also fires on a new commit to the checked-out
/// branch. Returns `None` for a detached HEAD (already covered by `.git/HEAD` itself
/// changing) or when `.git` isn't a plain directory (e.g. a worktree's `.git` file, or no
/// repo at all) — neither is worth the complexity of following further.
fn current_ref_file(git_dir: &Path) -> Option<PathBuf> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let rest = head.trim().strip_prefix("ref:")?.trim();
    Some(git_dir.join(rest))
}

/// Best-effort `git rev-parse --short HEAD` (+ `-dirty` if `git status --porcelain` isn't
/// empty), run in `workspace_root`. `None` on any failure (git not on PATH, not a repo,
/// ...) — the caller falls back to `"unknown"`.
fn git_sha(workspace_root: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(workspace_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut sha = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        return None;
    }

    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace_root)
        .output()
        .ok()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);
    if dirty {
        sha.push_str("-dirty");
    }
    Some(sha)
}

/// Env vars that must not leak into the nested `cargo build` (Faz 5 §4 item 2):
/// - `CARGO_ENCODED_RUSTFLAGS` / `RUSTC_WORKSPACE_WRAPPER`: rustflags/wrapper meant for
///   the *outer* build (e.g. a coverage or clippy-driver wrapper) would otherwise apply
///   to the sidecar too, and some wrappers aren't idempotent across nested invocations.
/// - `CARGO_TARGET_DIR`: would override our explicit `--target-dir` right back onto the
///   outer build's target dir, recreating the lock contention this split is meant to
///   avoid.
/// - `CARGO_MAKEFLAGS`: a jobserver fd/pipe handle from the outer `cargo` — passing it
///   into a nested `cargo build` we invoke and wait on synchronously can deadlock the
///   jobserver protocol (the outer cargo is blocked waiting on *us*, a job it already
///   accounted for, while the inner cargo tries to negotiate more jobs through the same
///   handle).
const SCRUBBED_ENV_VARS: [&str; 4] = [
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_TARGET_DIR",
    "CARGO_MAKEFLAGS",
    "RUSTC_WORKSPACE_WRAPPER",
];

/// The cargo package/binary stays `agenthub-hook` (an internal name); the copy Tauri bundles
/// is named after the brand's exe prefix.
fn build_notify_sidecar(exe_prefix: &str) {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let workspace_root = workspace_root(&manifest_dir);

    let agenthub_hook_dir = workspace_root.join("crates").join("hook");
    let proto_dir = workspace_root.join("crates").join("proto");

    // Precise file-level triggers (a directory's own mtime does not change when an
    // existing file inside it is merely edited, only when entries are added/removed).
    for path in [
        agenthub_hook_dir.join("src").join("main.rs"),
        agenthub_hook_dir.join("src").join("lib.rs"),
        agenthub_hook_dir.join("Cargo.toml"),
        proto_dir.join("src").join("lib.rs"),
        proto_dir.join("build.rs"),
        proto_dir.join("Cargo.toml"),
        // Folder, exe and pipe names the sidecar uses are generated from it.
        workspace_root.join("brand.json"),
        // Spec §4 finding 11: a workspace-wide dependency bump (or a version pin added
        // to the root `Cargo.toml`) can change what `cargo build -p agenthub-hook` actually
        // produces without touching any file above — the sidecar must rebuild then too.
        workspace_root.join("Cargo.lock"),
        workspace_root.join("Cargo.toml"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let target = env::var("TARGET").expect("TARGET is set by cargo for build scripts");
    // `.exe` only for a Windows target (Tauri's externalBin naming follows the target too).
    let exe_suffix = if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { ".exe" } else { "" };
    let sidecar_target_dir = workspace_root.join("target").join("sidecar");
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());

    let dest_dir = manifest_dir.join("binaries");
    let dest = dest_dir.join(format!("{exe_prefix}-hook-{target}{exe_suffix}"));

    // Also rerun if the produced binary itself was deleted by hand (e.g. the clean-state
    // verification in the spec) — cargo treats a rerun-if-changed path that doesn't
    // exist as always out of date, so this alone is enough to force a fresh build even
    // when none of the source files above changed.
    println!("cargo:rerun-if-changed={}", dest.display());

    fs::create_dir_all(&dest_dir).unwrap_or_else(|e| {
        panic!(
            "failed to create {} for the agenthub-hook sidecar: {e}",
            dest_dir.display()
        )
    });

    let mut cmd = Command::new(&cargo);
    cmd.current_dir(&workspace_root);
    cmd.args([
        "build",
        "-p",
        "agenthub-hook",
        "--bin",
        "agenthub-hook",
        "--release",
        "--target",
        &target,
        "--target-dir",
    ]);
    cmd.arg(&sidecar_target_dir);
    for key in SCRUBBED_ENV_VARS {
        cmd.env_remove(key);
    }

    let status = cmd.status().unwrap_or_else(|e| {
        panic!("failed to spawn `{cargo} build -p agenthub-hook --bin agenthub-hook --release`: {e}")
    });
    if !status.success() {
        panic!(
            "`cargo build -p agenthub-hook --bin agenthub-hook --release` failed with {status}"
        );
    }

    let built_exe = sidecar_target_dir
        .join(&target)
        .join("release")
        .join(format!("agenthub-hook{exe_suffix}"));
    copy_sidecar(&built_exe, &dest);
}

fn copy_sidecar(built_exe: &Path, dest: &Path) {
    fs::copy(built_exe, dest).unwrap_or_else(|e| {
        panic!(
            "failed to copy sidecar {} -> {}: {e}",
            built_exe.display(),
            dest.display()
        )
    });
}

/// M5 brand switch: `<repo>/brand.json` is the single source of the product identity. The
/// Rust consts come from `crates/proto/build.rs`; here the parts of `tauri.conf.json` that
/// Tauri reads itself (product name, main binary name, identifier, window title, sidecar name)
/// are checked against it (the installed exe must be `<exePrefix>.exe`: the hook sidecar finds
/// the app in its process chain by that name, D-044), so a rename that forgets the config fails
/// the build instead of shipping a half-renamed app. Checking (rather than generating a merged
/// config) keeps plain `cargo build`/`cargo test` and `tauri dev`/`tauri build` on the same
/// config file; `scripts/release.ps1` only adds packaging inputs (hub sidecar, staged
/// resources, signing) through a generated `--config` overlay derived from `brand.json`.
fn read_brand(workspace_root: &Path) -> serde_json::Value {
    let path = workspace_root.join("brand.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

fn brand_str<'a>(brand: &'a serde_json::Value, key: &str) -> &'a str {
    brand
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("brand.json: \"{key}\" must be a string"))
}

fn check_tauri_config(manifest_dir: &Path, brand: &serde_json::Value) {
    let path = manifest_dir.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    let conf: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
    let name = brand_str(brand, "name");
    let expected_bin = format!("binaries/{}-hook", brand_str(brand, "exePrefix"));
    let checks = [
        ("productName", conf.pointer("/productName"), name),
        (
            "mainBinaryName",
            conf.pointer("/mainBinaryName"),
            brand_str(brand, "exePrefix"),
        ),
        ("identifier", conf.pointer("/identifier"), brand_str(brand, "identifier")),
        ("app.windows[0].title", conf.pointer("/app/windows/0/title"), name),
        ("bundle.externalBin[0]", conf.pointer("/bundle/externalBin/0"), expected_bin.as_str()),
    ];
    let mismatches: Vec<String> = checks
        .iter()
        .filter(|(_, actual, expected)| actual.and_then(|v| v.as_str()) != Some(*expected))
        .map(|(key, actual, expected)| format!("  {key}: {actual:?}, brand.json wants \"{expected}\""))
        .collect();
    assert!(
        mismatches.is_empty(),
        "tauri.conf.json does not match brand.json:\n{}",
        mismatches.join("\n")
    );
}
