# Trove Skills Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Trove skills engine (`lib/skills/`) — the spine of the product: a credential goes in, an O\*NET-normalized skills profile comes out. Seed a focused O\*NET vocabulary into the `skills` table, extract candidate skills from OB 2.x / OB 3.0 / CLR / VC structured data (with an injectable Claude Sonnet 4.6 fallback for text-only credentials), normalize those raw strings to the seeded canonical vocabulary deterministically, and roll the per-credential matches up into `earner_skills`. Every step is either a pure, hermetic unit-tested function or a thin dependency-injected shell so no unit test ever touches the network or a paid LLM.

**Architecture:** A strict **pure-core / impure-shell** module split under `lib/skills/`, mirroring Plan 1's conventions exactly (DI'd `SupabaseClient` first argument like `provisionEarner`, `@/` import alias, Vitest, `tests/db/*` helpers for hosted-DB integration tests, migrations numbered `0004+` and applied via `scripts/apply-migration.mjs` against the Management API). The engine has three pure transforms (`extract` → `normalize` → `rollup`), two impure adapters (`data.ts` = the only Supabase writer, `llm.ts` = the only Anthropic caller), and one impure orchestrator (`index.ts` → `processCredential`) that Plan 3's import flow calls. The canonical vocabulary is loaded once by a one-off Node seed script (`scripts/seed-onet.mjs`) plus a small extensions migration (`0004_pg_trgm.sql`). NOTE: the v1 fuzzy tier is **in-process** (`trigramSimilarity` over the vocabulary array); `0004_pg_trgm.sql` provisions `pg_trgm` + a GIN index as forward-looking infrastructure for a future DB-backed fallback but is **not queried by any code or test in Plan 2**.

**Tech Stack:** TypeScript, `@supabase/supabase-js` (already installed), `@anthropic-ai/sdk` (new, added in this plan; wraps `claude-sonnet-4-6`), Postgres `pg_trgm` for fuzzy normalization at scale, Vitest for unit + hosted-DB integration tests. No new frontend deps — the skills engine is server-side only.

## Global Constraints

Every task's requirements implicitly include these (binding, from the spec and Plan 1):

