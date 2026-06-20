/**
 * Build the Node.js sidecar binary for Tauri.
 *
 * Steps:
 * 1. Compile TypeScript (electron main process code)
 * 2. Bundle into a single JS file with esbuild
 * 3. Package with @yao-pkg/pkg into a native binary
 * 4. Copy to src-tauri/binaries/ with correct target triple name
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

// Detect target triple. Allow SIDECAR_TARGET env var to override when
// the caller needs a specific arch (e.g. universal-apple-darwin build
// invokes the script twice, once with aarch64 and once with x86_64,
// to produce both binaries for Tauri to lipo together).
function getTargetTriple() {
  if (process.env.SIDECAR_TARGET) return process.env.SIDECAR_TARGET;
  try {
    return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim();
  } catch {
    if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin';
    }
    return 'x86_64-unknown-linux-gnu';
  }
}

function pkgTargetFor(triple) {
  if (triple === 'x86_64-pc-windows-msvc')    return 'node20-win-x64';
  if (triple === 'aarch64-apple-darwin')      return 'node20-macos-arm64';
  if (triple === 'x86_64-apple-darwin')       return 'node20-macos-x64';
  if (triple === 'x86_64-unknown-linux-gnu')  return 'node20-linux-x64';
  if (triple === 'aarch64-unknown-linux-gnu') return 'node20-linux-arm64';
  throw new Error('Unknown target triple for pkg: ' + triple);
}

function main() {
  const triple = getTargetTriple();
  const ext = triple.includes('windows') ? '.exe' : '';
  const outName = `noobclaw-server-${triple}${ext}`;
  const outPath = path.join(BINARIES_DIR, outName);

  console.log(`Building sidecar for target: ${triple}`);
  console.log(`Output: ${outPath}`);

  // Step 1+2: Bundle TypeScript directly with esbuild (skip tsc — esbuild handles TS natively)
  console.log('Step 1: Bundling TypeScript with esbuild...');
  const entryPoint = path.join(ROOT, 'src', 'main', 'sidecar-server.ts');
  const bundlePath = path.join(ROOT, 'dist-electron', 'sidecar-bundle.cjs');

  if (!fs.existsSync(path.join(ROOT, 'dist-electron'))) {
    fs.mkdirSync(path.join(ROOT, 'dist-electron'), { recursive: true });
  }

  execSync(`npx esbuild "${entryPoint}" --bundle --platform=node --target=node20 --outfile="${bundlePath}" --external:better-sqlite3 --external:electron`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // Step 3: Package with pkg — derive pkg target from the triple so
  // SIDECAR_TARGET overrides work (universal-apple-darwin calls this
  // script twice with aarch64 + x86_64 triples).
  console.log('Step 3: Packaging with pkg...');
  const pkgTarget = pkgTargetFor(triple);

  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  execSync(`npx @yao-pkg/pkg "${bundlePath}" --target ${pkgTarget} --output "${outPath}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (fs.existsSync(outPath)) {
    const size = fs.statSync(outPath).size;
    console.log(`✓ Sidecar built: ${outPath} (${Math.round(size / 1024 / 1024)}MB)`);
  } else {
    console.error('✗ Sidecar build failed - output not found');
    process.exit(1);
  }

  // Step 4: Copy sql-wasm.wasm alongside the binary for sidecar mode
  console.log('Step 4: Copying sql-wasm.wasm...');
  const wasmSrc = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const wasmDst = path.join(BINARIES_DIR, 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, wasmDst);
    console.log(`✓ Copied sql-wasm.wasm (${Math.round(fs.statSync(wasmDst).size / 1024)}KB)`);
  } else {
    console.warn('⚠ sql-wasm.wasm not found, sidecar may fail to initialize SQLite');
  }
}

main();
