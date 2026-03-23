#!/usr/bin/env node
'use strict';

/**
 * Edge — build script
 * Usage:
 *   node build.js           # build for current platform, x64
 *   node build.js --win     # Windows portable x64
 *   node build.js --linux   # Linux AppImage x64
 *   node build.js --mac     # macOS dmg (x64 + arm64)
 *   node build.js --all     # all three platforms
 */

const { execSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');

const args  = process.argv.slice(2);
const root  = __dirname;

// ── Ensure electron-builder is installed ────────────────────────────────────
const ebBin = path.join(root, 'node_modules', '.bin', 'electron-builder');
if (!fs.existsSync(ebBin)) {
  console.log('📦  Installing dependencies…');
  execSync('npm install', { cwd: root, stdio: 'inherit' });
}

// ── Ensure build-assets directory exists (icon placeholder) ─────────────────
const assetsDir = path.join(root, 'build-assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

// ── Determine targets ────────────────────────────────────────────────────────
let targets = [];
if (args.includes('--all'))   targets = ['--win', '--linux', '--mac'];
else if (args.includes('--win'))   targets = ['--win'];
else if (args.includes('--linux')) targets = ['--linux'];
else if (args.includes('--mac'))   targets = ['--mac'];
else {
  // Auto-detect current platform
  const plat = process.platform;
  if (plat === 'win32')  targets = ['--win'];
  else if (plat === 'darwin') targets = ['--mac'];
  else                    targets = ['--linux'];
}

// ── Run build ────────────────────────────────────────────────────────────────
const cmd = `"${ebBin}" ${targets.join(' ')} --x64`;
console.log(`\n🔨  Building Edge → dist/`);
console.log(`    ${cmd}\n`);

try {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
  console.log('\n✅  Build complete! Output in ./dist/');
} catch (err) {
  console.error('\n❌  Build failed.');
  process.exit(1);
}