- **Product name:** Trove. Domain: trove.io.
- **Stack (do not substitute):** Next.js + Supabase (Postgres/RLS/Auth/Storage) + Vercel + Stripe + Postmark + **Claude Sonnet 4.6**. Model id for all AI work: `claude-sonnet-4-6`. Opus only if a specific later task needs it (none here).
- **AI is server-side only.** All Claude calls live behind `lib/skills/llm.ts`; the API key (`ANTHROPIC_API_KEY`, already present-but-unset in `.env.example`) never reaches the client. No `NEXT_PUBLIC_` exposure of any key.
- **Cost-conscious ("not rich"):** structured-first — the LLM is never called when a credential carries structured skill data; when it is called it sends only `title` + `description` (never `raw_json`), a single non-streaming request with small `max_tokens`, one call per credential (not per skill, not per profile view), and results are content-hash cached so duplicate imports never re-call the model. Normalization resolves the large majority of strings for free (exact/alias/trigram) before any LLM tie-break is even considered.
- **Migrations:** applied to the hosted Supabase project by POSTing SQL to the **Management API** via `node scripts/apply-migration.mjs <file>` (NOT `supabase db push`). Numbered sequentially after `0003_rls_policies.sql` → this plan adds `0004_pg_trgm.sql`. DDL is not written to be re-runnable (Supabase's migration-history table is not populated — files in git are authoritative), but this migration uses `create extension if not exists` / `create index if not exists` so it is safely idempotent.
- **No secrets in git.** `.env.local` is git-ignored and already populated (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, URL, anon key, service-role key). O\*NET source `.txt` files are treated as external gitignored input; only the seed script + a README note of the release version are committed.
- **Mirror Plan 1 test patterns:** colocated `*.test.ts` beside pure source (zero network); hosted-DB integration tests under `tests/db/` use `adminClient()` from `tests/db/admin-client.ts` (service-role, bypasses RLS) and clean up with `admin.auth.admin.deleteUser(id)` in `afterAll` (FK `on delete cascade` chains from `0002_core_schema.sql` remove dependent rows). The only tests permitted to reach a live service hit Supabase; no test ever calls the real Anthropic API — the LLM path is always exercised through an injected fake.
- **Ownership/RLS:** the earner owns the wallet. `recomputeEarnerSkills` writes only the target earner's rows; it works under either the service-role client or the earner's own session client (Plan 1's `earner_skills_owner_all` / `credential_skills_owner_all` policies already permit an earner's own rows).
- **O\*NET is public domain / CC BY 4.0.** Attribution string required (embedded as a comment in `seed-onet.mjs`): "This product incorporates information from the O\*NET Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). O\*NET® is a trademark of USDOL/ETA."

---

## File Structure

Files created/modified in this plan and their single responsibility:

- `package.json` — MODIFIED: add `@anthropic-ai/sdk` dependency
- `lib/skills/types.ts` — CREATE: all shared types; the only module every other `lib/skills/*` file may import from; zero SDK imports
- `lib/skills/extract.ts` — CREATE: pure `extractStructured` (OB2.x / OB3.0 / CLR / VC parsing) + `extractSkills` orchestrator that falls back to an injected `LlmClient` only when no structured data exists
- `lib/skills/normalize.ts` — CREATE: pure, deterministic `normalizeSkills` — three-tier cascade (exact → alias → in-process trigram) mapping raw mentions to seeded `skills` rows; zero I/O
- `lib/skills/aliases.ts` — CREATE: static alias table (`{ alias, canonicalName }[]`) hand-curated for the pilot domain; pure data
- `lib/skills/rollup.ts` — CREATE: pure `rollUpEarnerSkills` — aggregate `NormalizedSkillMatch[][]` into `EarnerSkillRollup[]` (source_count / highest_confidence math)
- `lib/skills/data.ts` — CREATE: the ONLY impure module touching Supabase; DI'd `db` first arg; owns reads/writes of `skills`, `credential_skills`, `earner_skills`, including `recomputeEarnerSkills`
- `lib/skills/llm.ts` — CREATE: the ONLY impure module touching the Anthropic SDK; `createAnthropicLlmClient()` wraps `claude-sonnet-4-6`; in-memory content-hash cache
- `lib/skills/index.ts` — CREATE: the single impure orchestrator `processCredential(db, llm, credentialId)`; wires extract → normalize → data writes → rollup
- `supabase/migrations/0004_pg_trgm.sql` — CREATE: enable `pg_trgm` + GIN trigram index on `skills.canonical_name`. NOTE: this is **speculative infrastructure** — no code or test in this plan queries Postgres via `pg_trgm`/`%`; the v1 trigram tier runs in-process (`trigramSimilarity` over the small vocabulary loaded by `getSkillVocabulary`). The extension/index are provisioned now so a future DB-backed fuzzy fallback (for when the vocabulary outgrows an in-process scan) needs no migration; it is not wired up in Plan 2.
- `scripts/seed-onet.mjs` — CREATE: one-off Node script; parses three O\*NET `.txt` files, upserts the v1 vocabulary subset into `skills`; idempotent via `onConflict`
- `scripts/onet-data/README.md` — CREATE: records the O\*NET release version/date and the download URL; the `.txt` files themselves are gitignored
- `.gitignore` — MODIFIED: ignore `scripts/onet-data/*.txt`
- `lib/skills/onet-parse.ts` — CREATE: pure parsers (`parseOccupationData`, `parseSkillsElements`, `parseTechnologySkills`) that `seed-onet.mjs` imports, so parsing is unit-testable without network/DB
- `lib/skills/normalize.test.ts` — CREATE: pure unit tests for the tier cascade
- `lib/skills/extract.test.ts` — CREATE: pure unit tests for structured parsing + LLM-fallback short-circuit (fake `LlmClient`)
- `lib/skills/rollup.test.ts` — CREATE: pure unit tests for aggregation + idempotent recompute math
- `lib/skills/onet-parse.test.ts` — CREATE: pure unit tests for O\*NET parsers against fixtures
- `lib/skills/llm.test.ts` — CREATE: pure unit tests for the cache + confidence-clamp behavior (fake Anthropic client)
- `tests/fixtures/onet-sample.txt` — CREATE: tiny hand-written O\*NET-shaped fixtures for parser tests
- `tests/db/onet-seed.test.ts` — CREATE: integration test asserting the seeded vocabulary is present
- `tests/db/skills-rollup.test.ts` — CREATE: integration test for `writeCredentialSkills` + `recomputeEarnerSkills` against hosted Supabase
- `lib/skills/index.test.ts` — CREATE: integration test of the full `processCredential` pipeline (real DB, fake LLM)

---

### Task 1: Shared types + Anthropic SDK dependency

**Files:**
- Create: `lib/skills/types.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Consumes: nothing (foundation task for Plan 2)
- Produces (the canonical type set every later task imports from `@/lib/skills/types`):
  ```ts
  export type SkillType = "skill" | "competency" | "occupation";
  export type SkillSource = "structured" | "llm";

  export interface RawSkillMention {
    rawName: string;
    type: SkillType;
    confidence: number;      // 0..1
    source: SkillSource;
    externalId?: string;     // e.g. OB alignment targetUrl
    framework?: string;      // e.g. OB alignment targetFramework
  }

  export interface StoredCredential {
    id: string;
    title: string;
    description: string;     // "" when absent
    raw_json: unknown | null;
  }

  export type ExtractMethod = "structured" | "llm" | "none";
  export interface ExtractResult {
    mentions: RawSkillMention[];
    method: ExtractMethod;
  }

  export interface CanonicalSkill {
    id: string;              // uuid
    canonical_name: string;
    type: SkillType;
    onet_id: string | null;
    aliases: string[];       // pre-joined alias strings for this skill (may be empty)
  }

  export type MatchMethod = "exact" | "alias" | "trigram" | "unmatched";
  export interface NormalizedSkillMatch {
    candidate: string;       // the rawName that was matched
    skillId: string | null;  // null when unmatched
    confidence: number;      // 0 when unmatched
    method: MatchMethod;
  }

  export interface EarnerSkillRollup {
    skillId: string;
    sourceCount: number;
    highestConfidence: number;
  }

  export interface LlmClient {
    extractSkills(input: { title: string; description: string }): Promise<RawSkillMention[]>;
  }

  export interface SkillExtractionCache {
    get(key: string): Promise<RawSkillMention[] | null>;
    set(key: string, value: RawSkillMention[]): Promise<void>;
  }
  ```

- [ ] **Step 1: Install the Anthropic SDK**

```bash
npm install @anthropic-ai/sdk
```

Expected: `@anthropic-ai/sdk` appears under `"dependencies"` in `package.json`.

- [ ] **Step 2: Write `lib/skills/types.ts`**

```ts
// Shared types for the Trove skills engine. This is the ONLY module every other
// lib/skills/* file may import from. It imports nothing from the Supabase or
// Anthropic SDKs — keeping the pure core dependency-free and unit-testable.

export type SkillType = "skill" | "competency" | "occupation";
export type SkillSource = "structured" | "llm";

/** One candidate skill mention pulled out of a credential (before normalization). */
export interface RawSkillMention {
  rawName: string;
  type: SkillType;
  confidence: number; // 0..1
  source: SkillSource;
  externalId?: string; // e.g. OB alignment targetUrl
  framework?: string; // e.g. OB alignment targetFramework
}

/** The subset of a `credentials` row the extractor needs. */
export interface StoredCredential {
  id: string;
  title: string;
  description: string; // "" when the credential has no description
  raw_json: unknown | null;
}

export type ExtractMethod = "structured" | "llm" | "none";
export interface ExtractResult {
  mentions: RawSkillMention[];
  method: ExtractMethod;
}

/** A canonical vocabulary row (from the seeded `skills` table). */
export interface CanonicalSkill {
  id: string;
  canonical_name: string;
  type: SkillType;
  onet_id: string | null;
  aliases: string[]; // pre-joined alias strings; may be empty
}

export type MatchMethod = "exact" | "alias" | "trigram" | "unmatched";
export interface NormalizedSkillMatch {
  candidate: string; // the rawName that was matched
  skillId: string | null; // null when unmatched
  confidence: number; // 0 when unmatched
  method: MatchMethod;
}

/** The aggregate written to `earner_skills`. */
export interface EarnerSkillRollup {
  skillId: string;
  sourceCount: number;
  highestConfidence: number;
}

/** Injectable LLM boundary — real impl in lib/skills/llm.ts, fake in tests. */
export interface LlmClient {
  extractSkills(input: {
    title: string;
    description: string;
  }): Promise<RawSkillMention[]>;
}

/** Content-hash cache boundary for LLM results. */
export interface SkillExtractionCache {
  get(key: string): Promise<RawSkillMention[] | null>;
  set(key: string, value: RawSkillMention[]): Promise<void>;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors (types-only module, nothing references it yet).

- [ ] **Step 4: Commit**

```bash
git add lib/skills/types.ts package.json package-lock.json
git commit -m "feat: skills-engine shared types and Anthropic SDK dependency"
```

---

### Task 2: O\*NET parsers (pure) + seed script + pg_trgm migration

> **Source data.** Download the O\*NET Database "Text Files" ZIP from
> https://www.onetcenter.org/database.html#individual-files (release 29.3 or the current
> release at execution time — do NOT hardcode a version check; the script tolerates any release
> of the same file shape). Extract exactly three tab-delimited files with header rows into
> `scripts/onet-data/` (gitignored): `Occupation Data.txt`, `Skills.txt`, `Technology Skills.txt`.
> A subagent running this task should **stop and report** if those three files are not present
> under `scripts/onet-data/`.

> **Node runtime constraint (prerequisite — verify before Steps 8–11).** `scripts/seed-onet.mjs` is a
> plain-Node `.mjs` script that directly imports `../lib/skills/onet-parse.ts`. Node resolves that `.ts`
> import only via native TypeScript type-stripping, which is on by default from **Node >= 22.6** (the repo
> runs Node 24). No `tsx`/`ts-node` fallback is added, so the script will throw a syntax/resolution error on
> older LTS Node (e.g. 20.x). Two hard requirements follow, both enforced in this task:
> 1. Pin the runtime: add `"engines": { "node": ">=22.6" }` to `package.json` and create a `.nvmrc`
>    containing the repo's Node major (`24`). This task's Step 0 does that.
> 2. `lib/skills/onet-parse.ts` MUST use ONLY relative imports and **type-only** `@/` imports
>    (`import type { SkillType } from "@/lib/skills/types"`). A value `@/…` import would break the seed
>    script because Node does not honor tsconfig `@/` path aliases at runtime — the type-only import works
>    solely because type-stripping erases it before resolution. Do not add any value `@/` import to this file.
>
> A subagent running Steps 8–11 must first confirm `node --version` reports >= 22.6 and **stop and report**
> if it does not.

**Files:**
- Create: `lib/skills/onet-parse.ts`, `lib/skills/onet-parse.test.ts`, `tests/fixtures/onet-sample.txt`, `scripts/seed-onet.mjs`, `scripts/onet-data/README.md`, `supabase/migrations/0004_pg_trgm.sql`
- Modify: `.gitignore`, `package.json` (add `engines.node`), `.nvmrc` (create)

**Interfaces:**
- Consumes: `SkillType` from `@/lib/skills/types`; the `skills` table + `skills_name_type_idx` unique(canonical_name, type) + `onet_id` unique from `0002_core_schema.sql`; `adminClient()` from `tests/db/admin-client.ts`; `scripts/apply-migration.mjs`
- Produces:
  ```ts
  // lib/skills/onet-parse.ts
  export interface SeedRow {
    canonical_name: string;
    type: SkillType;
    onet_id: string | null;
  }
  export function parseOccupationData(text: string, allowlist: Set<string>): SeedRow[];
  export function parseSkillsElements(text: string): SeedRow[];
  export function parseTechnologySkills(text: string, allowlist: Set<string>): SeedRow[];
  export const V1_OCCUPATION_PREFIXES: readonly string[]; // SOC major-group prefixes for the v1 subset
  ```
  Plus: `scripts/seed-onet.mjs` (CLI: `node scripts/seed-onet.mjs`) upserting ~300–400 rows into `skills`; a hosted Postgres with `pg_trgm` enabled and a GIN trigram index on `skills.canonical_name`.

- [ ] **Step 0: Pin the Node runtime (prerequisite for the `.mjs` → `.ts` import)**

Confirm the runtime first: `node --version` must report **>= 22.6** (repo runs 24). If it does not, stop and report — the seed script cannot run without native type-stripping.

Add an `engines` field to `package.json` so the requirement is machine-checkable:

```json
  "engines": {
    "node": ">=22.6"
  },
```

Create `.nvmrc` pinning the repo's Node major:

```
24
```

- [ ] **Step 1: Write the failing parser tests `lib/skills/onet-parse.test.ts`**

```ts
import { expect, test } from "vitest";
import {
  parseOccupationData,
  parseSkillsElements,
  parseTechnologySkills,
} from "./onet-parse";

// Minimal O*NET-shaped fixtures (tab-delimited, header row). Real files have more
// columns; parsers key on named columns from the header, so extra columns are fine.

const OCCUPATION_TXT = [
  "O*NET-SOC Code\tTitle\tDescription",
  "15-1252.00\tSoftware Developers\tDevelop applications.",
  "29-1141.00\tRegistered Nurses\tAssess patient health.",
  "99-9999.00\tExcluded Occupation\tNot in the v1 subset.",
].join("\n");

const SKILLS_TXT = [
  "O*NET-SOC Code\tElement ID\tElement Name\tScale ID\tData Value",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tIM\t4.12",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tLV\t3.88", // same element, LV scale — must dedupe
  "15-1252.00\t2.B.3.a\tCritical Thinking\tIM\t4.25",
].join("\n");

const TECH_TXT = [
  "O*NET-SOC Code\tExample\tCommodity Code\tHot Technology",
  "15-1252.00\tPython\t43232408\tY",
  "29-1141.00\tPython\t43232408\tY", // duplicate Example across occupations — must dedupe
  "15-1252.00\tMicrosoft Excel\t43232110\tN", // not hot — excluded
  "99-9999.00\tExcludedTool\t43232408\tY", // occupation not in allowlist — excluded
].join("\n");

const ALLOW = new Set(["15-1252.00", "29-1141.00"]);

test("parseOccupationData keeps only allowlisted occupations", () => {
  const rows = parseOccupationData(OCCUPATION_TXT, ALLOW);
  expect(rows).toEqual([
    { canonical_name: "Software Developers", type: "occupation", onet_id: "15-1252.00" },
    { canonical_name: "Registered Nurses", type: "occupation", onet_id: "29-1141.00" },
  ]);
});

test("parseSkillsElements returns distinct skill elements regardless of scale", () => {
  const rows = parseSkillsElements(SKILLS_TXT);
  expect(rows).toEqual([
    { canonical_name: "Reading Comprehension", type: "skill", onet_id: "2.A.1.a" },
    { canonical_name: "Critical Thinking", type: "skill", onet_id: "2.B.3.a" },
  ]);
});

test("parseTechnologySkills keeps hot tech in allowlisted occupations, deduped by Example", () => {
  const rows = parseTechnologySkills(TECH_TXT, ALLOW);
  expect(rows).toEqual([
    { canonical_name: "Python", type: "competency", onet_id: null },
  ]);
});

test("parsers tolerate a trailing blank line and CRLF endings", () => {
  const crlf = OCCUPATION_TXT.replace(/\n/g, "\r\n") + "\r\n";
  expect(parseOccupationData(crlf, ALLOW)).toHaveLength(2);
});
```

- [ ] **Step 2: Run the parser tests (expected FAIL)**

Run: `npm test -- lib/skills/onet-parse.test.ts`
Expected: FAIL — `lib/skills/onet-parse.ts` does not exist yet.

- [ ] **Step 3: Write `lib/skills/onet-parse.ts`**

```ts
// IMPORTANT: this file is imported directly by the plain-Node .mjs seed script
// (scripts/seed-onet.mjs) via native type-stripping. Use ONLY relative imports and
// TYPE-ONLY `@/` imports here. A value `@/…` import would break the seed script because
// Node does not resolve tsconfig path aliases at runtime. The `import type` below is erased
// before resolution, so it is safe.
import type { SkillType } from "@/lib/skills/types";

export interface SeedRow {
  canonical_name: string;
  type: SkillType;
  onet_id: string | null;
}

/**
 * SOC major-group prefixes for the v1 subset: Management (11), Business/Financial (13),
 * Computer/Math (15), Healthcare Practitioners (29), Healthcare Support (31),
 * Protective Service (33), Construction (47), Installation/Maintenance/Repair (49),
 * Production (51).
 *
 * PROVISIONAL — NOT YET VALIDATED AGAINST PILOT DATA. Design doc §10 says the O*NET subset
 * scope should be "tied to the first pilot sponsor's population," but no pilot sponsor has
 * been onboarded yet, so this list is a best-guess placeholder for the workforce/TRIO
 * adult-learner populations we expect. TODO(pilot-onboarding): whoever onboards the first
 * real pilot sponsor MUST revisit this list against that sponsor's actual population and get
 * product sign-off before treating it as settled. Re-run scripts/seed-onet.mjs after any change.
 */
export const V1_OCCUPATION_PREFIXES: readonly string[] = [
  "11-",
  "13-",
  "15-",
  "29-",
  "31-",
  "33-",
  "47-",
  "49-",
  "51-",
];

/** Split a tab-delimited O*NET text file into a header list + typed row objects. */
function parseTable(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

export function parseOccupationData(
  text: string,
  allowlist: Set<string>
): SeedRow[] {
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const code = row["O*NET-SOC Code"];
    const title = row["Title"];
    if (!code || !title || !allowlist.has(code)) continue;
    out.push({ canonical_name: title, type: "occupation", onet_id: code });
  }
  return out;
}

export function parseSkillsElements(text: string): SeedRow[] {
  const seen = new Set<string>();
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const id = row["Element ID"];
    const name = row["Element Name"];
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ canonical_name: name, type: "skill", onet_id: id });
  }
  return out;
}

export function parseTechnologySkills(
  text: string,
  allowlist: Set<string>
): SeedRow[] {
  const seen = new Set<string>();
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const code = row["O*NET-SOC Code"];
    const example = row["Example"];
    const hot = row["Hot Technology"];
    if (!code || !example || hot !== "Y" || !allowlist.has(code)) continue;
    const name = example.trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Technology Skills.txt has no stable per-tool ID; canonical_name is the natural key.
    out.push({ canonical_name: name, type: "competency", onet_id: null });
  }
  return out;
}
```

- [ ] **Step 4: Run the parser tests (expected PASS)**

Run: `npm test -- lib/skills/onet-parse.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the committed fixture `tests/fixtures/onet-sample.txt`** (documents the expected file shape for future maintainers; tests use inline fixtures above but this records the real header layout)

```
O*NET-SOC Code	Title	Description
15-1252.00	Software Developers	Develop applications software.
29-1141.00	Registered Nurses	Assess patient health problems and needs.
```

- [ ] **Step 6: Write `scripts/onet-data/README.md`**

```markdown
# O*NET source data (gitignored)

Place the three tab-delimited O*NET Database text files here (they are **gitignored**):

- `Occupation Data.txt`
- `Skills.txt`
- `Technology Skills.txt`

Download the "Text Files" ZIP from:
https://www.onetcenter.org/database.html#individual-files

Release used at seed time: **O*NET 29.3** (update this line when you re-seed with a newer release).

Attribution (required): This product incorporates information from the O*NET Database by the
U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). O*NET(R) is a
trademark of USDOL/ETA. O*NET data is public domain / CC BY 4.0.
```

- [ ] **Step 7: Ignore the raw O\*NET `.txt` files.** Append to `.gitignore`:

```
# O*NET source data (large, external, redownloadable)
scripts/onet-data/*.txt
```

- [ ] **Step 8: Write `scripts/seed-onet.mjs`**

```js
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
```

- [ ] **Step 9: Write `supabase/migrations/0004_pg_trgm.sql`**

```sql
-- Provision Postgres trigram matching + a GIN index on the canonical vocabulary column
-- named in 0002_core_schema.sql. NOTE: this is forward-looking infrastructure only — no
-- code or test in Plan 2 queries pg_trgm / the `%` operator / this index. Plan 2's fuzzy
-- tier runs in-process (lib/skills/normalize.ts::trigramSimilarity). This migration exists
-- so a future DB-backed fuzzy fallback (when the vocabulary outgrows an in-process scan)
-- needs no schema change. Safe/idempotent via the `if not exists` guards.
create extension if not exists pg_trgm;
create index if not exists skills_canonical_name_trgm_idx
  on skills using gin (canonical_name gin_trgm_ops);
```

- [ ] **Step 10: Apply the migration via the Management API**

Run: `node scripts/apply-migration.mjs supabase/migrations/0004_pg_trgm.sql`
Expected: `Applied … Response: []` (success). Re-running is safe (`if not exists` guards).

- [ ] **Step 11: Run the seed script**

Run: `node scripts/seed-onet.mjs`
Expected: prints the prepared row counts and `Seeded … rows into skills`. **There is no fixed pass/fail row count** — the exact totals depend on the real O\*NET release and how many of the ~1000 occupations fall under the 9 chosen SOC major groups. As a rough shape: O\*NET's Skills taxonomy is a fixed ~35-element list, but the occupation and Hot-Technology counts for 9 major groups (which include large groups like Healthcare Practitioners/29 and Production/51) can easily run into the several-hundred-to-1000+ range. Treat any successful, error-free upsert that reports nonzero occupations, skills, AND competencies as success; do NOT flag a legitimately large count as a bug, and do NOT rubber-stamp a run that seeded suspiciously few rows (e.g. zero of any category). Re-running produces the same counts and no errors (idempotent upsert).

- [ ] **Step 12: Commit (script + migration + parsers + fixtures; raw `.txt` files stay ignored)**

```bash
git add lib/skills/onet-parse.ts lib/skills/onet-parse.test.ts tests/fixtures/onet-sample.txt \
  scripts/seed-onet.mjs scripts/onet-data/README.md supabase/migrations/0004_pg_trgm.sql \
  .gitignore package.json .nvmrc
git commit -m "feat: O*NET vocabulary seed (parsers, script, pg_trgm migration)"
```

---

### Task 3: Extract — structured OB2.x/3.0/CLR/VC + injectable LLM fallback

**Files:**
- Create: `lib/skills/extract.ts`, `lib/skills/extract.test.ts`

**Interfaces:**
- Consumes: `RawSkillMention`, `StoredCredential`, `ExtractResult`, `LlmClient` from `@/lib/skills/types`
- Produces:
  ```ts
  export function extractStructured(rawJson: unknown): RawSkillMention[]; // pure, sync, no I/O
  export interface ExtractDeps { llm: LlmClient; }
  export async function extractSkills(
    credential: StoredCredential,
    deps: ExtractDeps
  ): Promise<ExtractResult>;
  ```
  Structured hits are tagged `source:"structured"` (confidence `1.0` for OB alignment, `0.9` for the permissive generic-VC branch); LLM hits are tagged `source:"llm"` with confidence clamped `<= 0.7`. `extractSkills` short-circuits and never touches `deps.llm` when structured data exists.

- [ ] **Step 1: Write the failing tests `lib/skills/extract.test.ts`**

```ts
import { expect, test, vi } from "vitest";
import { extractStructured, extractSkills, type ExtractDeps } from "./extract";
import type { LlmClient, RawSkillMention, StoredCredential } from "@/lib/skills/types";

function fakeLlm(mentions: RawSkillMention[]): LlmClient {
  return { extractSkills: vi.fn(async () => mentions) };
}
function throwingLlm(): LlmClient {
  return {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called when structured data exists");
    }),
  };
}

test("OB2.x BadgeClass alignment maps to structured mentions at confidence 1.0", () => {
  const raw = {
    type: "BadgeClass",
    alignment: [
      { targetName: "Python Programming", targetUrl: "https://x/py", targetFramework: "O*NET" },
    ],
  };
  expect(extractStructured(raw)).toEqual([
    {
      rawName: "Python Programming",
      type: "skill",
      confidence: 1.0,
      source: "structured",
      externalId: "https://x/py",
      framework: "O*NET",
    },
  ]);
});

test("OB2.x Assertion nests alignment under badge", () => {
  const raw = {
    type: "Assertion",
    badge: { alignment: [{ targetName: "Welding", targetUrl: "https://x/w" }] },
  };
  const out = extractStructured(raw);
  expect(out).toHaveLength(1);
  expect(out[0].rawName).toBe("Welding");
  expect(out[0].framework).toBeUndefined();
});

test("OB3.0 credentialSubject.achievement.alignment maps through", () => {
  const raw = {
    credentialSubject: {
      achievement: {
        alignment: [{ targetName: "Critical Thinking", targetUrl: "https://x/ct" }],
      },
    },
  };
  const out = extractStructured(raw);
  expect(out).toEqual([
    {
      rawName: "Critical Thinking",
      type: "skill",
      confidence: 1.0,
      source: "structured",
      externalId: "https://x/ct",
      framework: undefined,
    },
  ]);
});

test("CLR: achievement array yields a mention per entry; CFItem targetType is competency", () => {
  const raw = {
    credentialSubject: {
      achievement: [
        { alignment: [{ targetName: "Skill A", targetUrl: "https://x/a" }] },
        {
          alignment: [
            { targetName: "Competency B", targetUrl: "https://x/b", targetType: "CFItem" },
          ],
        },
      ],
    },
  };
  const out = extractStructured(raw);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ rawName: "Skill A", type: "skill" });
  expect(out[1]).toMatchObject({ rawName: "Competency B", type: "competency" });
});

test("generic VC credentialSubject.skills array maps at confidence 0.9", () => {
  const raw = { credentialSubject: { skills: ["Customer Service", "Scheduling"] } };
  const out = extractStructured(raw);
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({
    rawName: "Customer Service",
    type: "skill",
    confidence: 0.9,
    source: "structured",
  });
});

test("null or unrecognized raw_json returns no mentions", () => {
  expect(extractStructured(null)).toEqual([]);
  expect(extractStructured({ foo: "bar" })).toEqual([]);
  expect(extractStructured("not an object")).toEqual([]);
});

test("extractSkills short-circuits and never calls the LLM when structured data exists", async () => {
  const deps: ExtractDeps = { llm: throwingLlm() };
  const credential: StoredCredential = {
    id: "c1",
    title: "Badge",
    description: "desc",
    raw_json: { type: "BadgeClass", alignment: [{ targetName: "SQL", targetUrl: "https://x/sql" }] },
  };
  const result = await extractSkills(credential, deps);
  expect(result.method).toBe("structured");
  expect(result.mentions.map((m) => m.rawName)).toEqual(["SQL"]);
  expect(deps.llm.extractSkills).not.toHaveBeenCalled();
});

test("extractSkills falls back to the LLM once and clamps confidence to <= 0.7", async () => {
  const deps: ExtractDeps = {
    llm: fakeLlm([
      { rawName: "Leadership", type: "skill", confidence: 0.95, source: "llm" },
    ]),
  };
  const credential: StoredCredential = {
    id: "c2",
    title: "Team Lead Certificate",
    description: "Led a team.",
    raw_json: null,
  };
  const result = await extractSkills(credential, deps);
  expect(result.method).toBe("llm");
  expect(deps.llm.extractSkills).toHaveBeenCalledTimes(1);
  expect(result.mentions[0].source).toBe("llm");
  expect(result.mentions[0].confidence).toBeLessThanOrEqual(0.7);
});

test("extractSkills returns method 'none' with no text and no structured data", async () => {
  const deps: ExtractDeps = { llm: throwingLlm() };
  const credential: StoredCredential = { id: "c3", title: "", description: "", raw_json: null };
  const result = await extractSkills(credential, deps);
  expect(result).toEqual({ mentions: [], method: "none" });
  expect(deps.llm.extractSkills).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/skills/extract.test.ts`
Expected: FAIL — `lib/skills/extract.ts` does not exist.

- [ ] **Step 3: Write `lib/skills/extract.ts`**

```ts
import type {
  ExtractResult,
  LlmClient,
  RawSkillMention,
  SkillType,
  StoredCredential,
} from "@/lib/skills/types";

export interface ExtractDeps {
  llm: LlmClient;
}

const LLM_CONFIDENCE_CAP = 0.7;

interface AlignmentObject {
  targetName?: unknown;
  targetUrl?: unknown;
  targetFramework?: unknown;
  targetType?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function typeFromTargetType(targetType: unknown): SkillType {
  return targetType === "CFItem" || targetType === "CFRubric"
    ? "competency"
    : "skill";
}

function alignmentToMention(a: AlignmentObject): RawSkillMention | null {
  if (typeof a.targetName !== "string" || a.targetName.length === 0) return null;
  const mention: RawSkillMention = {
    rawName: a.targetName,
    type: typeFromTargetType(a.targetType),
    confidence: 1.0,
    source: "structured",
  };
  if (typeof a.targetUrl === "string") mention.externalId = a.targetUrl;
  if (typeof a.targetFramework === "string") mention.framework = a.targetFramework;
  return mention;
}

function mentionsFromAlignmentArray(value: unknown): RawSkillMention[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((a) => alignmentToMention(asRecord(a) ?? {}))
    .filter((m): m is RawSkillMention => m !== null);
}

/** Pure, synchronous structured parse across OB2.x, OB3.0/CLR, and generic VC shapes. */
export function extractStructured(rawJson: unknown): RawSkillMention[] {
  const root = asRecord(rawJson);
  if (!root) return [];

  // OB 2.x: BadgeClass.alignment[] or Assertion.badge.alignment[]
  const ob2Alignment =
    root.alignment ?? asRecord(root.badge)?.alignment ?? null;
  const ob2 = mentionsFromAlignmentArray(ob2Alignment);
  if (ob2.length > 0) return ob2;

  // OB 3.0 / CLR 2.0: credentialSubject.achievement(.alignment[]), achievement may be array.
  const subject = asRecord(root.credentialSubject);
  if (subject) {
    const achievement = subject.achievement;
    const achievements = Array.isArray(achievement)
      ? achievement
      : achievement != null
        ? [achievement]
        : [];
    const fromAchievements = achievements.flatMap((entry) =>
      mentionsFromAlignmentArray(asRecord(entry)?.alignment)
    );
    if (fromAchievements.length > 0) return fromAchievements;

    // Generic VC last-resort: credentialSubject.skills / .competencies string arrays.
    const generic: RawSkillMention[] = [];
    for (const key of ["skills", "competencies"] as const) {
      const arr = subject[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string" && item.length > 0) {
            generic.push({
              rawName: item,
              type: key === "competencies" ? "competency" : "skill",
              confidence: 0.9,
              source: "structured",
            });
          }
        }
      }
    }
    if (generic.length > 0) return generic;
  }

  return [];
}

