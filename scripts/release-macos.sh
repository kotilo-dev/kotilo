#!/usr/bin/env bash
# Builds the macOS app (.app, .dmg, updater .app.tar.gz) for one architecture (U-3).
#
# Steps, as in scripts/release-linux.sh:
#   1. Hub: `dotnet publish` self-contained single file for osx-arm64 / osx-x64. Native libraries
#      stay loose (IncludeNativeLibrariesForSelfExtract=false): extracted copies under ~/.net would
#      carry a foreign signature, which the hardened runtime's library validation rejects. The
#      runtime itself is linked into the macOS single-file host, so the only native file is
#      libe_sqlite3.dylib; it goes next to the hub in Contents/MacOS (bundle.macOS.files) and is
#      signed here with the app's identity, as Tauri does not sign `files`. Whisper.net's natives
#      are left out: dictation is off on macOS.
#   2. Built-in adapter definitions staged without `fixtures/` (D-021).
#   3. `tauri build --bundles app,dmg` with a generated `--config` overlay (sidecars, staged
#      adapters, the hub's dylib, updater artifacts, signing mode). src-tauri/build.rs builds the
#      hook sidecar for the target.
#   4. .dmg + updater .app.tar.gz (+ .sig) copied to target/release-artifacts/macos-<arch>/, the
#      updater bundle renamed per arch (Tauri names it <product>.app.tar.gz on both).
#
# Signing (env, all optional):
#   - none set: ad-hoc signature (`-`) without hardened runtime. Apple Silicon only runs signed
#     code; the hardened runtime is only needed for notarization and would reject the ad-hoc
#     signed dylib (library validation needs a Team ID). Users open it via Privacy & Security.
#   - APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD: imported into a temporary
#     keychain; the Developer ID Application identity in it signs everything. Or
#     APPLE_SIGNING_IDENTITY alone for an identity already in the login keychain.
#   - Notarization (Tauri, notarytool) with a signing identity and either APPLE_ID +
#     APPLE_PASSWORD (app-specific password) + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER
#     + APPLE_API_KEY_PATH (or APPLE_API_PRIVATE_KEY, the .p8 contents, written to a temp file).
#   Empty variables count as unset (GitHub passes missing secrets as empty strings).
# Updater artifacts only with TAURI_SIGNING_PRIVATE_KEY set (see release.ps1).
# Prerequisites: macOS with Xcode command line tools, .NET 10 SDK, Rust stable with the target,
# Node LTS with `npm --prefix apps/desktop ci` done.
#
# Usage: ./scripts/release-macos.sh aarch64|x86_64
set -euo pipefail

case "${1:-}" in
  aarch64) triple=aarch64-apple-darwin; rid=osx-arm64; dmg_arch=aarch64 ;;
  x86_64) triple=x86_64-apple-darwin; rid=osx-x64; dmg_arch=x64 ;;
  *) echo "usage: $0 aarch64|x86_64" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
tauri_dir="$root/apps/desktop/src-tauri"
json() { node -p "require(process.argv[1])$2" "$1"; }
prefix="$(json "$root/brand.json" .exePrefix)"
product="$(json "$tauri_dir/tauri.conf.json" .productName)"
version="$(json "$tauri_dir/tauri.conf.json" .version)"

# Every binary of a release carries the app version (D-051); the hub has its own <Version>.
hub_version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$root/hub/Directory.Build.props" | head -n 1)"
if [ "$hub_version" != "$version" ]; then
  echo "version mismatch: tauri.conf.json $version, hub/Directory.Build.props $hub_version" >&2
  exit 1
fi

staging="$root/target/release-staging"
staging_rel=../../../target/release-staging
cargo_target="${CARGO_TARGET_DIR:-$root/target}"
artifacts="$root/target/release-artifacts/macos-$dmg_arch"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD \
  APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_API_PRIVATE_KEY \
  TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done

# --- 0. Clean staging -------------------------------------------------------------------------
rm -rf "$staging" "$artifacts"
mkdir -p "$staging" "$artifacts"

if command -v rustup >/dev/null 2>&1; then
  rustup target add "$triple"
fi

# --- Signing identity -------------------------------------------------------------------------
keychain=""
cleanup() {
  if [ -n "$keychain" ]; then security delete-keychain "$keychain" >/dev/null 2>&1 || true; fi
  rm -f "$staging/cert.p12" "$staging/AuthKey.p8"
}
trap cleanup EXIT

if [ -n "${APPLE_CERTIFICATE:-}" ]; then
  step "signing: importing the certificate into a temporary keychain"
  keychain="$staging/signing.keychain-db"
  keychain_password="$(uuidgen)"
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$staging/cert.p12"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$staging/cert.p12" -k "$keychain" -P "${APPLE_CERTIFICATE_PASSWORD:-}" \
    -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
  # Keep the existing search list (login + system keychains) and add ours to it.
  existing="$(security list-keychains -d user | tr -d '"' | xargs)"
  # shellcheck disable=SC2086 # one keychain path per word
  security list-keychains -d user -s "$keychain" $existing
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning "$keychain" |
      sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n 1)"
    [ -n "$APPLE_SIGNING_IDENTITY" ] || { echo "signing: no Developer ID Application identity in APPLE_CERTIFICATE" >&2; exit 1; }
    export APPLE_SIGNING_IDENTITY
  fi
  # Tauri would import the certificate a second time; it finds the identity in the search list.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
