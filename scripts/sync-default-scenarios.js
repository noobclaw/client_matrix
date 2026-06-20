#!/usr/bin/env node
// Regenerates src/renderer/data/defaultScenarios.ts from the backend
// scenario manifests. Run this whenever backend/scenarios/<id>/manifest.json
// gets edited so the bundled fallback inside the client stays in sync.
//
// Usage:  node scripts/sync-default-scenarios.js [path/to/backend/scenarios]
const fs = require('fs');
const path = require('path');

const fallback = path.resolve(__dirname, '..', '..', 'backend', 'scenarios');
const root = process.argv[2] || (fs.existsSync(fallback) ? fallback : null);
if (!root || !fs.existsSync(root)) {
  console.error(`backend scenarios dir not found. pass it as the first argument.`);
  process.exit(1);
}

const manifests = [];
for (const dir of fs.readdirSync(root)) {
  const p = path.join(root, dir, 'manifest.json');
  if (fs.existsSync(p)) manifests.push(JSON.parse(fs.readFileSync(p, 'utf8')));
}
manifests.sort((a, b) => String(a.id).localeCompare(String(b.id)));

const out = path.resolve(__dirname, '..', 'src', 'renderer', 'data', 'defaultScenarios.ts');
fs.mkdirSync(path.dirname(out), { recursive: true });

const banner = `/**
 * defaultScenarios — bundled snapshot of every scenario manifest at
 * client build time. Used as the synchronous initial value for the
 * scenarios state so the "创建新的涨粉任务" buttons are clickable from
 * the very first paint, even before the async listScenarios() request
 * to api.noobclaw.com comes back.
 *
 * The remote API still wins once it returns — listScenarios() result
 * REPLACES this snapshot in state, so any backend-side scenario edit
 * (new keywords, tweaked risk_caps, etc.) reaches the user within the
 * normal refresh cycle. This is purely a "don't make the user stare
 * at a grey button while we wait" warm-cache.
 *
 * AUTO-GENERATED from backend/scenarios/<id>/manifest.json — do not edit
 * by hand. Regenerate with: node scripts/sync-default-scenarios.js
 */
import type { Scenario } from '../services/scenario';

`;
// Backend manifest.json carries a few fields that aren't in the
// client-side Scenario IPC type (max_posts_per_day extras, looser
// entry_urls / skills shapes from older scenarios, …). Cast through
// unknown so tsc doesn't object — at runtime the WorkflowsPages just
// pluck the fields they actually care about, and any field missing
// from the cast falls back to the remote API result on first refresh.
fs.writeFileSync(out, banner + 'export const DEFAULT_SCENARIOS: Scenario[] = (' + JSON.stringify(manifests, null, 2) + ' as unknown) as Scenario[];\n');
console.log(`wrote ${out} (${manifests.length} scenarios, ${fs.statSync(out).size} bytes)`);