/**
 * Structured-first extractor. Falls back to the injected LLM only when there is no
 * structured data AND the credential carries usable title/description text. The LLM is
 * called at most once per credential; its confidences are clamped to the cost/quality cap.
 */
export async function extractSkills(
  credential: StoredCredential,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const structured = extractStructured(credential.raw_json);
  if (structured.length > 0) {
    return { mentions: structured, method: "structured" };
  }

  const hasText =
    credential.title.trim().length > 0 || credential.description.trim().length > 0;
  if (!hasText) return { mentions: [], method: "none" };

  const raw = await deps.llm.extractSkills({
    title: credential.title,
    description: credential.description,
  });
  const mentions = raw.map((m) => ({
    ...m,
    source: "llm" as const,
    confidence: Math.min(m.confidence, LLM_CONFIDENCE_CAP),
  }));
  return { mentions, method: "llm" };
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/skills/extract.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/skills/extract.ts lib/skills/extract.test.ts
git commit -m "feat: skills extraction from OB2.x/3.0/CLR/VC with injectable LLM fallback"
```

---

### Task 4: Normalize — deterministic three-tier matcher (exact → alias → trigram)

**Files:**
- Create: `lib/skills/aliases.ts`, `lib/skills/normalize.ts`, `lib/skills/normalize.test.ts`

**Interfaces:**
- Consumes: `RawSkillMention`, `CanonicalSkill`, `NormalizedSkillMatch`, `MatchMethod` from `@/lib/skills/types`
- Produces:
  ```ts
  // lib/skills/aliases.ts
  export interface AliasEntry { alias: string; canonicalName: string; }
  export const SKILL_ALIASES: readonly AliasEntry[];

  // lib/skills/normalize.ts
  export const DEFAULT_TRIGRAM_THRESHOLD = 0.35;
  export const TRIGRAM_CONFIDENCE_CAP = 0.9;
  export function trigramSimilarity(a: string, b: string): number; // Dice coefficient over char trigrams
  export function normalizeSkills(
    mentions: RawSkillMention[],
    vocabulary: CanonicalSkill[],
    opts?: { trigramThreshold?: number; trigramScorer?: (a: string, b: string) => number }
  ): NormalizedSkillMatch[];
  ```
  Confidence per tier: exact `1.0`, alias `0.95`, trigram = `min(score, 0.9)`; unmatched `skillId:null, confidence:0`. Tier 3 (LLM tie-break) is deliberately NOT in this pure function — the design keeps `normalizeSkills` synchronous and hermetic; ambiguous/unmatched leftovers are handled by the orchestrator later (out of scope for v1's engine; a future enhancement).

- [ ] **Step 1: Write `lib/skills/aliases.ts`**

> **Precedence note (exact beats alias).** In `normalizeSkills` the exact tier runs before the alias
> tier, so any raw string that already equals a seeded `canonical_name` resolves to that seeded row and
> never reaches the alias table. Tech tool names such as `Python` / `JavaScript` / `JS` are seeded as
> `competency` rows by Task 2's Technology Skills parse, so mapping them to `Programming` here would be
> unreachable dead data. They are therefore deliberately **excluded** from `SKILL_ALIASES` — the aliases
> below only cover strings that are NOT themselves seeded canonical names (they route soft-skill phrasing
> to O\*NET Skills elements). Keep this table in sync with Task 2: never add an alias whose `alias` string
> is also seeded as a canonical name.

```ts
// Static alias table: maps common raw skill strings to a seeded O*NET canonical_name.
// Hand-curated for the pilot domain; grows deliberately (never auto-inflated by the LLM).
// The `canonicalName` values MUST match a seeded skills.canonical_name exactly.
// Do NOT list an `alias` that is itself a seeded canonical name (e.g. "Python",
// "JavaScript" are seeded competencies) — the exact tier resolves those first, making
// any such alias unreachable. See the precedence note above.
export interface AliasEntry {
  alias: string;
  canonicalName: string;
}

export const SKILL_ALIASES: readonly AliasEntry[] = [
  { alias: "Coding", canonicalName: "Programming" },
  { alias: "Public Speaking", canonicalName: "Speaking" },
  { alias: "Customer Service", canonicalName: "Service Orientation" },
  { alias: "Problem Solving", canonicalName: "Critical Thinking" },
  { alias: "Time Management", canonicalName: "Time Management" },
  { alias: "Teamwork", canonicalName: "Coordination" },
  { alias: "Active Listening", canonicalName: "Active Listening" },
];
```

- [ ] **Step 2: Write the failing tests `lib/skills/normalize.test.ts`**

```ts
import { expect, test } from "vitest";
import {
  normalizeSkills,
  trigramSimilarity,
  DEFAULT_TRIGRAM_THRESHOLD,
  TRIGRAM_CONFIDENCE_CAP,
} from "./normalize";
import type { CanonicalSkill, RawSkillMention } from "@/lib/skills/types";

const vocab: CanonicalSkill[] = [
  { id: "s1", canonical_name: "Project Management", type: "skill", onet_id: "x1", aliases: [] },
  {
    id: "s2",
    canonical_name: "Programming",
    type: "skill",
    onet_id: "x2",
    aliases: ["JS", "JavaScript", "Python"],
  },
  { id: "s3", canonical_name: "Critical Thinking", type: "skill", onet_id: "x3", aliases: [] },
];

function m(rawName: string): RawSkillMention {
  return { rawName, type: "skill", confidence: 1.0, source: "structured" };
}

test("exact match is case/whitespace-insensitive at confidence 1.0", () => {
  const out = normalizeSkills([m("  project   MANAGEMENT ")], vocab);
  expect(out[0]).toEqual({
    candidate: "  project   MANAGEMENT ",
    skillId: "s1",
    confidence: 1.0,
    method: "exact",
  });
});

test("alias match resolves to the canonical skill at confidence 0.95", () => {
  const out = normalizeSkills([m("JS")], vocab);
  expect(out[0]).toMatchObject({ skillId: "s2", confidence: 0.95, method: "alias" });
});

test("trigram match above threshold uses an injected scorer, capped at 0.9", () => {
  const scorer = (a: string, b: string) =>
    b.toLowerCase() === "project management" ? 1.0 : 0.0;
  const out = normalizeSkills([m("projet managment")], vocab, { trigramScorer: scorer });
  expect(out[0]).toMatchObject({ skillId: "s1", method: "trigram" });
  expect(out[0].confidence).toBeLessThanOrEqual(TRIGRAM_CONFIDENCE_CAP);
  expect(out[0].confidence).toBeCloseTo(TRIGRAM_CONFIDENCE_CAP);
});

test("trigram below threshold is unmatched", () => {
  const scorer = () => 0.1;
  const out = normalizeSkills([m("something unrelated")], vocab, { trigramScorer: scorer });
  expect(out[0]).toEqual({
    candidate: "something unrelated",
    skillId: null,
    confidence: 0,
    method: "unmatched",
  });
});

test("exact wins over a perfect trigram score (never outranked)", () => {
  const scorer = () => 1.0;
  const out = normalizeSkills([m("Critical Thinking")], vocab, { trigramScorer: scorer });
  expect(out[0]).toMatchObject({ skillId: "s3", confidence: 1.0, method: "exact" });
});

test("empty candidates yields empty result; empty vocab yields all unmatched", () => {
  expect(normalizeSkills([], vocab)).toEqual([]);
  const out = normalizeSkills([m("Anything")], []);
  expect(out[0].method).toBe("unmatched");
});

test("the built-in trigram scorer scores near-identical strings high and disjoint strings low", () => {
  expect(trigramSimilarity("project management", "projct management")).toBeGreaterThan(
    DEFAULT_TRIGRAM_THRESHOLD
  );
  expect(trigramSimilarity("welding", "accounting")).toBeLessThan(DEFAULT_TRIGRAM_THRESHOLD);
});
```

- [ ] **Step 3: Run the tests (expected FAIL)**

Run: `npm test -- lib/skills/normalize.test.ts`
Expected: FAIL — `lib/skills/normalize.ts` does not exist.

- [ ] **Step 4: Write `lib/skills/normalize.ts`**

```ts
import type {
  CanonicalSkill,
  NormalizedSkillMatch,
  RawSkillMention,
} from "@/lib/skills/types";
import { SKILL_ALIASES } from "@/lib/skills/aliases";

export const DEFAULT_TRIGRAM_THRESHOLD = 0.35;
export const TRIGRAM_CONFIDENCE_CAP = 0.9;
const ALIAS_CONFIDENCE = 0.95;

/** Lowercase, trim, collapse internal whitespace, strip surrounding punctuation. */
function normalizeString(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Dice-coefficient similarity over character trigrams; approximates pg_trgm for tests. */
export function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(normalizeString(a));
  const gb = trigrams(normalizeString(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

export function normalizeSkills(
  mentions: RawSkillMention[],
  vocabulary: CanonicalSkill[],
  opts?: {
    trigramThreshold?: number;
    trigramScorer?: (a: string, b: string) => number;
  }
): NormalizedSkillMatch[] {
  const threshold = opts?.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;
  const scorer = opts?.trigramScorer ?? trigramSimilarity;

  // Build lookup maps once.
  const byExact = new Map<string, CanonicalSkill>();
  const byAlias = new Map<string, CanonicalSkill>();
  const byName = new Map<string, CanonicalSkill>();
  for (const v of vocabulary) {
    byExact.set(normalizeString(v.canonical_name), v);
    byName.set(v.canonical_name, v);
    for (const a of v.aliases) byAlias.set(normalizeString(a), v);
  }
  // Static alias table (canonicalName -> vocab row, if that row is seeded).
  for (const { alias, canonicalName } of SKILL_ALIASES) {
    const target = byName.get(canonicalName);
    if (target) byAlias.set(normalizeString(alias), target);
  }

  return mentions.map((mention) => {
    const key = normalizeString(mention.rawName);

    const exact = byExact.get(key);
    if (exact) {
      return { candidate: mention.rawName, skillId: exact.id, confidence: 1.0, method: "exact" };
    }

    const alias = byAlias.get(key);
    if (alias) {
      return {
        candidate: mention.rawName,
        skillId: alias.id,
        confidence: ALIAS_CONFIDENCE,
        method: "alias",
      };
    }

    // Tier 2: trigram — best single match at/above threshold.
    let best: { skill: CanonicalSkill; score: number } | null = null;
    for (const v of vocabulary) {
      const score = scorer(mention.rawName, v.canonical_name);
      if (!best || score > best.score) best = { skill: v, score };
    }
    if (best && best.score >= threshold) {
      return {
        candidate: mention.rawName,
        skillId: best.skill.id,
        confidence: Math.min(best.score, TRIGRAM_CONFIDENCE_CAP),
        method: "trigram",
      };
    }

    return { candidate: mention.rawName, skillId: null, confidence: 0, method: "unmatched" };
  });
}
```

- [ ] **Step 5: Run the tests (expected PASS)**

Run: `npm test -- lib/skills/normalize.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/skills/aliases.ts lib/skills/normalize.ts lib/skills/normalize.test.ts
git commit -m "feat: deterministic three-tier skill normalization (exact/alias/trigram)"
```

---

### Task 5: Roll-up math (pure)

**Files:**
- Create: `lib/skills/rollup.ts`, `lib/skills/rollup.test.ts`

**Interfaces:**
- Consumes: `NormalizedSkillMatch`, `EarnerSkillRollup` from `@/lib/skills/types`
- Produces:
  ```ts
  export function rollUpEarnerSkills(
    matchesByCredential: NormalizedSkillMatch[][]
  ): EarnerSkillRollup[];
  ```
  Aggregates across all of an earner's credentials: `sourceCount` = number of credentials contributing a matched (non-null `skillId`) match for that skill; `highestConfidence` = max confidence across those matches. Unmatched (`skillId:null`) matches are dropped. Full recompute from scratch (not additive) so a deleted credential's contribution disappears on the next roll-up. Output is deterministically ordered by `skillId`.

- [ ] **Step 1: Write the failing tests `lib/skills/rollup.test.ts`**

```ts
import { expect, test } from "vitest";
import { rollUpEarnerSkills } from "./rollup";
import type { NormalizedSkillMatch } from "@/lib/skills/types";

function match(skillId: string | null, confidence: number): NormalizedSkillMatch {
  return {
    candidate: "x",
    skillId,
    confidence,
    method: skillId ? "exact" : "unmatched",
  };
}

test("aggregates the same skill across credentials: count + max confidence", () => {
  const out = rollUpEarnerSkills([
    [match("s1", 0.6)],
    [match("s1", 0.9)],
  ]);
  expect(out).toEqual([{ skillId: "s1", sourceCount: 2, highestConfidence: 0.9 }]);
});

test("drops unmatched (null skillId) matches", () => {
  const out = rollUpEarnerSkills([[match(null, 0), match("s2", 0.8)]]);
  expect(out).toEqual([{ skillId: "s2", sourceCount: 1, highestConfidence: 0.8 }]);
});

test("counts a skill once per credential even if it appears twice within one credential", () => {
  const out = rollUpEarnerSkills([[match("s1", 0.5), match("s1", 0.7)]]);
  expect(out).toEqual([{ skillId: "s1", sourceCount: 1, highestConfidence: 0.7 }]);
});

test("empty input yields empty output; output is ordered by skillId", () => {
  expect(rollUpEarnerSkills([])).toEqual([]);
  const out = rollUpEarnerSkills([[match("s2", 0.5)], [match("s1", 0.5)]]);
  expect(out.map((r) => r.skillId)).toEqual(["s1", "s2"]);
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/skills/rollup.test.ts`
Expected: FAIL — `lib/skills/rollup.ts` does not exist.

- [ ] **Step 3: Write `lib/skills/rollup.ts`**

```ts
import type { EarnerSkillRollup, NormalizedSkillMatch } from "@/lib/skills/types";

/**
 * Aggregate per-credential normalized matches into the earner_skills profile.
 * source_count counts credentials contributing the skill (deduped within a credential);
 * highest_confidence is the max across all contributing matches. Pure recompute — no
 * accumulation on prior state, so it correctly reflects credential deletions.
 */
export function rollUpEarnerSkills(
  matchesByCredential: NormalizedSkillMatch[][]
): EarnerSkillRollup[] {
  const agg = new Map<string, { sourceCount: number; highestConfidence: number }>();

  for (const credentialMatches of matchesByCredential) {
    // Collapse to one entry per skill within this credential first.
    const perCredential = new Map<string, number>();
    for (const match of credentialMatches) {
      if (match.skillId === null) continue;
      const prev = perCredential.get(match.skillId) ?? 0;
      perCredential.set(match.skillId, Math.max(prev, match.confidence));
    }
    for (const [skillId, confidence] of perCredential) {
      const entry = agg.get(skillId) ?? { sourceCount: 0, highestConfidence: 0 };
      entry.sourceCount += 1;
      entry.highestConfidence = Math.max(entry.highestConfidence, confidence);
      agg.set(skillId, entry);
    }
  }

  return Array.from(agg.entries())
    .map(([skillId, v]) => ({
      skillId,
      sourceCount: v.sourceCount,
      highestConfidence: v.highestConfidence,
    }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/skills/rollup.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/skills/rollup.ts lib/skills/rollup.test.ts
git commit -m "feat: pure earner-skills roll-up aggregation"
```

---

### Task 6: Data layer (impure) — vocabulary read + credential-skill writes + recompute

**Files:**
- Create: `lib/skills/data.ts`
- Test: `tests/db/skills-rollup.test.ts` (hosted-DB integration)

**Interfaces:**
- Consumes: `CanonicalSkill`, `NormalizedSkillMatch` from `@/lib/skills/types`; `rollUpEarnerSkills` from `@/lib/skills/rollup`; `SupabaseClient` from `@supabase/supabase-js`; `adminClient()` from `@/tests/db/admin-client`; the `skills` / `credential_skills` / `earner_skills` tables from `0002_core_schema.sql`
- Produces:
  ```ts
  export async function getSkillVocabulary(db: SupabaseClient): Promise<CanonicalSkill[]>;
  export async function writeCredentialSkills(
    db: SupabaseClient,
    credentialId: string,
    matches: NormalizedSkillMatch[]
  ): Promise<void>;
  export async function recomputeEarnerSkills(
    db: SupabaseClient,
    earnerId: string
  ): Promise<{ skillCount: number }>;
  ```
  `getSkillVocabulary` returns every seeded skill with `aliases: []` (the alias source is the static table in `lib/skills/aliases.ts`, not a DB column). `writeCredentialSkills` deletes then inserts this credential's `credential_skills` rows (idempotent, drops unmatched). `recomputeEarnerSkills` re-derives `earner_skills` from all of the earner's `credential_skills` via `rollUpEarnerSkills`, delete-then-insert (idempotent; correctly handles credential deletion). Mirrors `provisionEarner(db, ...)`'s DI shape.

- [ ] **Step 1: Write `lib/skills/data.ts`**

> **Vocabulary size bound.** `getSkillVocabulary` does a single unbounded `select`, and PostgREST caps a
> single response at 1000 rows by default. The v1 seed (Task 2) is deliberately kept well under 1000 rows,
> so this is safe today. `.range(0, 9999)` is set explicitly below so the bound is a deliberate decision
> rather than a silent default; if the vocabulary is ever grown past ~10k rows, switch this to keyset
> pagination (TODO in the code) before growth or normalization will silently receive a truncated vocabulary.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CanonicalSkill,
  NormalizedSkillMatch,
} from "@/lib/skills/types";
import { rollUpEarnerSkills } from "@/lib/skills/rollup";

/** Load the seeded canonical vocabulary. Aliases come from the static table, not the DB. */
export async function getSkillVocabulary(
  db: SupabaseClient
): Promise<CanonicalSkill[]> {
  // .range makes the row bound explicit (PostgREST defaults to 1000). v1 vocabulary is well
  // under this; TODO: switch to keyset pagination before growing the vocabulary past ~10k rows.
  const { data, error } = await db
    .from("skills")
    .select("id, canonical_name, type, onet_id")
    .range(0, 9999);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    canonical_name: row.canonical_name as string,
    type: row.type as CanonicalSkill["type"],
    onet_id: (row.onet_id as string | null) ?? null,
    aliases: [],
  }));
}

/** Replace this credential's credential_skills with the matched (non-null) skills. */
export async function writeCredentialSkills(
  db: SupabaseClient,
  credentialId: string,
  matches: NormalizedSkillMatch[]
): Promise<void> {
  const { error: delErr } = await db
    .from("credential_skills")
    .delete()
    .eq("credential_id", credentialId);
  if (delErr) throw delErr;

  // Collapse to one row per skill (highest confidence wins) and drop unmatched.
  const bySkill = new Map<string, number>();
  for (const m of matches) {
    if (m.skillId === null) continue;
    bySkill.set(m.skillId, Math.max(bySkill.get(m.skillId) ?? 0, m.confidence));
  }
  if (bySkill.size === 0) return;

  const rows = Array.from(bySkill.entries()).map(([skill_id, confidence]) => ({
    credential_id: credentialId,
    skill_id: skill_id,
    confidence,
  }));
  const { error: insErr } = await db.from("credential_skills").insert(rows);
  if (insErr) throw insErr;
}

/**
 * Re-derive earner_skills from all of the earner's credential_skills. Idempotent
 * delete-then-insert; must be called after any mutation of credential_skills for the earner.
 */
export async function recomputeEarnerSkills(
  db: SupabaseClient,
  earnerId: string
): Promise<{ skillCount: number }> {
  // Select credential_id so we can group rows by credential (required for correct
  // source_count math — rollUpEarnerSkills dedupes within a credential and counts
  // one source per contributing credential). The !inner join filters to this earner.
  const { data: rows, error: readErr } = await db
    .from("credential_skills")
    .select("credential_id, skill_id, confidence, credentials!inner(earner_id)")
    .eq("credentials.earner_id", earnerId);
  if (readErr) throw readErr;

  // Build one match-list per credential to feed rollUpEarnerSkills faithfully.
  const byCredential = new Map<string, NormalizedSkillMatch[]>();
  for (const row of rows ?? []) {
    const credId = row.credential_id as string;
    const list = byCredential.get(credId) ?? [];
    list.push({
      candidate: "",
      skillId: row.skill_id as string,
      confidence: row.confidence as number,
      method: "exact",
    });
    byCredential.set(credId, list);
  }

  const rollups = rollUpEarnerSkills(Array.from(byCredential.values()));

  const { error: delErr } = await db
    .from("earner_skills")
    .delete()
    .eq("earner_id", earnerId);
  if (delErr) throw delErr;

  if (rollups.length === 0) return { skillCount: 0 };

  const upsertRows = rollups.map((r) => ({
    earner_id: earnerId,
    skill_id: r.skillId,
    source_count: r.sourceCount,
    highest_confidence: r.highestConfidence,
  }));
  const { error: insErr } = await db.from("earner_skills").insert(upsertRows);
  if (insErr) throw insErr;

  return { skillCount: upsertRows.length };
}
```

- [ ] **Step 2: Write the failing integration test `tests/db/skills-rollup.test.ts`**

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import {
  writeCredentialSkills,
  recomputeEarnerSkills,
  getSkillVocabulary,
} from "@/lib/skills/data";
import type { NormalizedSkillMatch } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

async function seedEarnerWithCredential() {
  const email = `roll-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `h${Date.now()}${Math.floor(Math.random() * 1000)}` });
  const { data: cred } = await admin
    .from("credentials")
    .insert({ earner_id: earnerId, source: "manual", title: "Test Cred" })
    .select("id")
    .single();
  return { earnerId, credentialId: cred!.id as string };
}

async function twoSeededSkillIds(): Promise<[string, string]> {
  const vocab = await getSkillVocabulary(admin);
  expect(vocab.length).toBeGreaterThanOrEqual(2);
  return [vocab[0].id, vocab[1].id];
}

function match(skillId: string, confidence: number): NormalizedSkillMatch {
  return { candidate: "x", skillId, confidence, method: "exact" };
}

test("recompute aggregates source_count and highest_confidence", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  // Two matches for the same skill in one credential -> collapses to one row (max conf).
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.6), match(s1, 0.9)]);
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(1);
  const { data } = await admin
    .from("earner_skills")
    .select("skill_id, source_count, highest_confidence")
    .eq("earner_id", earnerId);
  expect(data).toHaveLength(1);
  expect(data![0].source_count).toBe(1);
  expect(data![0].highest_confidence).toBeCloseTo(0.9);
});

test("recompute is idempotent across repeated calls", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.7)]);
  await recomputeEarnerSkills(admin, earnerId);
  await recomputeEarnerSkills(admin, earnerId);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", earnerId);
  expect(data).toHaveLength(1);
});

test("recompute after credential deletion removes the skill", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.8)]);
  await recomputeEarnerSkills(admin, earnerId);
  await admin.from("credentials").delete().eq("id", credentialId); // cascades credential_skills
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(0);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", earnerId);
  expect(data).toEqual([]);
});

test("no credential_skills -> skillCount 0, no rows", async () => {
  const { earnerId } = await seedEarnerWithCredential();
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(0);
});

test("earner A recompute never writes earner B rows", async () => {
  const a = await seedEarnerWithCredential();
  const b = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, a.credentialId, [match(s1, 0.9)]);
  await recomputeEarnerSkills(admin, a.earnerId);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", b.earnerId);
  expect(data).toEqual([]);
});
```

- [ ] **Step 3: Run the integration test (expected PASS — requires seeded vocabulary from Task 2 and reachable hosted Supabase)**

Run: `npm test -- tests/db/skills-rollup.test.ts`
Expected: 5 passed. (If `twoSeededSkillIds` fails on `vocab.length >= 2`, run `node scripts/seed-onet.mjs` first — the seed from Task 2 must have run.)

> **Test-helper import convention (deliberate split):** `tests/db/skills-rollup.test.ts` lives in
> `tests/db/`, so it imports the helper via the relative `./admin-client` — matching the existing repo
> tests (`tests/db/rls.test.ts`, `tests/db/schema.test.ts`). Colocated `lib/skills/*` tests that need the
> helper import it via the `@/tests/db/admin-client` alias instead (see Task 8's `lib/skills/index.test.ts`).
> Both resolve to the same module; the form differs by the test file's location.

- [ ] **Step 4: Commit**

```bash
git add lib/skills/data.ts tests/db/skills-rollup.test.ts
git commit -m "feat: skills data layer (vocabulary read, credential-skill writes, earner recompute)"
```

---

### Task 7: LLM adapter (impure) — Claude Sonnet 4.6 with content-hash cache

**Files:**
- Create: `lib/skills/llm.ts`, `lib/skills/llm.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `SkillExtractionCache`, `RawSkillMention` from `@/lib/skills/types`; `@anthropic-ai/sdk`
- Produces:
  ```ts
  export class InMemorySkillCache implements SkillExtractionCache { /* Map-backed */ }
  export function createAnthropicLlmClient(opts?: {
    apiKey?: string;
    cache?: SkillExtractionCache;
    client?: AnthropicLike; // injectable for tests; defaults to a real Anthropic instance
  }): LlmClient;
  // Exported for tests:
  export function cacheKey(input: { title: string; description: string }): string;
  export function clampMentions(mentions: RawSkillMention[]): RawSkillMention[];
  export interface AnthropicLike {
    messages: { create(args: unknown): Promise<{ content: Array<{ type: string } & Record<string, unknown>> }> };
  }
  ```
  The real client calls model `claude-sonnet-4-6`, non-streaming, `max_tokens: 300`, forcing a JSON tool-use response `{ skills: [{ name, type }] }`; checks the cache before any model call and writes it after a miss; clamps every returned confidence to `<= 0.7` and tags `source:"llm"`. The prompt payload contains only `title` + `description`, never `raw_json`. This is the only file in `lib/skills/` that imports the Anthropic SDK.

- [ ] **Step 1: Write the failing tests `lib/skills/llm.test.ts`**

```ts
import { expect, test, vi } from "vitest";
import {
  createAnthropicLlmClient,
  InMemorySkillCache,
  cacheKey,
  clampMentions,
  type AnthropicLike,
} from "./llm";
import type { RawSkillMention } from "@/lib/skills/types";

// A fake Anthropic client returning a tool-use JSON block.
function fakeAnthropic(skills: Array<{ name: string; type: string }>): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          { type: "tool_use", name: "record_skills", input: { skills } },
        ],
      })),
    },
  };
}

test("clampMentions caps confidence at 0.7 and tags source llm", () => {
  const raw: RawSkillMention[] = [
    { rawName: "Leadership", type: "skill", confidence: 0.95, source: "structured" },
  ];
  expect(clampMentions(raw)).toEqual([
    { rawName: "Leadership", type: "skill", confidence: 0.7, source: "llm" },
  ]);
});

test("cacheKey is stable for identical text and differs for different text", () => {
  const a = cacheKey({ title: "T", description: "D" });
  const b = cacheKey({ title: "T", description: "D" });
  const c = cacheKey({ title: "T", description: "different" });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("client checks cache before calling the model, and caches after a miss", async () => {
  const cache = new InMemorySkillCache();
  const anthropic = fakeAnthropic([{ name: "SQL", type: "skill" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache, client: anthropic });

  const first = await llm.extractSkills({ title: "DB Cert", description: "SQL work" });
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(first[0]).toMatchObject({ rawName: "SQL", source: "llm" });
  expect(first[0].confidence).toBeLessThanOrEqual(0.7);

  const second = await llm.extractSkills({ title: "DB Cert", description: "SQL work" });
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1); // cache hit — no second call
  expect(second).toEqual(first);
});

test("the model payload contains only title/description text, never raw_json", async () => {
  const anthropic = fakeAnthropic([{ name: "X", type: "skill" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache: new InMemorySkillCache(), client: anthropic });
  await llm.extractSkills({ title: "Some Title", description: "Some Description" });
  const arg = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const serialized = JSON.stringify(arg);
  expect(serialized).toContain("Some Title");
  expect(serialized).toContain("Some Description");
  expect(serialized).not.toContain("raw_json");
  expect(arg.model).toBe("claude-sonnet-4-6");
});

test("unknown skill type from the model falls back to 'skill'", async () => {
  const anthropic = fakeAnthropic([{ name: "Y", type: "bogus" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache: new InMemorySkillCache(), client: anthropic });
  const out = await llm.extractSkills({ title: "t", description: "d" });
  expect(out[0].type).toBe("skill");
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/skills/llm.test.ts`
Expected: FAIL — `lib/skills/llm.ts` does not exist.

- [ ] **Step 3: Write `lib/skills/llm.ts`**

```ts
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmClient,
  RawSkillMention,
  SkillExtractionCache,
  SkillType,
} from "@/lib/skills/types";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 300;
const LLM_CONFIDENCE = 0.7;

/** Minimal shape of the Anthropic client we depend on (injectable for tests). */
export interface AnthropicLike {
  messages: {
    create(args: unknown): Promise<{
      content: Array<{ type: string } & Record<string, unknown>>;
    }>;
  };
}

export class InMemorySkillCache implements SkillExtractionCache {
  private store = new Map<string, RawSkillMention[]>();
  async get(key: string): Promise<RawSkillMention[] | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async set(key: string, value: RawSkillMention[]): Promise<void> {
    this.store.set(key, value);
  }
}

export function cacheKey(input: { title: string; description: string }): string {
  return createHash("sha256")
    .update(`${input.title} ${input.description}`)
    .digest("hex");
}

function toSkillType(t: unknown): SkillType {
  return t === "competency" || t === "occupation" ? t : "skill";
}

/** Cap confidence at the LLM ceiling and tag source. */
export function clampMentions(mentions: RawSkillMention[]): RawSkillMention[] {
  return mentions.map((m) => ({
    ...m,
    source: "llm" as const,
    confidence: Math.min(m.confidence, LLM_CONFIDENCE),
  }));
}

const SYSTEM_PROMPT =
  "You extract concrete, resume-relevant skills from a credential's title and description. " +
  "Return only skills a person could reasonably claim from earning this credential. " +
  "Do not invent skills that are not implied by the text.";

const SKILLS_TOOL = {
  name: "record_skills",
  description: "Record the skills extracted from the credential.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["skill", "competency", "occupation"] },
          },
          required: ["name", "type"],
        },
      },
    },
    required: ["skills"],
  },
} as const;

export function createAnthropicLlmClient(opts?: {
  apiKey?: string;
  cache?: SkillExtractionCache;
  client?: AnthropicLike;
}): LlmClient {
  const cache = opts?.cache ?? new InMemorySkillCache();
  const client: AnthropicLike =
    opts?.client ??
    (new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    }) as unknown as AnthropicLike);

  return {
    async extractSkills(input) {
      const key = cacheKey(input);
      const cached = await cache.get(key);
      if (cached) return cached;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [SKILLS_TOOL],
        tool_choice: { type: "tool", name: "record_skills" },
        messages: [
          {
            role: "user",
            content:
              `Title: ${input.title}\nDescription: ${input.description}\n\n` +
              "Extract the skills using the record_skills tool.",
          },
        ],
      });

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      const rawSkills =
        (toolBlock?.input as { skills?: Array<{ name: string; type: string }> } | undefined)
          ?.skills ?? [];

      const mentions = clampMentions(
        rawSkills
          .filter((s) => typeof s.name === "string" && s.name.length > 0)
          .map((s) => ({
            rawName: s.name,
            type: toSkillType(s.type),
            confidence: LLM_CONFIDENCE,
            source: "llm" as const,
          }))
      );

      await cache.set(key, mentions);
      return mentions;
    },
  };
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/skills/llm.test.ts`
Expected: 5 passed. (No real Anthropic call — the fake client is injected.)

- [ ] **Step 5: Commit**

```bash
git add lib/skills/llm.ts lib/skills/llm.test.ts
git commit -m "feat: Claude Sonnet 4.6 skill-extraction adapter with content-hash cache"
```

---

### Task 8: Orchestrator + O\*NET seed-presence integration test

**Files:**
- Create: `lib/skills/index.ts`, `lib/skills/index.test.ts` (integration), `tests/db/onet-seed.test.ts` (integration)

**Interfaces:**
- Consumes: everything above — `extractSkills`/`ExtractDeps` from `@/lib/skills/extract`, `normalizeSkills` from `@/lib/skills/normalize`, `getSkillVocabulary`/`writeCredentialSkills`/`recomputeEarnerSkills` from `@/lib/skills/data`, `LlmClient`/`StoredCredential` from `@/lib/skills/types`; `SupabaseClient`
- Produces:
  ```ts
  export async function processCredential(
    db: SupabaseClient,
    llm: LlmClient,
    credentialId: string
  ): Promise<{ skillCount: number }>;
  ```
  Loads the credential row (id, title, raw_json; `description` derived from `raw_json` when present, else `""`), runs extract → normalize (against `getSkillVocabulary`) → `writeCredentialSkills` → `recomputeEarnerSkills`, and returns the earner's rolled-up skill count. This is the single entry point Plan 3's import route/action calls after inserting a credential. It is the ONLY function in `lib/skills/` needing an integration test (everything upstream is unit-tested).

- [ ] **Step 1: Write `lib/skills/index.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmClient, StoredCredential } from "@/lib/skills/types";
import { extractSkills } from "@/lib/skills/extract";
import { normalizeSkills } from "@/lib/skills/normalize";
import {
  getSkillVocabulary,
  writeCredentialSkills,
  recomputeEarnerSkills,
} from "@/lib/skills/data";

