// Seeds the O*NET v1 vocabulary subset into the `skills` table.
// Attribution: This product incorporates information from the O*NET Database by the
// U.S. Department of Labor, Employment and Training Administration (USDOL/ETA).
// O*NET(R) is a trademark of USDOL/ETA.
//
// Run: node scripts/seed-onet.mjs
// Requires Node >= 22.6 (this .mjs imports ../lib/skills/onet-parse.ts via native
//   type-stripping; older Node cannot resolve the .ts import). See package.json engines / .nvmrc.
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Requires the three .txt files under scripts/onet-data/ (see README there).

import { readFileSync, existsSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  parseOccupationData,
  parseSkillsElements,
  parseTechnologySkills,
  V1_OCCUPATION_PREFIXES,
} from "../lib/skills/onet-parse.ts";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const DATA_DIR = "scripts/onet-data";
const files = {
  occupations: `${DATA_DIR}/Occupation Data.txt`,
  skills: `${DATA_DIR}/Skills.txt`,
  tech: `${DATA_DIR}/Technology Skills.txt`,
};
for (const [name, path] of Object.entries(files)) {
  if (!existsSync(path)) {
    console.error(`Missing O*NET file for ${name}: ${path} (see ${DATA_DIR}/README.md)`);
    process.exit(1);
  }
}

// Build the occupation allowlist from Occupation Data.txt, filtered to v1 SOC prefixes.
const occText = readFileSync(files.occupations, "utf8");
const allCodes = occText
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split("\t")[0]?.trim())
  .filter(Boolean);
const allowlist = new Set(
  allCodes.filter((code) => V1_OCCUPATION_PREFIXES.some((p) => code.startsWith(p)))
);

const rows = [
  ...parseOccupationData(occText, allowlist),
  ...parseSkillsElements(readFileSync(files.skills, "utf8")),
  ...parseTechnologySkills(readFileSync(files.tech, "utf8"), allowlist),
];

console.log(
  `Prepared ${rows.length} skills rows ` +
    `(${rows.filter((r) => r.type === "occupation").length} occupations, ` +
    `${rows.filter((r) => r.type === "skill").length} skills, ` +
    `${rows.filter((r) => r.type === "competency").length} competencies).`
);

const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Upsert in batches, keyed on the existing unique(canonical_name, type) index.
const BATCH = 200;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const { error } = await db
    .from("skills")
    .upsert(batch, { onConflict: "canonical_name,type", ignoreDuplicates: false });
  if (error) {
    console.error(`Batch ${i}-${i + batch.length} failed: ${error.message}`);
    process.exit(1);
  }
}
console.log(`Seeded ${rows.length} rows into skills (idempotent — safe to re-run).`);
