#!/usr/bin/env bash
# Builds the Linux packages (AppImage, .deb, .rpm) for x86_64 (U-2, D-061).
#
# Steps, as in scripts/release.ps1 for Windows:
#   1. Hub: `dotnet publish` self-contained single file for linux-x64. Unlike Windows, the native
#      libraries are bundled into the file (IncludeNativeLibrariesForSelfExtract): Linux packages
#      put sidecars in /usr/bin and resources in /usr/lib/<name>, so loose native files could not
#      sit next to the hub. The exe becomes the sidecar `binaries/<exePrefix>-hub-<triple>`.
#   2. Built-in adapter definitions staged without `fixtures/` (D-021).
#   3. `tauri build --bundles appimage,deb,rpm` with a generated `--config` overlay (sidecars,
#      staged adapters, updater artifacts). src-tauri/build.rs builds the hook sidecar.
#   4. Packages (+ the AppImage's `.sig`) copied to target/release-artifacts/linux-x64/.
#
# Updater artifacts only with TAURI_SIGNING_PRIVATE_KEY set (see release.ps1).
# Prerequisites: .NET 10 SDK, Rust stable, Node LTS with `npm --prefix apps/desktop ci` done,
# the Tauri Linux libraries (webkit2gtk-4.1, libappindicator, librsvg) and, for the .rpm,
# `rpmbuild` (`rpm` package on Debian/Ubuntu).
#
# Usage: ./scripts/release-linux.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tauri_dir="$root/apps/desktop/src-tauri"
json() { node -p "require(process.argv[1])$2" "$1"; }
prefix="$(json "$root/brand.json" .exePrefix)"
version="$(json "$tauri_dir/tauri.conf.json" .version)"

# Every binary of a release carries the app version (D-051); the hub has its own <Version>.
hub_version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$root/hub/Directory.Build.props" | head -n 1)"
if [ "$hub_version" != "$version" ]; then
  echo "version mismatch: tauri.conf.json $version, hub/Directory.Build.props $hub_version" >&2
  exit 1
fi

triple=x86_64-unknown-linux-gnu
rid=linux-x64
staging="$root/target/release-staging"
staging_rel=../../../target/release-staging
cargo_target="${CARGO_TARGET_DIR:-$root/target}"
artifacts="$root/target/release-artifacts/linux-x64"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# --- 0. Clean staging -------------------------------------------------------------------------
rm -rf "$staging" "$artifacts"
mkdir -p "$staging" "$artifacts"

# --- 1. Hub ----------------------------------------------------------------------------------
step "hub: dotnet publish ($rid)"
hub_publish="$staging/hub-publish"
dotnet publish "$root/hub/Hub.Service/Hub.Service.csproj" \
  -c Release -r "$rid" --self-contained true \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:PublishTrimmed=false -p:PublishAot=false -p:PublishReadyToRun=false \
  -p:DebugType=none -p:DebugSymbols=false \
  -o "$hub_publish"
hub_exe="$hub_publish/$prefix-hub"
[ -f "$hub_exe" ] || { echo "hub: $prefix-hub not found in $hub_publish" >&2; exit 1; }
mkdir -p "$tauri_dir/binaries"
sidecar_hub="$tauri_dir/binaries/$prefix-hub-$triple"
install -m 755 "$hub_exe" "$sidecar_hub"

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
overlay="$staging/tauri.release.conf.json"
cat > "$overlay" <<EOF
{
  "bundle": {
    "externalBin": ["binaries/$prefix-hook", "binaries/$prefix-hub"],
    "resources": {
      "../../../adapters/": null,
      "$staging_rel/adapters/": "adapters/"
    },
    "createUpdaterArtifacts": $updater
  }
}
EOF

step "tauri build ($triple)"
npm --prefix "$root/apps/desktop" run tauri -- build --target "$triple" --bundles appimage,deb,rpm --config "$overlay"

# --- 4. Collect -------------------------------------------------------------------------------
bundle="$cargo_target/$triple/release/bundle"
shopt -s nullglob
found=("$bundle"/appimage/*"_${version}_"*.AppImage* "$bundle"/deb/*"_${version}_"*.deb "$bundle"/rpm/*"-${version}-"*.rpm)
if [ ${#found[@]} -eq 0 ]; then
  echo "no packages found in $bundle" >&2
  exit 1
fi
cp "${found[@]}" "$artifacts/"

printf '\033[32m==> artifacts (linux-x64)\033[0m\n'
ls -lh "$artifacts"
echo "  hub sidecar $(du -h "$sidecar_hub" | cut -f1)"
