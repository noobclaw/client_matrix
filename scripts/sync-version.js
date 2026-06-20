/**
 * Single-source version sync.
 *
 * Source of truth: package.json "version".
 * Writes the same version into:
 *   - src-tauri/tauri.conf.json       (Tauri bundle version)
 *   - src-tauri/Cargo.toml            ([package] version)
 *   - src/main/sidecar-server.ts      (/api/version handler hardcoded string)
 *
 * Run:
 *   node scripts/sync-version.js
 *
 * CI calls this before `npm run build` so every artifact carries the
 * version number from package.json. Dev can also run it manually after
 * `npm version` bumps.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version || typeof version !== 'string') {
  console.error('[sync-version] package.json version is missing or not a string');
  process.exit(1);
}

let changed = 0;

// 1. tauri.conf.json
const tauriConfPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
if (tauriConf.version !== version) {
  tauriConf.version = version;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`[sync-version] tauri.conf.json → ${version}`);
  changed++;
}

// 2. src-tauri/Cargo.toml — only the [package] block's version line
const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf8');
// Match: [package]\n...\nversion = "x.y.z"
// Keep the replacement scoped to the first `version = ...` line after [package]
const packageBlockRegex = /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
if (packageBlockRegex.test(cargo)) {
  const next = cargo.replace(packageBlockRegex, `$1${version}$2`);
  if (next !== cargo) {
    fs.writeFileSync(cargoPath, next);
    console.log(`[sync-version] Cargo.toml → ${version}`);
    changed++;
  }
} else {
  console.error(`[sync-version] Cargo.toml: could not find [package] version line`);
  process.exit(1);
}

// 3. sidecar-server.ts — two hardcoded strings
//    a) /api/version HTTP handler:
//       if (pathname === '/api/version') {
//         return writeJSON(res, 200, { version: '2.2.7', mode: 'tauri-sidecar' });
//       }
//    b) app:getVersion IPC case:
//       case 'app:getVersion': return writeJSON(res, 200, '1.0.0');
//    Both are read by window.electron.appInfo.getVersion() via tauriShim;
//    keeping them in sync prevents the update-check from comparing against
//    a stale string and falsely reporting "already on latest".
const sidecarPath = path.join(ROOT, 'src', 'main', 'sidecar-server.ts');
let sidecar = fs.readFileSync(sidecarPath, 'utf8');

const sidecarRegexes = [
  {
    label: '/api/version',
    re: /(\/api\/version[^{]*\{\s*return writeJSON\(res, 200, \{ version: ')[^']+(' *, *mode)/,
  },
  {
    label: 'app:getVersion',
    re: /(case 'app:getVersion': return writeJSON\(res, 200, ')[^']+(' *\))/,
  },
];

let sidecarChanged = false;
for (const { label, re } of sidecarRegexes) {
  if (re.test(sidecar)) {
    const next = sidecar.replace(re, `$1${version}$2`);
    if (next !== sidecar) {
      sidecar = next;
      sidecarChanged = true;
      console.log(`[sync-version] sidecar-server.ts ${label} → ${version}`);
    }
  } else {
    console.warn(`[sync-version] sidecar-server.ts: could not find ${label} hardcoded string, skipping`);
  }
}
if (sidecarChanged) {
  fs.writeFileSync(sidecarPath, sidecar);
  changed++;
}

if (changed === 0) {
  console.log(`[sync-version] all targets already at ${version}, nothing to do`);
} else {
  console.log(`[sync-version] synced ${changed} file(s) to ${version}`);
}
