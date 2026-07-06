import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Secret env-var names a test must never READ. A test may still MENTION a name to prove it is not
// required — e.g. the Task 3 adapter specs call `vi.stubEnv("STRIPE_SECRET_KEY", "")` (a string
// literal, not a process.env read) to assert the injected-fake path needs no key. The guard flags
// only a genuine READ that could feed construction — `process.env.<SECRET>` that is NEITHER a
// `delete process.env.<SECRET>` guard NOR an assignment `process.env.<SECRET> = …` (save/restore).
// It does NOT match a bare string literal like "STRIPE_SECRET_KEY". This keeps the guard's teeth
// (a real `new Stripe(process.env.STRIPE_SECRET_KEY)` still trips it) without being self-defeating.
const FORBIDDEN_SECRETS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "POSTMARK_SERVER_TOKEN",
];

/**
 * True only for a genuine READ of process.env.<SECRET> — one that is NOT part of a
 * `delete process.env.<SECRET>` guard and NOT the left-hand side of an assignment
 * `process.env.<SECRET> = …` (a save/restore idiom). Both of those are allowed because they PROVE
 * the key is not required rather than consuming it; only a read that could feed client construction
 * is flagged. A bare string literal ("STRIPE_SECRET_KEY", e.g. in vi.stubEnv) never matches.
 */
function readsSecret(src: string, secret: string): boolean {
  // process.env.<SECRET> not preceded by `delete ` and not followed by an `=` (single-`=` assign).
  const re = new RegExp(
    `(?<!delete\\s)process\\.env\\.${secret}\\b(?!\\s*=(?!=))`
  );
  return re.test(src);
}

// The ONLY file allowed to import the real Stripe SDK.
const STRIPE_SDK_ALLOWLIST = new Set([path.join("lib", "billing", "stripe.ts")]);

// This guard file itself lists the secret names as string literals in FORBIDDEN_SECRETS;
// exclude it from the scan so the guard never trips on its own source.
const SECRET_SCAN_ALLOWLIST = new Set([
  path.join("tests", "guards", "no-real-billing-keys.test.ts"),
]);

const IGNORE_DIRS = new Set(["node_modules", ".next", ".git", "coverage", ".vercel"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (IGNORE_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(repoRoot);
const rel = (f: string) => path.relative(repoRoot, f);

const isTestFile = (f: string) => {
  const r = rel(f);
  return r.startsWith("tests" + path.sep) || /\.test\.tsx?$/.test(r);
};

// Regex that matches an import/require of the bare `stripe` package (not lib/billing/stripe).
const STRIPE_IMPORT = /(?:import[^;]*from\s*|require\(\s*)["']stripe["']/;

test("no test file reads a real Stripe or Postmark secret", () => {
  const offenders: string[] = [];
  for (const f of allFiles) {
    if (!isTestFile(f)) continue;
    if (!/\.tsx?$/.test(f)) continue;
    if (SECRET_SCAN_ALLOWLIST.has(rel(f))) continue;
    const src = readFileSync(f, "utf8");
    for (const secret of FORBIDDEN_SECRETS) {
      // A `delete process.env.<SECRET>` guard is allowed (it PROVES the key is not read);
      // an actual read of the value is not.
      if (readsSecret(src, secret)) offenders.push(`${rel(f)} reads ${secret}`);
    }
  }
  expect(offenders, offenders.join("\n")).toEqual([]);
});

test("only lib/billing/stripe.ts imports the 'stripe' package", () => {
  const offenders: string[] = [];
  for (const f of allFiles) {
    if (!/\.tsx?$/.test(f)) continue;
    const relPath = rel(f);
    if (STRIPE_SDK_ALLOWLIST.has(relPath)) continue;
    const src = readFileSync(f, "utf8");
    if (STRIPE_IMPORT.test(src)) offenders.push(`${relPath} imports the 'stripe' package`);
  }
  expect(offenders, offenders.join("\n")).toEqual([]);
});
