// Seeds the O*NET v1 vocabulary subset into the `skills` table.
// Attribution: This product incorporates information from the O*NET Database by the
// U.S. Department of Labor, Employment and Training Administration (USDOL/ETA).
// O*NET(R) is a trademark of USDOL/ETA.
//
// Run: node scripts/seed-onet.mjs
// Requires Node >= 22.6 (this .mjs imports ../lib/skills/onet-parse.ts via native
//   type-stripping; older Node cannot resolve the .ts import). See package.json engines / .nvmrc.
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Requires the O*NET Database "Text Files" release unzipped directly into
//   scripts/onet-data/ (see README there). Works turnkey against a fresh db_30_3_text.zip
//   download: no manual file surgery required. Also tolerates the pre-30.3 file names
//   (Skills.txt / Technology Skills.txt) if present.

import { readFileSync, existsSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  parseOccupationData,
  parseSkillsElements,
  parseTechnologySkills,
  parseOccupationSkillImportance,
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

// O*NET 30.3 split the old unified Skills.txt into Essential Skills.txt +
// Transferable Skills.txt, and renamed Technology Skills.txt -> Software Skills.txt.
// Resolve whichever shape is actually on disk so a fresh db_30_3_text.zip unzip works
// with zero manual file prep.
const occupationsPath = `${DATA_DIR}/Occupation Data.txt`;
const legacySkillsPath = `${DATA_DIR}/Skills.txt`;
const essentialSkillsPath = `${DATA_DIR}/Essential Skills.txt`;
const transferableSkillsPath = `${DATA_DIR}/Transferable Skills.txt`;
const legacyTechPath = `${DATA_DIR}/Technology Skills.txt`;
const softwareSkillsPath = `${DATA_DIR}/Software Skills.txt`;

const hasLegacySkills = existsSync(legacySkillsPath);
const hasSplitSkills = existsSync(essentialSkillsPath) && existsSync(transferableSkillsPath);
const hasLegacyTech = existsSync(legacyTechPath);
const hasSoftwareSkills = existsSync(softwareSkillsPath);

const missing = [];
if (!existsSync(occupationsPath)) missing.push(occupationsPath);
if (!hasLegacySkills && !hasSplitSkills) {
  missing.push(`${legacySkillsPath} OR (${essentialSkillsPath} AND ${transferableSkillsPath})`);
}
if (!hasLegacyTech && !hasSoftwareSkills) {
  missing.push(`${legacyTechPath} OR ${softwareSkillsPath}`);
}
if (missing.length > 0) {
  console.error(
    `Missing O*NET input file(s) under ${DATA_DIR}/ (see ${DATA_DIR}/README.md):\n` +
      missing.map((m) => `  - ${m}`).join("\n")
  );
  process.exit(1);
}

// Build the occupation allowlist from Occupation Data.txt, filtered to v1 SOC prefixes.
const occText = readFileSync(occupationsPath, "utf8");
const allCodes = occText
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split("\t")[0]?.trim())
  .filter(Boolean);
const allowlist = new Set(
  allCodes.filter((code) => V1_OCCUPATION_PREFIXES.some((p) => code.startsWith(p)))
);

// Skills: prefer the legacy unified file if present; otherwise parse Essential + Transferable
// separately (each is a valid O*NET table in its own right) and merge, deduping by Element ID
// — together they are the fixed ~35-element Skills taxonomy. Never concatenate raw text across
// files: that would duplicate the header row into the parsed rows.
let skillRows;
if (hasLegacySkills) {
  skillRows = parseSkillsElements(readFileSync(legacySkillsPath, "utf8"));
} else {
  const essential = parseSkillsElements(readFileSync(essentialSkillsPath, "utf8"));
  const transferable = parseSkillsElements(readFileSync(transferableSkillsPath, "utf8"));
  const seen = new Set();
  skillRows = [];
  for (const row of [...essential, ...transferable]) {
    if (row.onet_id && seen.has(row.onet_id)) continue;
    if (row.onet_id) seen.add(row.onet_id);
    skillRows.push(row);
  }
}