/** Derive a description string from a credential's raw_json (OB description field), else "". */
function descriptionFrom(rawJson: unknown): string {
  if (typeof rawJson !== "object" || rawJson === null) return "";
  const root = rawJson as Record<string, unknown>;
  const direct = root.description;
  if (typeof direct === "string") return direct;
  const badge = root.badge as Record<string, unknown> | undefined;
  if (badge && typeof badge.description === "string") return badge.description;
  return "";
}

/**
 * The skills engine's single entry point. Runs when a credential is added/changed
 * (called by Plan 3's import flow). Pipeline: extract -> normalize -> write credential_skills
 * -> recompute earner_skills. Returns the earner's rolled-up skill count.
 */
export async function processCredential(
  db: SupabaseClient,
  llm: LlmClient,
  credentialId: string
): Promise<{ skillCount: number }> {
  const { data: cred, error } = await db
    .from("credentials")
    .select("id, earner_id, title, raw_json")
    .eq("id", credentialId)
    .single();
  if (error) throw error;

  const stored: StoredCredential = {
    id: cred.id as string,
    title: (cred.title as string) ?? "",
    description: descriptionFrom(cred.raw_json),
    raw_json: cred.raw_json ?? null,
  };

  const { mentions } = await extractSkills(stored, { llm });
  const vocabulary = await getSkillVocabulary(db);
  const matches = normalizeSkills(mentions, vocabulary);

  await writeCredentialSkills(db, credentialId, matches);
  return recomputeEarnerSkills(db, cred.earner_id as string);
}
```

- [ ] **Step 2: Write the failing O\*NET seed-presence test `tests/db/onet-seed.test.ts`**

```ts
import { expect, test } from "vitest";
import { adminClient } from "./admin-client";

