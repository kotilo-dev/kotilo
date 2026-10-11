// Lists the npm packages that can end up in the production bundle of apps/desktop and prints
// their license texts. Called by generate-notices.ps1; works offline from node_modules.
//
// Usage: node npm-notices.mjs <apps/desktop> <licenses-dir>
// Output (stdout): JSON [{name, version, license, repository, texts: [{file, text}], fallback}]
//
// The walk starts at package.json `dependencies` and follows each package's `dependencies`
// only. Not followed:
// - devDependencies (build/test tooling, not shipped);
// - peerDependencies: a peer that the bundle uses is already a root dependency (e.g. react for
//   zustand). `next` and `sharp` are peers of `geist` and are NOT bundled – only geist's woff2
//   font files are imported (src/styles), so they are excluded on purpose;
// - optionalDependencies: native Node binaries (e.g. @napi-rs/canvas for pdfjs-dist under Node)
//   and type-only packages, none of which run in the webview bundle.
// The result is a superset of what Vite tree-shakes into dist/, which is the safe side.

import fs from "node:fs";
import path from "node:path";

const [, , appDir, licensesDir] = process.argv;
if (!appDir || !licensesDir) {
  console.error("usage: node npm-notices.mjs <appDir> <licensesDir>");
  process.exit(2);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// Node-style resolution: <from>/node_modules/<name>, then each parent directory.
function resolvePackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  }
  return "UNKNOWN";
}

function repoOf(pkg) {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : r && r.url;
  return url || pkg.homepage || "";
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice|ofl)([.-].*)?$/i;

const root = path.resolve(appDir);
const rootPkg = readJson(path.join(root, "package.json"));
const seen = new Map(); // dir -> entry
const missing = [];
const queue = Object.keys(rootPkg.dependencies || {}).map((n) => [n, root]);

while (queue.length) {
  const [name, from] = queue.shift();
  const dir = resolvePackage(name, from);
  if (!dir) {
    missing.push(name);
    continue;
  }
  if (seen.has(dir)) continue;
  const pkg = readJson(path.join(dir, "package.json"));
  const texts = fs
    .readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
  const license = licenseOf(pkg);
  let fallback = null;
  if (texts.length === 0) {
    // No license file in the package: use the bundled SPDX text for its declared license.
    const spdx = license.replace(/[()]/g, "").split(/\s+OR\s+/)[0].trim();
    const f = path.join(licensesDir, `${spdx}.txt`);
    if (fs.existsSync(f)) fallback = spdx;
  }
  seen.set(dir, { name: pkg.name, version: pkg.version, license, repository: repoOf(pkg), texts, fallback });
  for (const dep of Object.keys(pkg.dependencies || {})) queue.push([dep, dir]);
}

if (missing.length) console.error(`not installed (skipped): ${[...new Set(missing)].join(", ")}`);
const out = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
process.stdout.write(JSON.stringify(out));