// Technology: prefer the legacy Technology Skills.txt if present; otherwise fall back to the
// 30.3 rename Software Skills.txt (onet-parse.ts tolerates its renamed Example column).
const techPath = hasLegacyTech ? legacyTechPath : softwareSkillsPath;
const techRows = parseTechnologySkills(readFileSync(techPath, "utf8"), allowlist);

const rows = [...parseOccupationData(occText, allowlist), ...skillRows, ...techRows];

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

// --- Plan 5: seed occupation_skills (occupation -> required-skill relation) ---
// Must run AFTER skills are upserted: occupation_skills FKs skills.id. Re-select the seeded
// vocabulary to build an onet_id -> id map, parse the occupation×skill importance rows, map through
// the id lookup (dropping any skill element not in the seeded vocabulary), and batch-upsert.
//
// SOURCE FILES: the occupation×skill IM rows live either in the legacy unified `Skills.txt`
// (pre-30.3) OR in the 30.3 split `Essential Skills.txt` + `Transferable Skills.txt`. Both share
// the O*NET-SOC Code / Element ID / Scale ID / Data Value columns parseOccupationSkillImportance
// reads, so we parse WHICHEVER files exist (mirroring the skills-vocabulary branch above). This
// avoids silently producing an empty relation when a repo is seeded from the legacy file — the
// same input shape the vocabulary path already supports.
const occSkillSourcePaths = hasLegacySkills
  ? [legacySkillsPath]
  : [essentialSkillsPath, transferableSkillsPath];

const { data: seededSkills, error: selErr } = await db
  .from("skills")
  .select("id, onet_id")
  .not("onet_id", "is", null)
  .range(0, 9999);
if (selErr) {
  console.error(`Re-select of seeded skills failed: ${selErr.message}`);
  process.exit(1);
}
const idByOnetId = new Map(seededSkills.map((r) => [r.onet_id, r.id]));

// Parse every source file and concatenate the parsed rows (never concatenate raw text — that would
// duplicate header rows). Resolve O*NET ids -> skills.id; drop rows whose occupation or skill is
// not in the vocabulary (e.g. an element pruned during the ~35-skill dedup, or a technology
// 'competency' with a null onet_id). Collapse duplicate (occ, skill) pairs, keeping higher IM.
const parsedRel = occSkillSourcePaths.flatMap((p) =>
  parseOccupationSkillImportance(readFileSync(p, "utf8"), allowlist)
);
const relByKey = new Map();
for (const row of parsedRel) {
  const occId = idByOnetId.get(row.occupation_onet_id);
  const skillId = idByOnetId.get(row.skill_onet_id);
  if (!occId || !skillId) continue;
  const key = `${occId}::${skillId}`;
  const prev = relByKey.get(key);
  if (!prev || row.importance > prev.importance) {
    relByKey.set(key, { occupation_id: occId, skill_id: skillId, importance: row.importance });
  }
}
const relRows = Array.from(relByKey.values());
console.log(
  `Prepared ${relRows.length} occupation_skills rows from ${occSkillSourcePaths.length} source ` +
    `file(s): ${occSkillSourcePaths.join(", ")}.`
);
if (relRows.length < 1000) {
  console.error(
    `occupation_skills row count (${relRows.length}) is suspiciously low — expected >= ~1000. ` +
      "A broken onet_id join or importance filter would produce this. Stop and debug before " +
      "relying on the gap math; do NOT proceed to later tasks with a near-empty relation."
  );
  process.exit(1);
}

for (let i = 0; i < relRows.length; i += BATCH) {
  const batch = relRows.slice(i, i + BATCH);
  const { error } = await db
    .from("occupation_skills")
    .upsert(batch, { onConflict: "occupation_id,skill_id", ignoreDuplicates: false });
  if (error) {
    console.error(`occupation_skills batch ${i}-${i + batch.length} failed: ${error.message}`);
    process.exit(1);
  }
}
console.log(`Seeded ${relRows.length} rows into occupation_skills (idempotent — safe to re-run).`);