const admin = adminClient();

test("O*NET vocabulary is seeded (run scripts/seed-onet.mjs first)", async () => {
  const { count, error } = await admin
    .from("skills")
    .select("id", { count: "exact", head: true });
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(50);
});

test("a known O*NET skill element is present with its element id", async () => {
  const { data } = await admin
    .from("skills")
    .select("canonical_name, type, onet_id")
    .eq("onet_id", "2.A.1.a")
    .maybeSingle();
  // 2.A.1.a is O*NET's "Reading Comprehension" skill element.
  expect(data?.type).toBe("skill");
  expect(data?.canonical_name).toBe("Reading Comprehension");
});
```

- [ ] **Step 3: Run the seed-presence test (expected PASS if Task 2 seed ran)**

Run: `npm test -- tests/db/onet-seed.test.ts`
Expected: 2 passed. If it fails, run `node scripts/seed-onet.mjs` (Task 2, Step 11) and re-run. If the second assertion fails because the real O\*NET element id/name differs from the release you seeded, correct the expected pair to a value actually present in your seed (verify with `select canonical_name from skills where type='skill' order by canonical_name`).

- [ ] **Step 4: Write the failing orchestrator integration test `lib/skills/index.test.ts`**

```ts
import { afterAll, expect, test, vi } from "vitest";
import { adminClient } from "@/tests/db/admin-client";
import { processCredential } from "./index";
import { getSkillVocabulary } from "@/lib/skills/data";
import type { LlmClient } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("processCredential: structured credential resolves skills without calling the LLM", async () => {
  // Pick a real seeded skill to align to, so normalize produces an exact match.
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill");
  expect(target).toBeDefined();

  const email = `idx-${Date.now()}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `idx${Date.now()}` });

  const { data: cred } = await admin
    .from("credentials")
    .insert({
      earner_id: earnerId,
      source: "ob_url",
      title: "Aligned Badge",
      raw_json: {
        type: "BadgeClass",
        alignment: [{ targetName: target!.canonical_name, targetUrl: "https://x/a" }],
      },
    })
    .select("id")
    .single();

  const throwingLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called for structured credentials");
    }),
  };

  const { skillCount } = await processCredential(admin, throwingLlm, cred!.id as string);
  expect(skillCount).toBe(1);
  expect(throwingLlm.extractSkills).not.toHaveBeenCalled();

  const { data: es } = await admin
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  expect(es![0].skill_id).toBe(target!.id);
});

test("processCredential: text-only credential uses the injected fake LLM", async () => {
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill");

  const email = `idx2-${Date.now()}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `idx2${Date.now()}` });

  const { data: cred } = await admin
    .from("credentials")
    .insert({ earner_id: earnerId, source: "manual", title: "Paper Certificate", raw_json: null })
    .select("id")
    .single();

  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => [
      { rawName: target!.canonical_name, type: "skill" as const, confidence: 0.7, source: "llm" as const },
    ]),
  };

  const { skillCount } = await processCredential(admin, fakeLlm, cred!.id as string);
  expect(fakeLlm.extractSkills).toHaveBeenCalledTimes(1);
  expect(skillCount).toBe(1);
});
```

- [ ] **Step 5: Run the orchestrator integration test (expected PASS)**

Run: `npm test -- lib/skills/index.test.ts`
Expected: 2 passed (requires seeded vocabulary + reachable hosted Supabase; no real LLM call — the fake is injected).

- [ ] **Step 6: Full suite + typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all Plan 1 + Plan 2 tests pass (page, button, badge, schema, rls, provision-earner, onet-parse, extract, normalize, rollup, llm, skills-rollup, onet-seed, index).

- [ ] **Step 7: Commit**

```bash
git add lib/skills/index.ts lib/skills/index.test.ts tests/db/onet-seed.test.ts
git commit -m "feat: skills-engine orchestrator (processCredential) and seed-presence tests"
```

---

## Self-Review

**Spec coverage (Plan 2 scope = design doc §4 skills engine + §9 subsystem 2, and the locked decisions passed to this plan):**
- §4 step 1 **Extract** — structured OB2.x/OB3.0/CLR/VC + Claude Sonnet fallback → Task 3 (structured, pure) + Task 7 (LLM adapter, `claude-sonnet-4-6`) ✅
- §4 step 2 **Normalize** — O\*NET-seeded canonical vocabulary + deterministic matcher → Task 2 (seed) + Task 4 (exact/alias/trigram, pure, **in-process**) ✅. `0004_pg_trgm.sql` is provisioned as forward-looking infrastructure for a future DB-backed fuzzy fallback and is **not queried by any Plan 2 code or test** (called out honestly in the File Structure, Architecture, and migration comment) — flagged, not silently implied to be wired up. ⚠️ speculative
- §4 step 3 **Roll up** — `earner_skills` recompute when credentials change → Task 5 (pure math) + Task 6 (`recomputeEarnerSkills`, app-service, idempotent, handles deletion) ✅
- §10 O\*NET subset scope "tied to the first pilot sponsor's population" → Task 2 `V1_OCCUPATION_PREFIXES` (SOC groups 11/13/15/29/31/33/47/49/51), all ~35 O\*NET Skills, Hot-Tech competencies. ⚠️ **OPEN ASSUMPTION, not validated:** no pilot sponsor exists yet, so the prefix list is an explicit provisional placeholder with a `TODO(pilot-onboarding)` in code requiring product sign-off once the first sponsor's population is known. Row-count is release-dependent and deliberately NOT given a fixed pass/fail number (see Task 2 Step 11).
- Locked decisions honored: O\*NET-seeded normalization (option a) ✅; `claude-sonnet-4-6` for LLM extraction ✅; server-side only (LLM behind `lib/skills/llm.ts`, no `NEXT_PUBLIC_` key) ✅; cost-conscious (structured-first short-circuit, title+description-only prompt, `max_tokens:300`, one call/credential, content-hash cache, free tiers resolve most strings) ✅
- Module architecture with DI → Task 1 (types) + strict pure-core (`extract`/`normalize`/`rollup`/`onet-parse`) vs impure-shell (`data`/`llm`/`index`), every impure fn takes `db`/`llm` injected, mirroring `provisionEarner(db, ...)` ✅
- Test strategy → pure unit tests colocated & hermetic (onet-parse, extract, normalize, rollup, llm); hosted-DB integration via `tests/db/admin-client.ts` (skills-rollup, onet-seed, index) with `afterAll` deleteUser cleanup; **no test hits the real Anthropic API or onetcenter.org** ✅
- *Correctly deferred:* Tier-3 LLM tie-break for ambiguous normalization leftovers is out of scope for the v1 engine (kept `normalizeSkills` pure/synchronous); the vocabulary is a closed, deliberately-grown set (no auto-creation of `skills` from LLM output). Consuming Plan 3 (import flow calls `processCredential`) and Plan 5 (advisor reads `earner_skills`) are downstream. ✅

**Placeholder scan:** No "similar to Task N"/"add error handling"/elided-body placeholders left in code. Every code step shows complete, final code. Task 6 now writes `lib/skills/data.ts` **once, correctly** — the earlier two-step version (a deliberately-broken Step 1 fixed by Step 2, which risked a subagent shipping the broken `?? skillId` grouping) has been collapsed into a single correct `recomputeEarnerSkills` selecting `credential_id`. The only intentional `TODO`s that remain are genuine deferred-decision markers, called out as such: `TODO(pilot-onboarding)` on `V1_OCCUPATION_PREFIXES` (open §10 assumption) and the keyset-pagination TODO in `getSkillVocabulary` (bounded via `.range(0, 9999)`, vocabulary kept well under 1000 rows for v1). Every test step states the exact command and expected pass/fail count. ✅

**Type consistency (verified across all tasks):**
- The type set is defined once in `lib/skills/types.ts` (Task 1) and imported via `@/lib/skills/types` everywhere. Renamed the two decisions' divergent `CandidateSkill`/`RawSkillMention` into a single `RawSkillMention` and unified `ExtractResult` to `{ mentions, method }` (used identically in Task 3's `extractSkills`, Task 7's `LlmClient`, and Task 8's orchestrator). ✅
- `LlmClient.extractSkills({ title, description }): Promise<RawSkillMention[]>` is identical in `types.ts`, `extract.ts` (consumer), `llm.ts` (producer), and both integration tests' fakes. ✅
- `NormalizedSkillMatch { candidate, skillId, confidence, method }` produced by `normalizeSkills` (Task 4) is exactly what `writeCredentialSkills` and the rollup consume (Tasks 5, 6). `EarnerSkillRollup { skillId, sourceCount, highestConfidence }` maps onto `earner_skills(skill_id, source_count, highest_confidence)`. ✅
- Table/column names match `0002_core_schema.sql` verbatim: `skills(id, canonical_name, type, onet_id)`, `credential_skills(credential_id, skill_id, confidence)`, `earner_skills(earner_id, skill_id, source_count, highest_confidence)`, `credentials(id, earner_id, title, raw_json, source)`. `skills.type` values (`skill`/`competency`/`occupation`) match the `skill_type` enum. ✅
- `recomputeEarnerSkills` returns `{ skillCount }` consistently in `data.ts`, its test, and `processCredential`'s return. ✅

**Known environmental dependencies:** Tasks 2, 6, 8's integration tests require the hosted Supabase project reachable and `.env.local` populated (URL + service-role key), plus the O\*NET seed having run (`node scripts/seed-onet.mjs`, which itself requires the three gitignored `.txt` files under `scripts/onet-data/`). `0004_pg_trgm.sql` is applied via the Management API exactly like Plan 1's migrations. No test requires `ANTHROPIC_API_KEY` — the real Anthropic call in `createAnthropicLlmClient` is never exercised in the suite (fakes injected everywhere), keeping CI at zero LLM spend.
