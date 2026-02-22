#!/usr/bin/env node

/**
 * Browser Use cloud fallback crawler.
 *
 * Calls the Browser Use REST API to crawl an app when Playwright fails
 * (bot detection, CAPTCHA, Cloudflare challenges). ~$0.006/step.
 *
 * Usage:
 *   BROWSER_USE_API_KEY=... node scripts/browser-use-fallback.mjs --slug frame --url https://frame.sh
 *   BROWSER_USE_API_KEY=... node scripts/browser-use-fallback.mjs --slug frame   (looks up URL from apps.ts)
 *
 * Outputs:
 *   public/screenshots/{slug}-raw-NNN.png   (downloaded screenshots)
 *   public/screenshots/{slug}-raw.json      (manifest in Browser Use pages format)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, "public/screenshots");
const APPS_FILE = resolve(PROJECT_ROOT, "src/data/apps.ts");

const API_BASE = "https://api.browser-use.com/api/v1";
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes

const { values: args } = parseArgs({
  options: {
    slug: { type: "string" },
    url: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: false,
});

const API_KEY = process.env.BROWSER_USE_API_KEY;
if (!API_KEY && !args["dry-run"]) {
  console.error("ERROR: BROWSER_USE_API_KEY env var is required.");
  process.exit(1);
}

if (!args.slug) {
  console.error("ERROR: --slug is required.");
  process.exit(1);
}

const slug = args.slug;

// ─── Resolve URL ─────────────────────────────────────────────────────

function lookupUrl(slug) {
  const raw = readFileSync(APPS_FILE, "utf-8");
  const re = new RegExp(
    `\\{\\s*slug:\\s*"${slug}"[\\s\\S]*?website:\\s*"([^"]+)"`,
  );
  const m = raw.match(re);
  return m ? m[1] : null;
}

const appUrl = args.url || lookupUrl(slug);
if (!appUrl) {
  console.error(`ERROR: No URL provided and could not find website for "${slug}" in apps.ts.`);
  process.exit(1);
}

console.log(`\nBrowser Use fallback crawl: ${slug} → ${appUrl}`);

// ─── Build crawl prompt ──────────────────────────────────────────────

const CRAWL_PROMPT = `Visit ${appUrl} and systematically capture screenshots of the most important pages.

Instructions:
1. Start at the homepage — take a screenshot
2. Navigate to 8-12 key pages (look for navigation links in the header, footer, and sidebar)
3. Prioritize: homepage, product/features pages, documentation, blog, about, pricing, download, settings/help
4. For each page, wait for it to fully load before taking a screenshot
5. Skip: login/signup forms, external links, social media links
6. Take one screenshot per page (no scrolling needed — just the above-the-fold view)

After visiting each page, provide a short descriptive label (1-3 words) for what you see.`;

if (args["dry-run"]) {
  console.log("\nDRY RUN — would send this prompt to Browser Use:");
  console.log(CRAWL_PROMPT);
  console.log(`\nEstimated cost: ~$0.07 (12 steps × $0.006/step)`);
  process.exit(0);
}

// ─── API helpers ─────────────────────────────────────────────────────

async function apiCall(method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return buf.length;
}

// ─── Create task ─────────────────────────────────────────────────────

console.log("  Creating Browser Use task...");

const task = await apiCall("POST", "/run-task", {
  task: CRAWL_PROMPT,
});

const taskId = task.id || task.task_id;
if (!taskId) {
  console.error("ERROR: No task_id in response:", JSON.stringify(task));
  process.exit(1);
}

console.log(`  Task created: ${taskId}`);

// ─── Poll for completion ─────────────────────────────────────────────

console.log("  Polling for completion...");

const startTime = Date.now();
let status;

while (Date.now() - startTime < MAX_POLL_MS) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

  status = await apiCall("GET", `/task/${taskId}/status`);
  const state = status.status || status.state;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`    [${elapsed}s] Status: ${state}`);

  if (state === "completed" || state === "finished" || state === "done") {
    break;
  }
  if (state === "failed" || state === "error") {
    console.error("  Task failed:", JSON.stringify(status));
    process.exit(1);
  }
}

if (Date.now() - startTime >= MAX_POLL_MS) {
  console.error("  Task timed out after 5 minutes.");
  process.exit(1);
}

// ─── Download screenshots ────────────────────────────────────────────

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Extract screenshots from task result
const screenshots = status.screenshots || status.steps || [];
const pages = [];

console.log(`  Found ${screenshots.length} screenshots. Downloading...`);

for (let i = 0; i < screenshots.length; i++) {
  const step = screenshots[i];
  const stepNum = String(i + 1).padStart(3, "0");
  const filename = `${slug}-raw-${stepNum}.png`;
  const destPath = resolve(SCREENSHOT_DIR, filename);

  // Screenshots can be in different formats depending on API version
  const screenshotUrl =
    step.screenshot_url ||
    step.screenshot ||
    step.url ||
    `https://cdn.browser-use.com/screenshots/${taskId}/${i + 1}.png`;

  try {
    const bytes = await downloadFile(screenshotUrl, destPath);
    const label = step.label || step.description || step.title || `Step ${i + 1}`;
    // Sanitize label — remove newlines and excessive whitespace
    const cleanLabel = label.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim();

    pages.push({
      step: i + 1,
      label: cleanLabel,
      file: `/screenshots/${filename}`,
    });
    console.log(`    ${filename} (${(bytes / 1024).toFixed(0)}KB) — ${cleanLabel}`);
  } catch (err) {
    console.warn(`    SKIP ${filename}: ${err.message}`);
  }
}

if (pages.length === 0) {
  console.error("  ERROR: No screenshots downloaded.");
  process.exit(1);
}

// ─── Write raw manifest ──────────────────────────────────────────────

const manifest = {
  slug,
  source: "browser-use",
  taskId,
  crawledAt: new Date().toISOString(),
  totalScreenshots: pages.length,
  pages,
};

const manifestPath = resolve(SCREENSHOT_DIR, `${slug}-raw.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`\n  ✓ ${pages.length} screenshots downloaded`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`  Next: node scripts/label-browser-use.mjs --slug ${slug}`);
