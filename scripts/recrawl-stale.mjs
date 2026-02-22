#!/usr/bin/env node

/**
 * Re-crawl apps where lastUpdated is older than N days.
 *
 * Usage:
 *   node scripts/recrawl-stale.mjs --days 14
 *   node scripts/recrawl-stale.mjs --days 30 --dry-run
 *   node scripts/recrawl-stale.mjs --days 7 --category DeFi
 *   node scripts/recrawl-stale.mjs --days 7 --auth-only   # login/wallet apps only (CI)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const APPS_FILE = resolve(PROJECT_ROOT, "src/data/apps.ts");

const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "14" },
    "dry-run": { type: "boolean", default: false },
    "auth-only": { type: "boolean", default: false },
    category: { type: "string" },
    slug: { type: "string" },
  },
  strict: false,
});

const MAX_AGE_DAYS = parseInt(args.days, 10);
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);

// ─── Load apps ──────────────────────────────────────────────────────────

function loadApps() {
  const raw = readFileSync(APPS_FILE, "utf-8");
  const entries = [];
  const blockRe = /\{\s*slug:\s*"([^"]+)"[\s\S]*?accentColor:\s*"[^"]+"/g;
  let block;
  while ((block = blockRe.exec(raw)) !== null) {
    const text = block[0];
    const slug = block[1];
    const nameMatch = text.match(/name:\s*"([^"]+)"/);
    const dateMatch = text.match(/lastUpdated:\s*"([^"]+)"/);
    const catMatch = text.match(/category:\s*"([^"]+)"/);
    const authMatch = text.match(/authType:\s*"([^"]+)"/);
    const screenCountMatch = text.match(/screenCount:\s*(\d+)/);
    entries.push({
      slug,
      name: nameMatch?.[1] || slug,
      lastUpdated: dateMatch?.[1] || "2020-01-01",
      category: catMatch?.[1] || "",
      authType: authMatch?.[1] || "public",
      screenCount: parseInt(screenCountMatch?.[1] || "0", 10),
    });
  }
  return entries;
}

const allApps = loadApps();

// Filter stale apps
let stale = allApps.filter((app) => {
  if (app.screenCount === 0) return false;
  const updated = new Date(app.lastUpdated);
  return updated < cutoff;
});

if (args["auth-only"]) {
  stale = stale.filter((a) => a.authType !== "public");
}
if (args.category) {
  stale = stale.filter((a) => a.category === args.category);
}
if (args.slug) {
  stale = stale.filter((a) => a.slug === args.slug);
}

// Sort by stalest first
stale.sort((a, b) => new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime());

console.log(`\nFound ${stale.length} stale apps (not updated in ${MAX_AGE_DAYS}+ days)\n`);

if (stale.length === 0) {
  console.log("Nothing to recrawl.");
  process.exit(0);
}

for (const app of stale) {
  const age = Math.floor((Date.now() - new Date(app.lastUpdated).getTime()) / 86400000);
  console.log(`  ${app.name.padEnd(20)} last updated: ${app.lastUpdated} (${age}d ago) [${app.authType}]`);
}

if (args["dry-run"]) {
  console.log("\nDRY RUN — would recrawl the apps above.");
  process.exit(0);
}

// ─── Browser Use fallback config ─────────────────────────────────────

const BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;
const FALLBACK_THRESHOLD = 5; // If Playwright produces ≤5 screenshots, try Browser Use
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, "public/screenshots");

function getRawScreenshotCount(slug) {
  const rawPath = resolve(SCREENSHOT_DIR, `${slug}-raw.json`);
  if (!existsSync(rawPath)) return 0;
  try {
    const raw = JSON.parse(readFileSync(rawPath, "utf-8"));
    return raw.totalScreenshots || raw.screens?.length || raw.pages?.length || 0;
  } catch {
    return 0;
  }
}

// ─── Recrawl ────────────────────────────────────────────────────────────

const results = { success: [], failed: [], skipped: [], fallback: [] };

for (let i = 0; i < stale.length; i++) {
  const app = stale[i];
  console.log(`\n  [${i + 1}/${stale.length}] Recrawling ${app.name}...`);

  // Skip login apps unless --auth-only is set (CI has saved profiles)
  if (app.authType === "login" && !args["auth-only"]) {
    console.log(`    SKIP: "${app.name}" requires login (use --auth-only in CI)`);
    results.skipped.push(app.name);
    continue;
  }

  const crawlArgs = ["--slug", app.slug];
  if (app.authType === "wallet") crawlArgs.push("--wallet");
  if (app.authType === "login") crawlArgs.push("--login");

  // Step 1: Try Playwright crawl
  let playwrightOk = true;
  try {
    execFileSync("node", [resolve(__dirname, "crawl-app.mjs"), ...crawlArgs], {
      stdio: "inherit",
      cwd: PROJECT_ROOT,
      timeout: 600000,
    });
  } catch (err) {
    console.error(`    Playwright crawl failed: ${err.message}`);
    playwrightOk = false;
  }

  // Step 2: Check screenshot count — fallback to Browser Use if too few
  // Note: if Playwright crashed, the old raw.json may still have a high count
  // from a previous crawl, so we always fallback when Playwright fails
  const screenshotCount = getRawScreenshotCount(app.slug);
  let usedFallback = false;
  const needsFallback = !playwrightOk || screenshotCount <= FALLBACK_THRESHOLD;

  if (needsFallback && BROWSER_USE_API_KEY) {
    const reason = !playwrightOk
      ? "Playwright failed"
      : `only ${screenshotCount} screenshots`;
    console.log(`    Browser Use fallback triggered (${reason})...`);

    try {
      execFileSync(
        "node",
        [resolve(__dirname, "browser-use-fallback.mjs"), "--slug", app.slug],
        {
          stdio: "inherit",
          cwd: PROJECT_ROOT,
          timeout: 360000, // 6 min (includes API polling)
          env: { ...process.env, BROWSER_USE_API_KEY },
        },
      );
      usedFallback = true;
      results.fallback.push(app.name);
    } catch (err) {
      console.error(`    Browser Use fallback failed: ${err.message}`);
    }
  } else if (needsFallback && !BROWSER_USE_API_KEY) {
    console.log(`    No BROWSER_USE_API_KEY — skipping fallback (${screenshotCount} screenshots)`);
  }

  // Step 3: Label — use the appropriate labeler
  const labelCmd = usedFallback ? "label-browser-use.mjs" : "label-local.mjs";

  const postSteps = [
    { label: "Labeling", cmd: labelCmd, args: ["--slug", app.slug], timeout: 120000 },
    { label: "Tagging", cmd: "auto-tag.mjs", args: ["--slug", app.slug], timeout: 120000 },
    { label: "Syncing", cmd: "sync-manifests.mjs", args: ["--slug", app.slug], timeout: 120000 },
  ];

  let ok = playwrightOk || usedFallback;
  if (ok) {
    for (const step of postSteps) {
      try {
        execFileSync("node", [resolve(__dirname, step.cmd), ...step.args], {
          stdio: "inherit",
          cwd: PROJECT_ROOT,
          timeout: step.timeout,
        });
      } catch (err) {
        console.error(`    ${step.label} failed: ${err.message}`);
        ok = false;
        break;
      }
    }
  }

  if (ok) {
    results.success.push(app.name);
  } else {
    results.failed.push(app.name);
  }
}

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  Recrawl complete:`);
console.log(`    Success: ${results.success.length}`);
console.log(`    Failed: ${results.failed.length}`);
console.log(`    Skipped (needs login): ${results.skipped.length}`);
if (results.fallback.length > 0) {
  console.log(`    Browser Use fallback: ${results.fallback.length} (${results.fallback.join(", ")})`);
}
console.log(`${"─".repeat(60)}`);