fi

if [ -n "${APPLE_API_PRIVATE_KEY:-}" ] && [ -z "${APPLE_API_KEY_PATH:-}" ]; then
  (umask 077 && printf '%s\n' "$APPLE_API_PRIVATE_KEY" > "$staging/AuthKey.p8")
  export APPLE_API_KEY_PATH="$staging/AuthKey.p8"
fi
unset APPLE_API_PRIVATE_KEY

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  signed=true
  echo "signing: $APPLE_SIGNING_IDENTITY (hardened runtime)"
  if [ -z "${APPLE_ID:-}${APPLE_API_KEY:-}" ]; then
    echo "warning: no APPLE_ID / APPLE_API_KEY; the app is signed but not notarized" >&2
  fi
else
  signed=false
  echo "warning: no Apple signing identity; ad-hoc signed test build (Gatekeeper will block it until the user allows it)" >&2
  # Notarization needs a Developer ID signature; Tauri would try (and fail) with these set.
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
fi

# --- 1. Hub ----------------------------------------------------------------------------------
step "hub: dotnet publish ($rid)"
hub_publish="$staging/hub-publish"
dotnet publish "$root/hub/Hub.Service/Hub.Service.csproj" \
  -c Release -r "$rid" --self-contained true \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=false \
  -p:PublishTrimmed=false -p:PublishAot=false -p:PublishReadyToRun=false \
  -p:DebugType=none -p:DebugSymbols=false \
  -o "$hub_publish"
hub_exe="$hub_publish/$prefix-hub"
[ -f "$hub_exe" ] || { echo "hub: $prefix-hub not found in $hub_publish" >&2; exit 1; }
mkdir -p "$tauri_dir/binaries"
sidecar_hub="$tauri_dir/binaries/$prefix-hub-$triple"
install -m 755 "$hub_exe" "$sidecar_hub"

# Loose native libraries next to the hub. Only top-level dylibs: runtimes/ holds Whisper.net's
# per-platform natives (dictation is off on macOS); ggml-metal.metal is Whisper's too.
hub_native="$staging/hub-native"
mkdir -p "$hub_native"
shopt -s nullglob
dylibs=("$hub_publish"/*.dylib)
shopt -u nullglob
[ ${#dylibs[@]} -gt 0 ] || { echo "hub: no native libraries in $hub_publish (expected libe_sqlite3.dylib)" >&2; exit 1; }
macos_files=""
for lib in "${dylibs[@]}"; do
  name="$(basename "$lib")"
  cp "$lib" "$hub_native/$name"
  if [ "$signed" = true ]; then
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$hub_native/$name"
  else
    codesign --force --sign - "$hub_native/$name"
  fi
  macos_files="$macos_files${macos_files:+,}
      \"MacOS/$name\": \"$hub_native/$name\""
done

# --- 2. Adapters without fixtures (D-021) -----------------------------------------------------
step "adapters"
cp -R "$root/adapters" "$staging/adapters"
find "$staging/adapters" -type d -name fixtures -prune -exec rm -rf {} +

# --- 3. Tauri build ---------------------------------------------------------------------------
updater=false
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  updater=true
else
  echo "warning: TAURI_SIGNING_PRIVATE_KEY is not set; building without updater artifacts (.sig)" >&2
fi
if [ "$signed" = true ]; then
  signing='"hardenedRuntime": true'
else
  signing='"signingIdentity": "-", "hardenedRuntime": false'
fi
overlay="$staging/tauri.release.conf.json"
cat > "$overlay" <<EOF
{
  "bundle": {
    "externalBin": ["binaries/$prefix-hook", "binaries/$prefix-hub"],
    "resources": {
      "../../../adapters/": null,
      "$staging_rel/adapters/": "adapters/"
    },
    "createUpdaterArtifacts": $updater,
    "macOS": {
      $signing,
      "files": {$macos_files
      }
    }
  }
}
EOF

step "tauri build ($triple)"
npm --prefix "$root/apps/desktop" run tauri -- build --target "$triple" --bundles app,dmg --config "$overlay"

# --- 4. Collect -------------------------------------------------------------------------------
bundle="$cargo_target/$triple/release/bundle"
dmg="$bundle/dmg/${product}_${version}_${dmg_arch}.dmg"
[ -f "$dmg" ] || { echo "no dmg at $dmg" >&2; exit 1; }
cp "$dmg" "$artifacts/"
if [ "$updater" = true ]; then
  tarball="$bundle/macos/$product.app.tar.gz"
  if [ ! -f "$tarball" ] || [ ! -f "$tarball.sig" ]; then
    echo "no updater bundle at $tarball(.sig)" >&2
    exit 1
  fi
  # The .sig signs the content, not the name, so both can be renamed.
  cp "$tarball" "$artifacts/${product}_${version}_${dmg_arch}.app.tar.gz"
  cp "$tarball.sig" "$artifacts/${product}_${version}_${dmg_arch}.app.tar.gz.sig"
fi

step "verify signature"
app="$bundle/macos/$product.app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --entitlements - "$app/Contents/MacOS/$prefix-hub" 2>/dev/null || true

printf '\033[32m==> artifacts (macos-%s, %s)\033[0m\n' "$dmg_arch" "$([ "$signed" = true ] && echo signed || echo ad-hoc)"
ls -lh "$artifacts"
echo "  hub sidecar $(du -h "$sidecar_hub" | cut -f1)"
