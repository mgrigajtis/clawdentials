#!/usr/bin/env node

/**
 * Label Browser Use screenshots — converts Browser Use raw manifests
 * (pages format with curated labels) to the standard manifest format
 * (screens with flows).
 *
 * Browser Use raw.json uses { pages: [{ step, label, file }] }
 * Standard manifest uses { screens: [{ step, label, flow, image }] }
 *
 * Usage:
 *   node scripts/label-browser-use.mjs --slug frame
 *   node scripts/label-browser-use.mjs          (all Browser Use raw manifests)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, "public/screenshots");

const { values: args } = parseArgs({
  options: { slug: { type: "string" } },
  strict: false,
});

// ─── Flow classification by label keywords ──────────────────────────

const FLOW_RULES = [
  {
    flow: "Swap",
    patterns: [
      /\bswap\b/i, /\btrad(e|ing)\b/i, /\bexchange\b/i, /\bconvert\b/i,
      /\bmarket[s]?\b/i, /\bperp/i, /\bfutures\b/i, /\border\s?book/i,
      /\bcopy.?trad/i, /\bspot\b/i,
    ],
  },
  {
    flow: "Staking",
    patterns: [
      /\bstak/i, /\bearn\b/i, /\blend/i, /\bborrow/i, /\bpool/i,
      /\bliquidity/i, /\byield\b/i, /\bvault/i, /\breward/i,
      /\bgovernance\b/i, /\bvot/i, /\bdao\b/i, /\bapy\b/i,
    ],
  },
  {
    flow: "Send",
    patterns: [
      /\bsend\b/i, /\btransfer\b/i, /\bbridge\b/i, /\bwithdraw/i,
      /\bpayment/i, /\bdeposit\b/i, /\bannounce/i,
    ],
  },
  {
    flow: "Onboarding",
    patterns: [
      /\bsign.?up\b/i, /\blogin\b/i, /\bregister\b/i, /\bonboard/i,
      /\bcreate.?account/i, /\bget.?started\b/i,
    ],
  },
  {
    flow: "Settings",
    patterns: [
      /\bsetting/i, /\bhelp\b/i, /\bfaq\b/i, /\babout\b/i,
      /\blegal\b/i, /\bterms\b/i, /\bprivacy\b/i, /\blearn\b/i,
      /\bsupport\b/i, /\bblog\b/i, /\bcareer/i, /\bcontact\b/i,
      /\bdoc(s|umentation)\b/i, /\bcommunity\b/i, /\bpolicy\b/i,
      /\bdisclaimer\b/i,
    ],
  },
];

function classifyFlowByLabel(label) {
  for (const rule of FLOW_RULES) {
    for (const p of rule.patterns) {
      if (p.test(label)) return rule.flow;
    }
  }
  return "Home";
}

function slugifyLabel(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

// ─── Process one app ─────────────────────────────────────────────────

function processApp(slug) {
  const rawPath = resolve(SCREENSHOT_DIR, `${slug}-raw.json`);
  if (!existsSync(rawPath)) {
    console.log(`  SKIP: ${rawPath} not found`);
    return null;
  }

  const raw = JSON.parse(readFileSync(rawPath, "utf-8"));

  // Only process Browser Use manifests (pages format)
  if (!raw.pages) {
    console.log(`  SKIP: ${slug} — not a Browser Use manifest (no pages array)`);
    return null;
  }

  console.log(`\nLabeling ${raw.pages.length} Browser Use screenshots for ${slug}`);

  // Classify flows
  const labeled = raw.pages.map((page) => ({
    ...page,
    // Sanitize label — remove newlines that can break apps.ts string literals
    label: (page.label || `Step ${page.step}`)
      .replace(/[\n\r]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    flow: classifyFlowByLabel(page.label || ""),
  }));

  // Group by flow and assign step numbers
  const byFlow = {};
  for (const item of labeled) {
    if (!byFlow[item.flow]) byFlow[item.flow] = [];
    byFlow[item.flow].push(item);
  }

  const screens = [];

  for (const [flow, items] of Object.entries(byFlow)) {
    items.forEach((item, i) => {
      const step = i + 1;
      const desc = slugifyLabel(item.label);
      const newFilename = `${slug}-${flow.toLowerCase()}-${step}-${desc}.png`;

      // Rename the raw file to the labeled filename
      const oldFilename = item.file.replace("/screenshots/", "");
      const oldPath = resolve(SCREENSHOT_DIR, oldFilename);
      const newPath = resolve(SCREENSHOT_DIR, newFilename);

      if (existsSync(oldPath) && oldPath !== newPath) {
        try {
          renameSync(oldPath, newPath);
        } catch (e) {
          console.log(`  ⚠ Rename failed: ${oldFilename} → ${newFilename}`);
        }
      }

      screens.push({
        step,
        label: item.label,
        flow,
        image: `/screenshots/${newFilename}`,
      });
    });
  }

  // Flow summary
  const flowSummary = Object.entries(byFlow)
    .map(([f, items]) => `${f}: ${items.length}`)
    .join(", ");

  // Write manifest
  const manifest = {
    slug,
    url: raw.url || "",
    crawledAt: raw.crawledAt,
    totalScreenshots: screens.length,
    totalStates: screens.length,
    screens,
  };

  const manifestPath = resolve(SCREENSHOT_DIR, `${slug}-manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`  ✓ ${screens.length} screens → ${flowSummary}`);
  console.log(`  Manifest: ${manifestPath}`);

  return manifest;
}

// ─── Main ────────────────────────────────────────────────────────────

if (args.slug) {
  processApp(args.slug);
} else {
  // Process all Browser Use raw manifests
  const files = readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith("-raw.json"));
  let count = 0;

  for (const file of files) {
    const slug = file.replace("-raw.json", "");
    const raw = JSON.parse(readFileSync(resolve(SCREENSHOT_DIR, file), "utf-8"));
    if (raw.pages) {
      processApp(slug);
      count++;
    }
  }

  console.log(`\nProcessed ${count} Browser Use manifest(s)`);
}

console.log("\nDone! Next: node scripts/auto-tag.mjs && node scripts/sync-manifests.mjs");
