# Trove AI Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Trove **AI advisor** (Plan 5) — the flagship, skills-grounded chat that helps an adult learner see *jobs I qualify for*, *what to learn next*, and *how to get there*. Per message, Trove assembles context (the earner's rolled-up `earner_skills`, their verified/unverified `credentials`, an optional durable **target occupation**, and trimmed thread history), computes **skill-gap math ("you have X of Y skills for occupation Z") entirely in code** — never in the model — then calls Claude Sonnet with a scoped, safety-framed system prompt, optionally letting Anthropic's native web-search tool fire only for time-sensitive/external questions. Both the user turn and the assistant reply persist to `advisor_messages` with `token_cost`. A per-earner **daily message cap** is enforced server-side *before* any paid call, so an over-cap request costs zero tokens. Every LLM and web-search touch is a dependency-injected boundary that is faked in tests — **no test ever calls the real Anthropic API or a real web-search endpoint**.

**Architecture:** A strict **pure-core / impure-shell** split under `lib/advisor/`, mirroring `lib/skills/`'s conventions exactly (DI'd `SupabaseClient` first argument like Plan 2's `data.ts`; a DI'd `AdvisorLlm` boundary like Plan 2's `LlmClient`; `@/` import alias; Vitest; `tests/db/*` helpers for hosted-DB integration). The advisor subsystem has **pure modules** (`gaps.ts` = set arithmetic over requirement rows → `{have, missing, coveragePct}`; `prompt.ts` = context struct → system + context-block strings; `route-topic.ts` = message → `webSearchEnabled` boolean; `history.ts` = tail-window trim), **impure data loaders** (`context.ts` reads `earner_skills`/`credentials`/`occupation_skills`; `cap.ts` counts today's messages), one **impure LLM adapter** (`llm.ts`, the ONLY advisor module importing `@anthropic-ai/sdk`, following `lib/skills/llm.ts`'s `AnthropicLike` injection pattern), and one **impure orchestrator** (`orchestrate.ts` → `runAdvisorTurn(db, llm, input)`) that the Server Actions (`app/app/advisor/actions.ts`) call. Closing the CRITICAL DATA GAP requires one migration (`0006_advisor.sql`: the `occupation_skills` relation + a `target_occupation_skill_id` column on `earners`) plus a `scripts/seed-onet.mjs` extension that parses the occupation×skill×importance rows from whichever Skills source files are present (the legacy unified `Skills.txt` OR the 30.3 split `Essential Skills.txt` + `Transferable Skills.txt`, which are the ones downloaded in this repo). The UI is a Server-Component thread list + a Client-Component chat island (`components/advisor/*`), reusing Plan 1's `Button` / `VerificationBadge` and its WCAG-AA, mobile-first conventions.

**Tech Stack:** TypeScript, `@supabase/supabase-js` + `@supabase/ssr` (already installed), `@anthropic-ai/sdk` (installed in Plan 2 — reused, no new model dep), React 19 + Next.js 16 (Server Actions, Server Components), Vitest + `@testing-library/react` for unit/component/integration tests. **No new runtime dependencies** — the advisor reuses the exact `@anthropic-ai/sdk` client convention from `lib/skills/llm.ts` and adds only in-repo pure modules. The O*NET parser extension hand-rolls its tab parse via the existing `parseTable` idiom in `lib/skills/onet-parse.ts`.

## Global Constraints

Every task's requirements implicitly include these (binding, from the design doc §6/§8/§9 and Plans 1–4):

- **Product name:** Trove. Domain: trove.io.
- **Stack (do not substitute):** Next.js + Supabase (Postgres/RLS/Auth/Storage) + Vercel + Stripe + Postmark + **Claude Sonnet 4.6**. Model id for all AI work: `claude-sonnet-4-6`, reached ONLY through the advisor's own adapter `lib/advisor/llm.ts` (which mirrors `lib/skills/llm.ts`'s `createAnthropicLlmClient` shape and pins the identical model literal). No Opus anywhere in Plan 5. The advisor exports `ADVISOR_MODEL = "claude-sonnet-4-6"` so a future bump is a one-line diff.
- **AI is server-side only.** `ANTHROPIC_API_KEY` never reaches the client and is never referenced outside `lib/advisor/llm.ts` / `lib/skills/llm.ts`. All Anthropic calls originate from `"use server"` action code; no `NEXT_PUBLIC_` exposure of any key.
- **Gap math in code, NOT the model (design doc §6):** the "you have X of Y skills for occupation Z" computation is a pure, deterministic TypeScript function (`lib/advisor/gaps.ts`) over `earner_skills` + `occupation_skills` rows. The model is *never* asked to count, match, or reason about raw join rows — it only ever receives the already-computed `{haveCount, totalCount, missingSkillNames}` struct in the context block. Zero tokens spent on gap computation.
- **Per-earner daily message cap enforced server-side BEFORE any paid call:** `lib/advisor/cap.ts` counts the earner's `advisor_messages` where `role = 'user'` since the start of the current **`APP_TZ` day** (a named IANA-timezone constant, default `America/New_York`, NOT UTC — a UTC window resets mid-afternoon US-local and would let a user get ~cap messages before the reset and ~cap more after, ~doubling the intended daily spend) and rejects at `DAILY_MESSAGE_CAP` (a named constant, default 20). **Cap semantics:** the check runs BEFORE the orchestrator persists the in-flight user turn, so `sentToday` is exclusive of the current turn and `underCap = sentToday < cap` permits exactly `cap` successful user turns per APP_TZ day. `runAdvisorTurn` persists the user turn immediately after the cap check passes and **before** `llm.reply`, so a paid call that errors after the model responds is still counted — a user whose calls keep failing cannot retry indefinitely while the counter never moves. An over-cap turn returns a friendly result and makes zero Anthropic/web-search calls — tests assert the fake LLM was never invoked on the capped path.
- **Web search only when external/time-sensitive (design doc §6.4):** a pure, deterministic `lib/advisor/route-topic.ts` decides `webSearchEnabled` in code via a **deliberately narrow** heuristic (openings/hiring/job listings, "near me"/"in my area", explicit recency like "this week"/"right now"/"latest", deadlines, or a pay question paired with a recency/location token). Bare `salary`/`pay`/`currently`/`today` do NOT trigger search — they fire on evergreen questions the model answers from context, and turning search on for those would waste a billable call. Anthropic's native `web_search` server tool is passed only when that boolean is true. Default is OFF; table-driven tests assert common salary/qualification questions stay OFF.
- **Trimmed history (cost control):** `lib/advisor/history.ts` hard-caps context to the last N=10 turns via a pure tail-window function. No second LLM call for summarization in v1 (avoids paying to shrink context). `max_tokens` on the chat call is a hard ceiling (1024).
- **`token_cost` recorded:** every persisted assistant `advisor_messages` row stores the `tokenCost` the adapter returns, enabling a later spend dashboard with no new migration (column already exists in `0002_core_schema.sql`).
- **NO real Anthropic / web-search in tests (non-negotiable):** the `AdvisorLlm` boundary is injected everywhere (unit, component, integration) with a hand-written fake (`{ reply: vi.fn().mockResolvedValue(...) }`), exactly as `lib/skills/*` tests inject a fake `LlmClient`. No test constructs `createAnthropicAdvisorLlmClient(` with ANY arguments, imports `@anthropic-ai/sdk`, calls `new Anthropic(`, or reads `process.env.ANTHROPIC_API_KEY`; the adapter's own test (`lib/advisor/llm.test.ts`, the single permitted SDK-adjacent file) injects a fake `AnthropicLike` and never the real key. `route-topic.ts`'s boolean is asserted directly — no test exercises a real `web_search` tool call. A broadened grep guard (Task 12 Step 5) enforces all of this. Any real-API smoke check lives in a manual, CI-excluded script, never in `vitest`.
- **Safety: guidance-not-a-guarantee + unverified-credential flagging (design doc §6):** the system prompt (built in code) frames all outcomes as guidance, never a guarantee, and instructs the model to explicitly flag when its answer leans on an **unverified** credential. Verified vs unverified is bucketed **in code** from the existing `credentials.verification_status` enum and handed to the model as two labeled lists — the model never interprets status strings itself. A persistent, non-dismissible UI disclaimer renders on every advisor page independent of model output.
- **Migrations:** applied to the hosted Supabase project via `node scripts/apply-migration.mjs <file>` (NOT `supabase db push`), numbered sequentially. The last committed migration is `0005_public_profile_rls.sql`; this plan adds exactly one, `supabase/migrations/0006_advisor.sql` (the `occupation_skills` relation + world-readable RLS, and `earners.target_occupation_skill_id`). The advisor conversation tables `advisor_threads` / `advisor_messages` already exist (`0002_core_schema.sql`) and are already owner-scoped by `advisor_threads_owner_all` / `advisor_messages_owner_all` (`0003_rls_policies.sql`) — **no new RLS policy is needed on those two tables.** `earners_self_update` (`0003`) already covers writing the new `earners` column with no column restriction.
- **No secrets in git.** `.env.local` is git-ignored and already populated (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`).
- **Reuse Plan 1–4, do not fork:** the chat UI reuses `components/ui/button.tsx` (`Button`, variants `primary`/`secondary`/`ghost`, 44×44px via `min-h-11 min-w-11`) and `components/verification-badge.tsx`'s semantic-color convention (`--color-verified`/`--color-unverified`/`--color-failed`, icon+text never color alone). Auth mirrors `app/app/wallet/actions.ts` (`"use server"`, `requireUserId()` from `lib/auth/require-user.ts`, `createServerClient()` from `lib/supabase/server.ts`, `revalidatePath`). Vocabulary loads via `getSkillVocabulary` from `lib/skills/data.ts` (already returns `type:'occupation'` rows). Skills profile is read from `earner_skills` (Plan 2's rolled-up output) — consumed unmodified.
- **Server Actions run under the earner's own session client** (`createServerClient()`, anon-key + cookies), NOT service-role. RLS is the enforcement layer; every advisor read/write naturally goes through the owner-scoped policies. Inserts always set `earner_id: userId` server-side (never trust a client value) — defense in depth. No service-role client in any request-serving path.
- **WCAG AA + mobile-first (non-negotiable):** 4.5:1 contrast, visible focus rings, full keyboard nav, 44×44px targets, real `<label>`s, `role="status"`/`aria-live="polite"` for the "Advisor is responding" announcement, `prefers-reduced-motion` (already handled in `app/globals.css`). The chat surface must excel at 375px (thread list collapses to a drawer below `md:`). Plain language (~6th–8th-grade reading level) in all UI copy, consistent with `components/empty-wallet-state.tsx`.
- **Vitest serial config unchanged:** `vitest.config.ts` runs `fileParallelism:false`, `pool:"forks"` (iCloud path constraint). Do not change it.
- **Mirror existing test patterns:** colocated `*.test.ts(x)` beside pure source (zero network/LLM/DB — inject `AdvisorLlm`/action stubs); hosted-DB integration tests under `tests/db/` use `adminClient()` (service-role, bypasses RLS for setup) or `makeUserClient()` (RLS-scoped session) from `tests/db/*`, cleaning up with `admin.auth.admin.deleteUser(id)` in `afterAll` (FK `on delete cascade` from `0002_core_schema.sql` removes dependent `credentials`/`credential_skills`/`earner_skills`/`advisor_threads`/`advisor_messages`). `occupation_skills` is seed data (not per-earner); integration tests insert their own occupation/skill fixtures via `adminClient()` and delete them in `afterAll`.

---

## File Structure

Files created/modified in this plan and their single responsibility:

- `supabase/migrations/0006_advisor.sql` — CREATE: the `occupation_skills` relation (occupation_id/skill_id FKs → `skills`, `importance real`) + world-readable RLS (`occupation_skills_read_all`), and `alter table earners add column target_occupation_skill_id uuid references skills(id) on delete set null` + its index. No new policy on `advisor_threads`/`advisor_messages` (already owner-scoped).
- `lib/skills/onet-parse.ts` — MODIFY: add pure `parseOccupationSkillImportance(text, allowlist): OccupationSkillRow[]` + exported `MIN_IMPORTANCE` + `interface OccupationSkillRow`. No change to existing parsers (skills stay the ~35-element taxonomy).
- `lib/skills/onet-parse.test.ts` — MODIFY: add cases for `parseOccupationSkillImportance` (IM-only, importance threshold, allowlist, CRLF).
- `scripts/seed-onet.mjs` — MODIFY: after upserting `skills`, re-select `skills(id, onet_id)`, build an `onet_id → id` map, parse the occupation×skill importance rows from whichever Skills source files exist (legacy unified `Skills.txt` OR the 30.3 split `Essential Skills.txt` + `Transferable Skills.txt` — both carry the same columns), map through the id lookup (dropping any skill element not in the seeded vocabulary), hard-fail if the resulting relation is near-empty (< 1000 rows), and batch-upsert into `occupation_skills`.
- `lib/advisor/types.ts` — CREATE: all shared Plan-5 types; the ONLY module every other `lib/advisor/*` file may import from; zero SDK imports.
- `lib/advisor/gaps.ts` — CREATE: pure `computeOccupationGaps` + `rankOccupationCandidates` (set arithmetic; the "X of Y skills" gap math in code).
- `lib/advisor/gaps.test.ts` — CREATE: pure unit tests (in-memory fixtures; coverage %, minOverlap filter, determinism).
- `lib/advisor/context.ts` — CREATE: impure `loadAdvisorContext(db, earnerId, threadId)` — reads `earner_skills`, `credentials` (verified/unverified buckets), the target occupation's requirement rows, and trimmed thread history; runs gap math in code.
- `lib/advisor/prompt.ts` — CREATE: pure `SYSTEM_PROMPT` string + `buildContextBlock(ctx): string` (labeled verified/unverified lists, skills, gap struct, target occupation).
- `lib/advisor/prompt.test.ts` — CREATE: pure unit tests (guidance-not-guarantee present; unverified bucket labeled; gap line omitted when unavailable; never leaks `raw_json`).
- `lib/advisor/route-topic.ts` — CREATE: pure `shouldUseWebSearch(userMessage): boolean`.
- `lib/advisor/route-topic.test.ts` — CREATE: table-driven pure tests.
- `lib/advisor/history.ts` — CREATE: pure `trimHistory(messages, maxTurns): AdvisorTurn[]`.
- `lib/advisor/history.test.ts` — CREATE: pure tail-window tests.
- `lib/advisor/cap.ts` — CREATE: impure `DAILY_MESSAGE_CAP` + `APP_TZ` + `checkDailyMessageCap(db, earnerId, cap): Promise<{ underCap; sentToday; retryAt }>`; the daily window is anchored to `APP_TZ` (not UTC) so the cap can't be doubled across the local-day boundary.
- `lib/advisor/cap.test.ts` — CREATE: pure window-boundary + cap-arithmetic tests (23:59 vs 00:01 local land in the correct APP_TZ day; `underCap` semantics; injected fake `db`, zero network).
- `lib/advisor/llm.ts` — CREATE: impure adapter — `interface AnthropicLike`, `ADVISOR_MODEL`, `createAnthropicAdvisorLlmClient(opts?)` returning an `AdvisorLlm`; the ONLY advisor module importing `@anthropic-ai/sdk`; passes the `web_search` tool only when `webSearchEnabled`.
- `lib/advisor/llm.test.ts` — CREATE: injected-`AnthropicLike` tests (model pin, `max_tokens`, tool present only when web search on, token_cost mapping).
- `lib/advisor/orchestrate.ts` — CREATE: impure `runAdvisorTurn(db, llm, input)` — cap check → context load → topic route → prompt build → `llm.reply` → persist user+assistant rows with `token_cost` → return.
- `lib/advisor/orchestrate.test.ts` — CREATE: fake-DB + fake-LLM unit tests (happy path persists 2 rows; empty message short-circuits; rate-limited never calls LLM; history trimmed to 10).
- `app/app/advisor/actions.ts` — CREATE: Server Actions (`"use server"`) — `sendAdvisorMessage`, `createAdvisorThread`, `listAdvisorThreads`, `getAdvisorThread`, `setTargetOccupation`.
- `app/app/advisor/page.tsx` — CREATE: Server Component — loads thread list + target occupation + occupation vocabulary → renders the advisor shell.
- `app/app/advisor/[threadId]/page.tsx` — CREATE: Server Component — loads one thread's messages (RLS-scoped) → renders `<ChatPane>`.
- `app/app/advisor/loading.tsx` — CREATE: skeleton for the advisor RSC data-fetch suspense boundary.
- `components/advisor/thread-list.tsx` — CREATE: Server Component thread list + "New conversation" CTA (`Button`), drawer-collapsing below `md:`.
- `components/advisor/target-occupation-select.tsx` — CREATE: Client `<select>` bound to `setTargetOccupation`; "None set" default.
- `components/advisor/chat-pane.tsx` — CREATE: Client island — message list + composer; calls `sendAdvisorMessage`; `aria-live` pending region; renders occupation cards + disclaimer.
- `components/advisor/starter-prompts.tsx` — CREATE: Client — 3 starter-prompt chips shown when a thread is empty; submit via the same path as typing.
- `components/advisor/message-bubble.tsx` — CREATE: user vs assistant bubble (semantic roles).
- `components/advisor/occupation-card.tsx` — CREATE: renders one `OccupationGap` ("You have X of Y skills", missing-skill chips, unverified-reliance amber flag).
- `components/advisor/disclaimer-banner.tsx` — CREATE: persistent, non-dismissible guidance-not-guarantee banner.
- `components/advisor/chat-pane.test.tsx`, `components/advisor/starter-prompts.test.tsx`, `components/advisor/occupation-card.test.tsx`, `components/advisor/disclaimer-banner.test.tsx`, `components/advisor/thread-list.test.tsx`, `components/advisor/target-occupation-select.test.tsx` — CREATE: component tests (Testing Library, action stubs, zero network).
- `tests/db/onet-occupation-skills.test.ts` — CREATE: hosted-DB integration — `occupation_skills` has rows after seed; FK join to `skills` resolves; world-readable but not client-writable.
- `tests/db/advisor.test.ts` — CREATE: hosted-DB integration — `runAdvisorTurn` (fake LLM) persists owner-scoped thread/messages; a second earner cannot read them; `target_occupation_skill_id` FK + `on delete set null`; daily cap enforced on the real table.

---

### Task 1: Migration 0006 — `occupation_skills` relation + `earners.target_occupation_skill_id`

**Files:**
- Create: `supabase/migrations/0006_advisor.sql`

**Interfaces:**
- Consumes: nothing (schema foundation for Plan 5).
- Produces (SQL surface every later task depends on):
  ```sql
  -- occupation_skills(occupation_id uuid fk->skills, skill_id uuid fk->skills, importance real, pk(occupation_id, skill_id))
  -- policy occupation_skills_read_all for select using (true)
  -- earners.target_occupation_skill_id uuid references skills(id) on delete set null
  ```

- [ ] **Step 1: Write `supabase/migrations/0006_advisor.sql`**

```sql
-- Plan 5 (AI advisor) schema.
-- 1) occupation_skills: the O*NET occupation -> required-skill relation that closes the
--    CRITICAL DATA GAP (Plan 2 seeded occupations + skills as vocabulary ROWS but not the
--    per-occupation requirement relation the gap math needs). Public vocabulary-derived data,
--    world-readable like `skills` — never earner data. Seeded by scripts/seed-onet.mjs.
-- 2) earners.target_occupation_skill_id: a durable per-earner "target role" the gap math keys off.
--    Covered by the existing earners_self_update policy (0003) — no new policy needed.
-- NOTE: advisor_threads / advisor_messages already exist (0002) and are already owner-scoped by
--    advisor_threads_owner_all / advisor_messages_owner_all (0003). No RLS change needed there.

create table occupation_skills (
  occupation_id uuid not null references skills (id) on delete cascade,
  skill_id uuid not null references skills (id) on delete cascade,
  importance real not null,
  primary key (occupation_id, skill_id)
);
create index occupation_skills_occupation_idx on occupation_skills (occupation_id);

alter table occupation_skills enable row level security;
create policy occupation_skills_read_all on occupation_skills for select using (true);

alter table earners
  add column target_occupation_skill_id uuid references skills (id) on delete set null;
create index earners_target_occupation_idx on earners (target_occupation_skill_id);
```

- [ ] **Step 2: Apply the migration to the hosted project**

Run: `node scripts/apply-migration.mjs supabase/migrations/0006_advisor.sql`
Expected: the script POSTs the SQL to the Management API and prints success. (Idempotent-ish: re-running errors on the already-existing table/column — that's fine, it confirms it applied. If re-application is needed, drop the objects first via a one-off, matching how 0001–0005 were handled.)

- [ ] **Step 3: Confirm the schema landed**

Run: `node -e "import('dotenv').then(({config})=>{config({path:'.env.local'});import('@supabase/supabase-js').then(async ({createClient})=>{const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);const {error}=await db.from('occupation_skills').select('occupation_id',{count:'exact',head:true});console.log('occupation_skills reachable:',!error);const {error:e2}=await db.from('earners').select('target_occupation_skill_id',{head:true}).limit(1);console.log('earners.target_occupation_skill_id reachable:',!e2);})})"`
Expected: both lines print `true` (table + column exist).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0006_advisor.sql
git commit -m "feat: 0006 migration — occupation_skills relation + earners.target_occupation_skill_id"
```

---

### Task 2: O*NET occupation→skill parser + seed extension

**Files:**
- Modify: `lib/skills/onet-parse.ts`
- Modify: `lib/skills/onet-parse.test.ts`
- Modify: `scripts/seed-onet.mjs`

**Interfaces:**
- Consumes: `parseTable` (private in `onet-parse.ts`), `V1_OCCUPATION_PREFIXES` (exported), `Essential Skills.txt` + `Transferable Skills.txt` (already on disk, confirmed headers `O*NET-SOC Code, Element ID, Element Name, Scale ID, Data Value, …, Recommend Suppress, …`).
- Produces:
  ```ts
  export const MIN_IMPORTANCE = 3.0; // O*NET 1–5 IM scale; "somewhat important or more"
  export interface OccupationSkillRow {
    occupation_onet_id: string; // O*NET-SOC Code (joins to skills.onet_id, type 'occupation')
    skill_onet_id: string;      // Element ID — resolves ONLY against type 'skill' vocabulary rows
                                //   (Essential/Transferable Element IDs). Technology 'competency'
                                //   rows are seeded with onet_id: null and are intentionally never
                                //   linked here, so occupation_skills references skills, not
                                //   competencies. The seed drops any element not in the vocabulary.
    importance: number;
  }
  export function parseOccupationSkillImportance(text: string, allowlist: Set<string>): OccupationSkillRow[];
  ```

- [ ] **Step 1: Add the parser to `lib/skills/onet-parse.ts`**

Append (after `parseTechnologySkills`; do NOT touch the existing exports):

```ts
/**
 * O*NET 1–5 IM ("Importance") scale cutoff. O*NET's own "somewhat important or more"
 * convention. Filtering at seed time keeps occupation_skills small and the runtime query
 * trivial (no threshold logic duplicated in app code).
 */
export const MIN_IMPORTANCE = 3.0;

export interface OccupationSkillRow {
  occupation_onet_id: string;
  skill_onet_id: string;
  importance: number;
}

/**
 * Parse an O*NET "Essential Skills" / "Transferable Skills" table into occupation×skill
 * importance rows, restricted to the IM scale, to importance >= MIN_IMPORTANCE, and to
 * occupations in the allowlist. Pure (no I/O) — the seed script resolves O*NET ids to
 * skills.id and upserts. Call once per file's raw text and concat the results.
 */
export function parseOccupationSkillImportance(
  text: string,
  allowlist: Set<string>
): OccupationSkillRow[] {
  const out: OccupationSkillRow[] = [];
  for (const row of parseTable(text)) {
    const occCode = row["O*NET-SOC Code"];
    const elementId = row["Element ID"];
    const scale = row["Scale ID"];
    if (!occCode || !elementId || scale !== "IM" || !allowlist.has(occCode)) continue;
    const importance = Number(row["Data Value"]);
    if (!Number.isFinite(importance) || importance < MIN_IMPORTANCE) continue;
    out.push({
      occupation_onet_id: occCode,
      skill_onet_id: elementId,
      importance,
    });
  }
  return out;
}
```

- [ ] **Step 2: Add parser tests to `lib/skills/onet-parse.test.ts`**

Append:

```ts
import { parseOccupationSkillImportance, MIN_IMPORTANCE } from "./onet-parse";

const OCC_SKILL_TXT = [
  "O*NET-SOC Code\tElement ID\tElement Name\tScale ID\tData Value\tRecommend Suppress",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tIM\t4.12\tN",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tLV\t3.88\tN", // LV scale — must drop
  "15-1252.00\t2.B.3.a\tCritical Thinking\tIM\t2.50\tN",     // below MIN_IMPORTANCE — must drop
  "29-1141.00\t2.A.1.a\tReading Comprehension\tIM\t3.50\tN",
  "99-9999.00\t2.A.1.a\tReading Comprehension\tIM\t4.00\tN", // occupation not allowlisted — drop
].join("\n");

test("parseOccupationSkillImportance keeps only IM rows at/above the importance cutoff, allowlisted", () => {
  const rows = parseOccupationSkillImportance(OCC_SKILL_TXT, ALLOW);
  expect(rows).toEqual([
    { occupation_onet_id: "15-1252.00", skill_onet_id: "2.A.1.a", importance: 4.12 },
    { occupation_onet_id: "29-1141.00", skill_onet_id: "2.A.1.a", importance: 3.5 },
  ]);
  expect(MIN_IMPORTANCE).toBe(3.0);
});

test("parseOccupationSkillImportance tolerates CRLF and a trailing blank line", () => {
  const crlf = OCC_SKILL_TXT.replace(/\n/g, "\r\n") + "\r\n";
  expect(parseOccupationSkillImportance(crlf, ALLOW)).toHaveLength(2);
});
```

(`ALLOW` is already defined at the top of the existing test file: `new Set(["15-1252.00", "29-1141.00"])`.)

- [ ] **Step 3: Run the parser tests (expected PASS)**

Run: `npm test -- lib/skills/onet-parse.test.ts`
Expected: all existing + 2 new tests pass.

- [ ] **Step 4: Extend `scripts/seed-onet.mjs` to seed `occupation_skills`**

Add the import (alongside the existing `onet-parse.ts` imports):

```js
import {
  parseOccupationData,
  parseSkillsElements,
  parseTechnologySkills,
  parseOccupationSkillImportance,
  V1_OCCUPATION_PREFIXES,
} from "../lib/skills/onet-parse.ts";
```

After the existing `skills` upsert loop (the `console.log("Seeded ... rows into skills ...")` line), append:

```js
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
```

- [ ] **Step 5: Run the seed against the hosted project**

Run: `node scripts/seed-onet.mjs`
Expected: prints the existing skills summary AND `Prepared N occupation_skills rows from … source file(s)` / `Seeded N rows into occupation_skills` with **N at least ~1000** and typically in the single-digit thousands (importance + vocabulary filtered). The seed now HARD-FAILS (`process.exit(1)`) if N < 1000, so a broken `onet_id` join or importance filter cannot silently pass a near-empty relation through to later tasks — if you hit that error, debug the join before proceeding. (Requires either the legacy `Skills.txt` OR both `Essential Skills.txt` + `Transferable Skills.txt` in `scripts/onet-data/`; the seed parses whichever exist, matching the vocabulary path.)

- [ ] **Step 6: Commit**

```bash
git add lib/skills/onet-parse.ts lib/skills/onet-parse.test.ts scripts/seed-onet.mjs
git commit -m "feat: parse + seed occupation_skills relation (closes O*NET gap-math data gap)"
```

---

### Task 3: Advisor shared types

**Files:**
- Create: `lib/advisor/types.ts`

**Interfaces:**
- Consumes: nothing (foundation for Plan 5).
- Produces (the canonical type set every `lib/advisor/*` module imports from `@/lib/advisor/types`):

- [ ] **Step 1: Write `lib/advisor/types.ts`**

```ts
// Shared types for the Trove AI advisor (Plan 5). This is the ONLY module every other
// lib/advisor/* file may import from. It imports nothing from the Supabase or Anthropic SDKs —
// keeping the pure core dependency-free and unit-testable. Mirrors lib/skills/types.ts.

/** A persisted advisor message row (subset used across the pipeline + UI). */
export interface AdvisorMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  tokenCost: number;
  createdAt: string;
}

/** A conversation turn passed to the LLM (no ids/costs — just role + content). */
export interface AdvisorTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AdvisorThreadSummary {
  id: string;
  title: string;
  createdAt: string;
}

/** One occupation's required-skill row (already importance-filtered at seed time). */
export interface OccupationSkillRequirement {
  occupationId: string;
  occupationName: string;
  skillId: string;
  importance: number;
}

/** The earner's rolled-up skill (from earner_skills). */
export interface EarnerSkillRow {
  skillId: string;
  skillName: string;
}

/** A credential surfaced to the advisor, pre-bucketed by verification status IN CODE. */
export interface AdvisorCredential {
  title: string;
  issuerName: string;
}

/** Pure gap-math output for one occupation. */
export interface OccupationGap {
  occupationId: string;
  occupationName: string;
  haveSkillIds: string[];
  missingSkillNames: string[];
  haveCount: number;
  totalCount: number;
  coveragePct: number; // 0..100, rounded
}

/** The full per-message context assembled in code and fed to the prompt builder. */
export interface AdvisorContext {
  verifiedCredentials: AdvisorCredential[];
  unverifiedCredentials: AdvisorCredential[];
  earnerSkillNames: string[];
  targetOccupationName: string | null;
  /** Gap for the target occupation, or ranked candidates when no target is set. */
  targetGap: OccupationGap | null;
  candidateGaps: OccupationGap[];
  history: AdvisorTurn[];
  /** True when at least one credential is unverified (advisor must flag reliance on it). */
  hasUnverifiedCredentials: boolean;
}

/** Injectable LLM boundary — real impl in lib/advisor/llm.ts, fake in tests. */
export interface AdvisorLlm {
  reply(input: {
    systemPrompt: string;
    contextBlock: string;
    history: AdvisorTurn[];
    userMessage: string;
    webSearchEnabled: boolean;
  }): Promise<{ content: string; tokenCost: number; usedWebSearch: boolean }>;
}

/**
 * One occupation card returned to the UI: the pure gap plus a conservative v1 unverified-reliance
 * flag. `reliesOnUnverified` is true when the earner has ANY unverified credential
 * (ctx.hasUnverifiedCredentials) — a deliberately conservative signal, since gaps.ts is
 * credential-status-agnostic and does not yet carry per-skill credential provenance. This makes
 * the amber "based partly on an unverified credential" flag on OccupationCard actually reachable
 * (design doc §6 mandates flagging reliance on unverified credentials at the action-guiding
 * surface, not only in prose).
 */
export interface OccupationCard {
  gap: OccupationGap;
  reliesOnUnverified: boolean;
}

/** The orchestrator's discriminated result. Never throws for cap/empty — returns a shaped value. */
export type RunAdvisorTurnResult =
  | { ok: true; message: AdvisorMessage; occupationCards: OccupationCard[] }
  | { ok: false; reason: "rate_limited"; retryAt: string }
  | { ok: false; reason: "empty_message" | "thread_not_found" };
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/advisor/types.ts
git commit -m "feat: advisor shared types (pure, SDK-free)"
```

---

### Task 4: Pure gap math (`gaps.ts`)

**Files:**
- Create: `lib/advisor/gaps.ts`
- Create: `lib/advisor/gaps.test.ts`

**Interfaces:**
- Consumes: `OccupationSkillRequirement`, `EarnerSkillRow`, `OccupationGap` from `@/lib/advisor/types`.
- Produces:
  ```ts
  export function computeOccupationGaps(
    earnerSkills: EarnerSkillRow[],
    requirements: OccupationSkillRequirement[],
    opts?: { minOverlap?: number }
  ): OccupationGap[];
  export function rankOccupationCandidates(gaps: OccupationGap[], limit: number): OccupationGap[];
  ```

- [ ] **Step 1: Write `lib/advisor/gaps.ts`**

```ts
// Pure, deterministic skill-gap math — the "you have X of Y skills for occupation Z"
// computation the design doc (§6) mandates lives IN CODE, not the model. Zero I/O, zero tokens.
// Unit-testable with in-memory fixtures exactly like lib/skills/rollup.ts.

import type {
  EarnerSkillRow,
  OccupationGap,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

/**
 * Group requirement rows by occupation and diff against the earner's held skills.
 * Only returns occupations that have >= 1 requirement row (data-backed) AND >= minOverlap
 * skills already held (candidate filter — avoids surfacing occupations with near-zero signal).
 * Deterministic: output order is sorted by occupationId, independent of input order.
 */
export function computeOccupationGaps(
  earnerSkills: EarnerSkillRow[],
  requirements: OccupationSkillRequirement[],
  opts?: { minOverlap?: number }
): OccupationGap[] {
  const minOverlap = opts?.minOverlap ?? 1;
  const earnerSkillIds = new Set(earnerSkills.map((s) => s.skillId));

  // occupationId -> { name, skillId -> skillName (from requirement rows) }
  const byOccupation = new Map<
    string,
    { name: string; required: Map<string, string> }
  >();
  for (const req of requirements) {
    let entry = byOccupation.get(req.occupationId);
    if (!entry) {
      entry = { name: req.occupationName, required: new Map() };
      byOccupation.set(req.occupationId, entry);
    }
    entry.required.set(req.skillId, req.occupationName);
    // Skill display name lives on the requirement row's own name lookup below; we key the
    // missing-name list off a shared skill-name map assembled from requirements + earner rows.
  }

  // Build a skillId -> displayName map from both requirements (skillId) and earner rows.
  const skillNameById = new Map<string, string>();
  for (const s of earnerSkills) skillNameById.set(s.skillId, s.skillName);
  for (const req of requirements) {
    if (!skillNameById.has(req.skillId)) skillNameById.set(req.skillId, req.skillId);
  }

  const out: OccupationGap[] = [];
  for (const [occupationId, { name, required }] of byOccupation) {
    const totalCount = required.size;
    if (totalCount === 0) continue; // guard the coveragePct denominator

    const haveSkillIds: string[] = [];
    const missingSkillNames: string[] = [];
    for (const skillId of required.keys()) {
      if (earnerSkillIds.has(skillId)) haveSkillIds.push(skillId);
      else missingSkillNames.push(skillNameById.get(skillId) ?? skillId);
    }
    if (haveSkillIds.length < minOverlap) continue;

    out.push({
      occupationId,
      occupationName: name,
      haveSkillIds: haveSkillIds.sort(),
      missingSkillNames: missingSkillNames.sort(),
      haveCount: haveSkillIds.length,
      totalCount,
      coveragePct: Math.round((haveSkillIds.length / totalCount) * 100),
    });
  }

  return out.sort((a, b) =>
    a.occupationId < b.occupationId ? -1 : a.occupationId > b.occupationId ? 1 : 0
  );
}

/** Pick top-N candidates by coveragePct desc, ties broken by totalCount desc. Pure. */
export function rankOccupationCandidates(
  gaps: OccupationGap[],
  limit: number
): OccupationGap[] {
  return [...gaps]
    .sort((a, b) =>
      b.coveragePct !== a.coveragePct
        ? b.coveragePct - a.coveragePct
        : b.totalCount - a.totalCount
    )
    .slice(0, Math.max(0, limit));
}
```

- [ ] **Step 2: Write `lib/advisor/gaps.test.ts`**

```ts
import { expect, test } from "vitest";
import { computeOccupationGaps, rankOccupationCandidates } from "./gaps";
import type {
  EarnerSkillRow,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

const earner: EarnerSkillRow[] = [
  { skillId: "s1", skillName: "Reading" },
  { skillId: "s2", skillName: "Writing" },
];

// Occupation A requires [s1,s2,s3]; B requires [s1,s4]; C requires [s5,s6] (no overlap).
const reqs: OccupationSkillRequirement[] = [
  { occupationId: "A", occupationName: "Nurse", skillId: "s1", importance: 4 },
  { occupationId: "A", occupationName: "Nurse", skillId: "s2", importance: 4 },
  { occupationId: "A", occupationName: "Nurse", skillId: "s3", importance: 3.5 },
  { occupationId: "B", occupationName: "Analyst", skillId: "s1", importance: 4 },
  { occupationId: "B", occupationName: "Analyst", skillId: "s4", importance: 3.5 },
  { occupationId: "C", occupationName: "Welder", skillId: "s5", importance: 4 },
  { occupationId: "C", occupationName: "Welder", skillId: "s6", importance: 4 },
];

test("computes have/missing/coveragePct per occupation", () => {
  const gaps = computeOccupationGaps(earner, reqs);
  const a = gaps.find((g) => g.occupationId === "A")!;
  const b = gaps.find((g) => g.occupationId === "B")!;
  expect(a.haveSkillIds).toEqual(["s1", "s2"]);
  expect(a.missingSkillNames).toEqual(["s3"]);
  expect(a.coveragePct).toBe(67); // 2/3 rounded
  expect(b.haveSkillIds).toEqual(["s1"]);
  expect(b.missingSkillNames).toEqual(["s4"]);
  expect(b.coveragePct).toBe(50);
});

test("minOverlap default 1 excludes zero-overlap occupations; minOverlap 0 includes them", () => {
  const gaps = computeOccupationGaps(earner, reqs);
  expect(gaps.find((g) => g.occupationId === "C")).toBeUndefined();
  const all = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  expect(all.find((g) => g.occupationId === "C")).toBeDefined();
});

test("target with zero current overlap still yields a gap (0 of N) under minOverlap:0", () => {
  // The context loader uses minOverlap:0 for an explicitly-set target so the earner sees the
  // real "0 of N" answer instead of the gap silently disappearing (a stretch/target occupation).
  const gaps = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  const c = gaps.find((g) => g.occupationId === "C")!; // Welder: earner holds none of [s5,s6]
  expect(c.haveCount).toBe(0);
  expect(c.totalCount).toBe(2);
  expect(c.coveragePct).toBe(0);
  expect(c.missingSkillNames).toEqual(["s5", "s6"]);
});

test("empty requirements -> empty result (no divide-by-zero)", () => {
  expect(computeOccupationGaps(earner, [])).toEqual([]);
});

test("deterministic regardless of input order", () => {
  const shuffled = [...reqs].reverse();
  expect(computeOccupationGaps(earner, shuffled)).toEqual(
    computeOccupationGaps(earner, reqs)
  );
});

test("rankOccupationCandidates sorts by coveragePct desc then totalCount desc, respects limit", () => {
  const gaps = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  const ranked = rankOccupationCandidates(gaps, 2);
  expect(ranked).toHaveLength(2);
  expect(ranked[0].occupationId).toBe("B"); // 50% > A's 67%? no — A is 67, so A first
  // A=67, B=50, C=0 -> [A, B]
  expect(ranked.map((g) => g.occupationId)).toEqual(["A", "B"]);
});
```

- [ ] **Step 3: Run the gap-math tests (expected PASS)**

Run: `npm test -- lib/advisor/gaps.test.ts`
Expected: 6 passed.

- [ ] **Step 4: Commit**

```bash
git add lib/advisor/gaps.ts lib/advisor/gaps.test.ts
git commit -m "feat: pure occupation gap math (X of Y skills, in code not the model)"
```

---

### Task 5: Pure prompt builder, topic router, history trimmer

**Files:**
- Create: `lib/advisor/prompt.ts`, `lib/advisor/prompt.test.ts`
- Create: `lib/advisor/route-topic.ts`, `lib/advisor/route-topic.test.ts`
- Create: `lib/advisor/history.ts`, `lib/advisor/history.test.ts`

**Interfaces:**
- Consumes: `AdvisorContext`, `AdvisorTurn` from `@/lib/advisor/types`.
- Produces:
  ```ts
  export const SYSTEM_PROMPT: string;
  export function buildContextBlock(ctx: AdvisorContext): string;
  export function shouldUseWebSearch(userMessage: string): boolean;
  export function trimHistory(messages: AdvisorTurn[], maxTurns?: number): AdvisorTurn[];
  export const MAX_HISTORY_TURNS = 10;
  ```

- [ ] **Step 1: Write `lib/advisor/prompt.ts`**

```ts
// Pure prompt construction. The static SYSTEM_PROMPT never varies (a strong prompt-cache
// candidate). buildContextBlock formats the already-computed context struct — it NEVER asks the
// model to compute gaps and NEVER leaks raw_json. Safety framing (guidance-not-guarantee,
// flag-unverified) lives here per design doc §6.

import type { AdvisorContext } from "@/lib/advisor/types";

export const SYSTEM_PROMPT = [
  "You are Trove's career and education advisor. You help adult learners understand their",
  "skills, find occupations they may qualify for, identify what to learn next, and plan how to",
  "get there (admissions, financial aid, apprenticeships, certifications).",
  "",
  "Ground every claim in the earner's credential and skills data provided below. Never invent",
  "credentials, skills, jobs, programs, or outcomes not in the provided context.",
  "",
  'The context lists credentials in two groups: "Verified credentials" (independently confirmed)',
  'and "Unverified credentials" (self-reported, not independently confirmed). When your answer',
  "depends on something from the Unverified list, say so explicitly (for example: \"based on your",
  'self-reported X, which is not yet verified"). Do not treat unverified and verified credentials',
  "as equally certain.",
  "",
  "The context may include a pre-computed skill gap (\"you have X of Y skills for role Z\"). Use",
  "those numbers as given — do not recompute or second-guess them.",
  "",
  "Frame all outcomes as guidance, not a guarantee. Never state or imply that a job offer, program",
  'admission, or financial aid award is certain. Use language like "may qualify you for," "could be',
  'a strong fit," "is worth exploring" — not "will get you" or "guarantees."',
  "",
  "If you lack enough information (e.g. no gap data for an occupation), say so plainly instead of",
  "guessing.",
  "",
  "Only discuss career paths, occupations, skills, credentials, education, training, certifications,",
  "financial aid, and job-search strategy relevant to this earner. For anything else, politely",
  "decline and redirect.",
  "",
  "When citing time-sensitive or external facts (current openings, program deadlines), rely only on",
  "the search results provided and cite them; do not state such facts from memory.",
].join("\n");

export function buildContextBlock(ctx: AdvisorContext): string {
  const lines: string[] = [];

  lines.push("Verified credentials:");
  if (ctx.verifiedCredentials.length === 0) lines.push("- (none)");
  for (const c of ctx.verifiedCredentials) lines.push(`- ${c.title} (${c.issuerName})`);

  lines.push("", "Unverified credentials:");
  if (ctx.unverifiedCredentials.length === 0) lines.push("- (none)");
  for (const c of ctx.unverifiedCredentials) lines.push(`- ${c.title} (${c.issuerName})`);

  lines.push("", "Skills profile:");
  if (ctx.earnerSkillNames.length === 0) lines.push("- (none yet)");
  for (const name of ctx.earnerSkillNames) lines.push(`- ${name}`);

  lines.push("", `Target occupation: ${ctx.targetOccupationName ?? "not set"}`);

  if (ctx.targetGap) {
    const g = ctx.targetGap;
    lines.push(
      `Skill gap for ${g.occupationName}: you have ${g.haveCount} of ${g.totalCount} ` +
        `required skills (${g.coveragePct}%).` +
        (g.missingSkillNames.length
          ? ` Missing: ${g.missingSkillNames.join(", ")}.`
          : "")
    );
  } else if (!ctx.targetOccupationName && ctx.candidateGaps.length > 0) {
    lines.push("Candidate occupations by current skill coverage:");
    for (const g of ctx.candidateGaps) {
      lines.push(`- ${g.occupationName}: ${g.haveCount} of ${g.totalCount} (${g.coveragePct}%)`);
    }
  } else if (ctx.targetOccupationName) {
    // A target is set but computeOccupationGaps(minOverlap:0) returned no gap for it — i.e. the
    // occupation genuinely has no seeded requirement rows. Distinct from the no-target case so a
    // debugger can tell "unseeded occupation" apart from "no target chosen".
    lines.push(
      `Skill-gap data has not been seeded for ${ctx.targetOccupationName} yet, so an exact ` +
        `"X of Y skills" count is not available.`
    );
  } else {
    lines.push("No target occupation is set and no candidate occupations could be ranked yet.");
  }

  return lines.join("\n");
}
```

- [ ] **Step 2: Write `lib/advisor/prompt.test.ts`**

```ts
import { expect, test } from "vitest";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompt";
import type { AdvisorContext } from "@/lib/advisor/types";

const base: AdvisorContext = {
  verifiedCredentials: [{ title: "RN License", issuerName: "State Board" }],
  unverifiedCredentials: [{ title: "CPR Cert", issuerName: "Self-reported" }],
  earnerSkillNames: ["Reading", "Writing"],
  targetOccupationName: "Nurse",
  targetGap: {
    occupationId: "A",
    occupationName: "Nurse",
    haveSkillIds: ["s1"],
    missingSkillNames: ["Critical Thinking"],
    haveCount: 1,
    totalCount: 3,
    coveragePct: 33,
  },
  candidateGaps: [],
  history: [],
  hasUnverifiedCredentials: true,
};

test("SYSTEM_PROMPT carries the guidance-not-guarantee and flag-unverified framing", () => {
  expect(SYSTEM_PROMPT).toMatch(/guidance, not a guarantee/i);
  expect(SYSTEM_PROMPT).toMatch(/unverified/i);
});

test("context block labels verified vs unverified and shows the pre-computed gap", () => {
  const block = buildContextBlock(base);
  expect(block).toMatch(/Verified credentials:\n- RN License/);
  expect(block).toMatch(/Unverified credentials:\n- CPR Cert/);
  expect(block).toMatch(/you have 1 of 3 required skills \(33%\)/);
  expect(block).toMatch(/Missing: Critical Thinking/);
});

test("omits the gap line and shows candidates when no target is set", () => {
  const block = buildContextBlock({
    ...base,
    targetOccupationName: null,
    targetGap: null,
    candidateGaps: [
      {
        occupationId: "B",
        occupationName: "Analyst",
        haveSkillIds: [],
        missingSkillNames: [],
        haveCount: 2,
        totalCount: 5,
        coveragePct: 40,
      },
    ],
  });
  expect(block).toMatch(/Target occupation: not set/);
  expect(block).toMatch(/Candidate occupations/);
  expect(block).toMatch(/Analyst: 2 of 5 \(40%\)/);
});

test("never leaks raw_json (context block has no raw_json key)", () => {
  expect(buildContextBlock(base)).not.toMatch(/raw_json/);
});
```

- [ ] **Step 3: Write `lib/advisor/route-topic.ts`**

```ts
// Pure, deterministic decision: should this message enable Anthropic's web_search tool?
// Web search costs extra, so it is OFF by default and only turned on for clearly time-sensitive
// or external questions (design doc §6.4). No LLM call is used to decide this.

// Signals that a question is genuinely EXTERNAL/time-sensitive and worth the extra billable
// web_search call. Deliberately narrow: bare "salary"/"pay"/"currently"/"today" are DROPPED
// because they fire on common evergreen questions ("what does a nurse get paid?", "what am I
// currently qualified for?") that the model answers from the provided context — turning search on
// for those undercuts the "web search only when external" cost control. We require phrasing that
// implies live external data: job listings, local scoping, explicit recency, or deadlines.
const WEB_SEARCH_SIGNALS: RegExp[] = [
  /\bopenings?\b/i,
  /\bhiring\b/i,
  /\bjob (post|listing|opening)/i,
  /\bwho('?s| is) hiring\b/i,
  /\bnear me\b/i,
  /\bin my area\b/i,
  /\bthis (week|month|year)\b/i,
  /\bright now\b/i,
  /\blatest\b/i,
  /\bdeadlines?\b/i,
  /\bapplication (window|period|deadline)\b/i,
  /\bhow much (do|does|are) .*\b(pay|paid|make|earn)\b.*\b(now|today|currently|this year|near me|in my area)\b/i,
];

export function shouldUseWebSearch(userMessage: string): boolean {
  return WEB_SEARCH_SIGNALS.some((re) => re.test(userMessage));
}
```

- [ ] **Step 4: Write `lib/advisor/route-topic.test.ts`**

```ts
import { expect, test } from "vitest";
import { shouldUseWebSearch } from "./route-topic";

test.each([
  // External / time-sensitive -> ON
  ["What jobs pay well right now near me?", true],
  ["Are there any openings this week?", true],
  ["Who is hiring in my area?", true],
  ["What is the application deadline?", true],
  ["Show me the latest job listings", true],
  ["How much do nurses make near me right now?", true],
  // Evergreen / answerable from context -> OFF (these previously flipped ON under bare
  // salary/pay/currently/today keywords and wasted a billable search)
  ["What does a nurse get paid?", false],
  ["What is the typical salary for a welder?", false],
  ["What am I currently qualified for?", false],
  ["What should I do today to get started?", false],
  ["What skills do I need to become a nurse?", false],
  ["Explain what my RN license qualifies me for", false],
  ["", false],
])("shouldUseWebSearch(%j) === %s", (msg, expected) => {
  expect(shouldUseWebSearch(msg)).toBe(expected);
});
```

- [ ] **Step 5: Write `lib/advisor/history.ts`**

```ts
// Pure history trimming — hard tail-window cap so thread token cost cannot silently balloon.
// v1 uses no LLM summarization (avoids a second paid call to shrink context).
//
// IMPORTANT (real-API correctness): the Anthropic Messages API requires the messages array to
// begin with a `user` turn and to alternate. llm.ts hands this trimmed history to the SDK verbatim
// (before appending the new user turn), so a window that begins with an `assistant` turn would
// 400 on the first real production call — and the injected fake never validates alternation, so
// tests wouldn't catch it. Therefore trimHistory drops any leading `assistant` turn(s) AFTER
// tail-windowing, guaranteeing the returned history starts with a `user` turn (or is empty).

import type { AdvisorTurn } from "@/lib/advisor/types";

export const MAX_HISTORY_TURNS = 10;

export function trimHistory(
  messages: AdvisorTurn[],
  maxTurns: number = MAX_HISTORY_TURNS
): AdvisorTurn[] {
  const windowed =
    messages.length <= maxTurns
      ? messages
      : messages.slice(messages.length - maxTurns);
  // Drop leading assistant turn(s) so the window Anthropic sees starts with a user turn.
  let start = 0;
  while (start < windowed.length && windowed[start].role !== "user") start += 1;
  // Only allocate a new array when we actually trimmed a leading assistant run.
  return start === 0 ? windowed : windowed.slice(start);
}
```

- [ ] **Step 6: Write `lib/advisor/history.test.ts`**

```ts
import { expect, test } from "vitest";
import { trimHistory, MAX_HISTORY_TURNS } from "./history";
import type { AdvisorTurn } from "@/lib/advisor/types";

const turn = (i: number): AdvisorTurn => ({ role: "user", content: `m${i}` });

test("keeps only the last MAX_HISTORY_TURNS turns", () => {
  const many = Array.from({ length: 15 }, (_, i) => turn(i));
  const trimmed = trimHistory(many);
  expect(trimmed).toHaveLength(MAX_HISTORY_TURNS);
  expect(trimmed[0].content).toBe("m5");
  expect(trimmed.at(-1)!.content).toBe("m14");
});

test("leaves short all-user histories untouched (same reference); empty stays empty", () => {
  const few = [turn(0), turn(1)];
  expect(trimHistory(few)).toBe(few);
  expect(trimHistory([])).toEqual([]);
});

test("drops leading assistant turns so the window starts with a user turn (Anthropic requires it)", () => {
  const asst = (i: number): AdvisorTurn => ({ role: "assistant", content: `a${i}` });
  // A window that would begin with an assistant turn (e.g. history starts mid-exchange).
  const mixed = [asst(0), turn(1), asst(2), turn(3)];
  const trimmed = trimHistory(mixed);
  expect(trimmed[0].role).toBe("user");
  expect(trimmed.map((t) => t.content)).toEqual(["m1", "a2", "m3"]);
  // All-assistant history collapses to empty rather than leading with assistant.
  expect(trimHistory([asst(0), asst(1)])).toEqual([]);
});
```

- [ ] **Step 7: Run all three pure modules' tests (expected PASS)**

Run: `npm test -- lib/advisor/prompt.test.ts lib/advisor/route-topic.test.ts lib/advisor/history.test.ts`
Expected: all passed.

- [ ] **Step 8: Commit**

```bash
git add lib/advisor/prompt.ts lib/advisor/prompt.test.ts lib/advisor/route-topic.ts lib/advisor/route-topic.test.ts lib/advisor/history.ts lib/advisor/history.test.ts
git commit -m "feat: pure advisor prompt builder + web-search router + history trimmer"
```

---

### Task 6: Advisor LLM adapter (injectable, model-pinned)

**Files:**
- Create: `lib/advisor/llm.ts`
- Create: `lib/advisor/llm.test.ts`

**Interfaces:**
- Consumes: `AdvisorLlm`, `AdvisorTurn` from `@/lib/advisor/types`; `@anthropic-ai/sdk` (already installed).
- Produces:
  ```ts
  export const ADVISOR_MODEL = "claude-sonnet-4-6";
  export const ADVISOR_MAX_TOKENS = 1024;
  export interface AnthropicLike { messages: { create(args: unknown): Promise<{ content: Array<{ type: string } & Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number } }> } }
  export function createAnthropicAdvisorLlmClient(opts?: { apiKey?: string; client?: AnthropicLike }): AdvisorLlm;
  ```

- [ ] **Step 1: Write `lib/advisor/llm.ts`**

```ts
// Advisor LLM adapter (impure) — the ONLY module in lib/advisor/ allowed to import
// @anthropic-ai/sdk. Wraps the Anthropic Messages API behind the pure AdvisorLlm interface from
// lib/advisor/types, with an injectable client (for zero-network unit tests). Mirrors
// lib/skills/llm.ts's AnthropicLike injection pattern and pins the identical model literal.

import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorLlm } from "@/lib/advisor/types";

export const ADVISOR_MODEL = "claude-sonnet-4-6";
export const ADVISOR_MAX_TOKENS = 1024;

/** Anthropic's server-side web-search tool (design doc §6.4). Passed only when enabled. */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" } as const;

/** Minimal shape of the Anthropic client we depend on (injectable for tests). */
export interface AnthropicLike {
  messages: {
    create(args: unknown): Promise<{
      content: Array<{ type: string } & Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export function createAnthropicAdvisorLlmClient(opts?: {
  apiKey?: string;
  client?: AnthropicLike;
}): AdvisorLlm {
  const client: AnthropicLike =
    opts?.client ??
    (new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    }) as unknown as AnthropicLike);

  return {
    async reply(input) {
      // PRECONDITION: input.history must begin with a `user` turn and alternate — Anthropic rejects
      // a leading `assistant` message with a 400. trimHistory (lib/advisor/history.ts) guarantees
      // this by dropping any leading assistant turn(s); this adapter does not re-shape history.
      // The web_search tool (when enabled) is Anthropic's SERVER-side tool: Anthropic runs the
      // search inline within this single create() call and returns the final text in the same
      // response — no client-side tool loop is needed. We therefore treat one round-trip as final.
      const response = await client.messages.create({
        model: ADVISOR_MODEL,
        max_tokens: ADVISOR_MAX_TOKENS,
        system: `${input.systemPrompt}\n\n${input.contextBlock}`,
        ...(input.webSearchEnabled ? { tools: [WEB_SEARCH_TOOL] } : {}),
        messages: [
          ...input.history.map((t) => ({ role: t.role, content: t.content })),
          { role: "user", content: input.userMessage },
        ],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("")
        .trim();

      const usedWebSearch = response.content.some(
        (b) => b.type === "web_search_tool_result" || b.type === "server_tool_use"
      );

      const tokenCost =
        (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

      return { content: text, tokenCost, usedWebSearch };
    },
  };
}
```

- [ ] **Step 2: Write `lib/advisor/llm.test.ts`**

```ts
import { expect, test, vi } from "vitest";
import { createAnthropicAdvisorLlmClient, ADVISOR_MODEL, ADVISOR_MAX_TOKENS } from "./llm";
import type { AnthropicLike } from "./llm";

function fakeClient(overrides?: Partial<ReturnType<typeof makeResponse>>) {
  const create = vi.fn().mockResolvedValue(makeResponse(overrides));
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}
function makeResponse(overrides?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: "Here is some guidance." }],
    usage: { input_tokens: 100, output_tokens: 40 },
    ...overrides,
  };
}

test("pins the Sonnet model and a bounded max_tokens; passes system + context", async () => {
  const { client, create } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [{ role: "user", content: "hi" }],
    userMessage: "what next?",
    webSearchEnabled: false,
  });
  const args = create.mock.calls[0][0] as Record<string, unknown>;
  expect(args.model).toBe(ADVISOR_MODEL);
  expect(args.model).toBe("claude-sonnet-4-6");
  expect(args.max_tokens).toBe(ADVISOR_MAX_TOKENS);
  expect(args.system).toContain("SYS");
  expect(args.system).toContain("CTX");
  expect(args.tools).toBeUndefined(); // web search off
});

test("includes the web_search tool only when webSearchEnabled", async () => {
  const { client, create } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "any openings today?",
    webSearchEnabled: true,
  });
  const args = create.mock.calls[0][0] as { tools?: Array<{ name: string }> };
  expect(args.tools?.[0]?.name).toBe("web_search");
});

test("maps usage to tokenCost and extracts text content", async () => {
  const { client } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  const out = await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "hello",
    webSearchEnabled: false,
  });
  expect(out.content).toBe("Here is some guidance.");
  expect(out.tokenCost).toBe(140);
  expect(out.usedWebSearch).toBe(false);
});
```

- [ ] **Step 3: Run the adapter tests (expected PASS — zero network)**

Run: `npm test -- lib/advisor/llm.test.ts`
Expected: 3 passed. No real Anthropic call is made (a fake `AnthropicLike` is injected).

- [ ] **Step 4: Commit**

```bash
git add lib/advisor/llm.ts lib/advisor/llm.test.ts
git commit -m "feat: advisor LLM adapter (Sonnet-pinned, injectable, web-search gated)"
```

---

### Task 7: Context loader + daily cap (impure DB seams)

**Files:**
- Create: `lib/advisor/context.ts`
- Create: `lib/advisor/cap.ts`

**Interfaces:**
- Consumes: `SupabaseClient`; `getSkillVocabulary` from `@/lib/skills/data`; `computeOccupationGaps`/`rankOccupationCandidates` from `@/lib/advisor/gaps`; `trimHistory` from `@/lib/advisor/history`; types from `@/lib/advisor/types`.
- Produces:
  ```ts
  // context.ts
  export async function loadAdvisorContext(db: SupabaseClient, earnerId: string, threadId: string): Promise<AdvisorContext>;
  // cap.ts
  export const DAILY_MESSAGE_CAP = 20;
  export async function checkDailyMessageCap(db: SupabaseClient, earnerId: string, cap?: number): Promise<{ underCap: boolean; sentToday: number; retryAt: string }>;
  ```

- [ ] **Step 1: Write `lib/advisor/cap.ts`**

```ts
// Per-earner daily message cap — a "not rich" cost guardrail (design doc §6). Counted from
// advisor_messages (role='user', created_at >= start of the current APP_TZ day) so no new table
// is needed. Enforced by the orchestrator BEFORE any LLM call, so an over-cap turn spends zero
// tokens. The window is pinned to ONE explicit operator-controlled timezone (APP_TZ) rather than
// UTC: a UTC window resets the cap mid-afternoon US-local, letting a user get ~cap messages before
// the reset and ~cap more after (~2x the intended daily spend on the local-day boundary), which
// would undercut the hard cost ceiling. Change APP_TZ in one place to move the boundary.
//
// Cap semantics (documented so a fresh executor keeps them consistent): checkDailyMessageCap is
// called by the orchestrator BEFORE it inserts the in-flight user turn, so `sentToday` is the
// count of ALREADY-persisted user turns today, EXCLUSIVE of the current one. `underCap` is
// `sentToday < cap`, so the current turn is allowed while fewer than `cap` turns already exist —
// i.e. exactly `cap` successful user turns are permitted per day (turns 1..cap), and the
// (cap+1)-th is rejected. Because orchestrate.ts persists the user turn immediately after this
// check passes, a paid call that later errors is still counted (no free infinite retries).

import type { SupabaseClient } from "@supabase/supabase-js";

export const DAILY_MESSAGE_CAP = 20;

/**
 * The single timezone the daily-cap window is anchored to. IANA name; the operator sets this to
 * their own locale so "one day" of messages matches a human calendar day, not a UTC day. Kept a
 * named constant (not read from env) so the boundary is deterministic and unit-testable.
 */
export const APP_TZ = "America/New_York";

/**
 * The UTC offset (in ms) of APP_TZ at a given instant, derived with no external tz library and
 * INDEPENDENT of the runner's own timezone. We format `instant` into APP_TZ wall-clock parts, read
 * those parts back AS IF they were UTC, and subtract the real epoch: the difference is the zone's
 * offset (positive east of UTC). This correctly follows DST because Intl resolves the offset for
 * that specific instant. (The naive `new Date(d.toLocaleString(...))` trick is avoided because
 * Date parsing of a locale string uses the RUNNER's tz, which would make the result machine-
 * dependent.)
 */
function appTzOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // Some engines format midnight as hour "24"; normalize to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/**
 * The instant of midnight (00:00) in APP_TZ for the day containing `at`, returned as a UTC ISO
 * string. Read the APP_TZ wall-clock Y/M/D for `at`, treat that Y/M/D 00:00 as a provisional UTC
 * instant, then subtract the zone's offset at that provisional instant to land on the true UTC
 * moment of APP_TZ midnight. `dayDelta` shifts to a neighboring day (e.g. +1 for start of tomorrow,
 * the capped earner's retryAt). Runner-timezone-independent; DST-correct.
 */
function startOfAppTzDay(at: Date, dayDelta = 0): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const provisional = Date.UTC(get("year"), get("month") - 1, get("day") + dayDelta, 0, 0, 0);
  const offsetMs = appTzOffsetMs(new Date(provisional));
  return new Date(provisional - offsetMs).toISOString();
}

/**
 * Start of the APP_TZ day containing `at` (window floor), exported for the boundary unit test.
 * `startOfTomorrowAppTz` reuses it with dayDelta:+1 for the capped earner's retryAt.
 */
export function startOfTodayAppTz(at: Date = new Date()): string {
  return startOfAppTzDay(at, 0);
}
export function startOfTomorrowAppTz(at: Date = new Date()): string {
  return startOfAppTzDay(at, 1);
}

export async function checkDailyMessageCap(
  db: SupabaseClient,
  earnerId: string,
  cap: number = DAILY_MESSAGE_CAP
): Promise<{ underCap: boolean; sentToday: number; retryAt: string }> {
  const { count, error } = await db
    .from("advisor_messages")
    .select("*", { count: "exact", head: true })
    .eq("earner_id", earnerId)
    .eq("role", "user")
    .gte("created_at", startOfTodayAppTz());
  if (error) throw error;
  const sentToday = count ?? 0;
  return { underCap: sentToday < cap, sentToday, retryAt: startOfTomorrowAppTz() };
}
```

- [ ] **Step 1b: Write `lib/advisor/cap.test.ts` (pure window-boundary + cap-arithmetic tests)**

These cover the day-boundary math and the cap comparison WITHOUT any network: `checkDailyMessageCap` is exercised against a tiny fake `db` that records the `gte` filter value, so we assert both the boundary and the `underCap` semantics deterministically.

```ts
import { expect, test, vi } from "vitest";
import {
  checkDailyMessageCap,
  startOfTodayAppTz,
  startOfTomorrowAppTz,
  DAILY_MESSAGE_CAP,
  APP_TZ,
} from "./cap";

test("APP_TZ day boundary: 23:59 and 00:01 local land in the correct APP_TZ days", () => {
  // America/New_York is UTC-4 in July (EDT). Local 2026-07-02 00:01 == UTC 04:01.
  // The start-of-day floor for any instant on local 2026-07-02 must be UTC 04:00 that date.
  const justAfterMidnightLocal = new Date("2026-07-02T04:01:00Z"); // 00:01 EDT
  const justBeforeMidnightLocal = new Date("2026-07-02T03:59:00Z"); // 23:59 EDT on 2026-07-01
  expect(startOfTodayAppTz(justAfterMidnightLocal)).toBe("2026-07-02T04:00:00.000Z");
  expect(startOfTodayAppTz(justBeforeMidnightLocal)).toBe("2026-07-01T04:00:00.000Z");
  // They fall on DIFFERENT local days despite being 2 minutes apart in UTC.
  expect(startOfTodayAppTz(justAfterMidnightLocal)).not.toBe(
    startOfTodayAppTz(justBeforeMidnightLocal)
  );
  // Sanity: tomorrow is exactly one local day after today's floor.
  expect(startOfTomorrowAppTz(justAfterMidnightLocal)).toBe("2026-07-03T04:00:00.000Z");
  expect(APP_TZ).toBe("America/New_York");
});

function fakeCapDb(sentToday: number) {
  // Records the gte boundary and returns a canned count for the head:true count query.
  const gteCalls: string[] = [];
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gte: (_col: string, val: string) => {
      gteCalls.push(val);
      return chain;
    },
    then: (res: (v: { count: number; error: null }) => void) =>
      res({ count: sentToday, error: null }),
  };
  return { from: () => chain, gteCalls };
}

test("underCap is sentToday < cap (exclusive of the in-flight turn): cap-1 allows, cap rejects", async () => {
  const under = await checkDailyMessageCap(fakeCapDb(DAILY_MESSAGE_CAP - 1) as any, "e1");
  expect(under.underCap).toBe(true);
  expect(under.sentToday).toBe(DAILY_MESSAGE_CAP - 1);

  const at = await checkDailyMessageCap(fakeCapDb(DAILY_MESSAGE_CAP) as any, "e1");
  expect(at.underCap).toBe(false); // the (cap+1)-th turn is rejected
  expect(at.retryAt).toMatch(/T04:00:00\.000Z$/); // next APP_TZ midnight, expressed in UTC
});

test("filters the count to today's APP_TZ window floor", async () => {
  const db = fakeCapDb(0);
  await checkDailyMessageCap(db as any, "e1");
  expect(db.gteCalls[0]).toBe(startOfTodayAppTz());
});
```

Run: `npm test -- lib/advisor/cap.test.ts`
Expected: 3 passed (zero network; a fake `db` is injected).

> **Note on the offset derivation:** the offset is read via `Intl.DateTimeFormat.formatToParts`
> (no external tz library) and is INDEPENDENT of the CI runner's own timezone — we deliberately do
> NOT use `new Date(d.toLocaleString(...))`, whose parse step depends on the machine tz and would
> make the boundary machine-dependent. It follows DST because Intl resolves the offset for the
> specific instant. The `cap.test.ts` boundary test asserts the 23:59-vs-00:01 local case lands in
> the right day, so a regression in this arithmetic fails loudly rather than silently doubling the
> window.

- [ ] **Step 2: Write `lib/advisor/context.ts`**

```ts
// Impure context assembly — the ONLY advisor module (besides cap.ts) that reads earner data from
// Supabase. Reuses getSkillVocabulary (Plan 2). Buckets credentials verified/unverified IN CODE
// from the credentials.verification_status enum, runs the pure gap math, and trims history.
// Never selects or forwards raw_json.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSkillVocabulary } from "@/lib/skills/data";
import {
  computeOccupationGaps,
  rankOccupationCandidates,
} from "@/lib/advisor/gaps";
import { trimHistory } from "@/lib/advisor/history";
import type {
  AdvisorContext,
  AdvisorTurn,
  EarnerSkillRow,
  OccupationGap,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

const CANDIDATE_LIMIT = 5;

export async function loadAdvisorContext(
  db: SupabaseClient,
  earnerId: string,
  threadId: string
): Promise<AdvisorContext> {
  // --- vocabulary (id -> {name, onet_id, type}) ---
  const vocabulary = await getSkillVocabulary(db);
  const skillNameById = new Map(vocabulary.map((s) => [s.id, s.canonical_name]));

  // --- earner skills (rolled up by Plan 2) ---
  const { data: esRows, error: esErr } = await db
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  if (esErr) throw esErr;
  const earnerSkills: EarnerSkillRow[] = (esRows ?? []).map((r) => ({
    skillId: r.skill_id as string,
    skillName: skillNameById.get(r.skill_id as string) ?? (r.skill_id as string),
  }));

  // --- credentials, bucketed verified/unverified IN CODE (failed excluded) ---
  const { data: credRows, error: credErr } = await db
    .from("credentials")
    .select("title, issuer_name, verification_status")
    .eq("earner_id", earnerId);
  if (credErr) throw credErr;
  const verifiedCredentials = [];
  const unverifiedCredentials = [];
  for (const c of credRows ?? []) {
    const entry = { title: (c.title as string) || "Untitled", issuerName: (c.issuer_name as string) || "Unknown issuer" };
    if (c.verification_status === "verified") verifiedCredentials.push(entry);
    else if (c.verification_status === "unverified") unverifiedCredentials.push(entry);
    // 'failed' credentials are excluded from context entirely.
  }

  // --- target occupation (durable, on earners) ---
  const { data: earnerRow, error: earnerErr } = await db
    .from("earners")
    .select("target_occupation_skill_id")
    .eq("id", earnerId)
    .single();
  if (earnerErr) throw earnerErr;
  const targetOccupationId = (earnerRow?.target_occupation_skill_id as string | null) ?? null;
  const targetOccupationName = targetOccupationId
    ? skillNameById.get(targetOccupationId) ?? null
    : null;

  // --- occupation_skills requirement rows (target-only if set, else candidate set) ---
  let osQuery = db
    .from("occupation_skills")
    .select("occupation_id, skill_id, importance");
  if (targetOccupationId) osQuery = osQuery.eq("occupation_id", targetOccupationId);
  const { data: osRows, error: osErr } = await osQuery.range(0, 9999);
  if (osErr) throw osErr;

  const requirements: OccupationSkillRequirement[] = (osRows ?? []).map((r) => ({
    occupationId: r.occupation_id as string,
    occupationName: skillNameById.get(r.occupation_id as string) ?? (r.occupation_id as string),
    skillId: r.skill_id as string,
    importance: r.importance as number,
  }));

  // When a target occupation is explicitly set, the earner chose it on purpose — a 0-of-N result
  // is itself the actionable answer, so compute its gap with minOverlap:0 (never filter it out).
  // For the no-target candidate-ranking path, keep the default minOverlap:1 so occupations with
  // zero current signal don't clutter the suggestions.
  let targetGap: OccupationGap | null = null;
  let candidateGaps: OccupationGap[] = [];
  if (targetOccupationId) {
    const gaps = computeOccupationGaps(earnerSkills, requirements, { minOverlap: 0 });
    targetGap = gaps.find((g) => g.occupationId === targetOccupationId) ?? null;
  } else {
    const gaps = computeOccupationGaps(earnerSkills, requirements);
    candidateGaps = rankOccupationCandidates(gaps, CANDIDATE_LIMIT);
  }

  // --- thread history (last turns, chronological, trimmed) ---
  const { data: msgRows, error: msgErr } = await db
    .from("advisor_messages")
    .select("role, content, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (msgErr) throw msgErr;
  const history: AdvisorTurn[] = trimHistory(
    (msgRows ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as string,
    }))
  );

  return {
    verifiedCredentials,
    unverifiedCredentials,
    earnerSkillNames: earnerSkills.map((s) => s.skillName),
    targetOccupationName,
    targetGap,
    candidateGaps,
    history,
    hasUnverifiedCredentials: unverifiedCredentials.length > 0,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Both files are exercised end-to-end by the live-DB integration test in Task 12; they have no colocated unit test because they are thin DB seams — matching how `lib/skills/data.ts` is covered only via `tests/db/*`.)

- [ ] **Step 4: Commit**

```bash
git add lib/advisor/context.ts lib/advisor/cap.ts lib/advisor/cap.test.ts
git commit -m "feat: advisor context loader (in-code gap math) + APP_TZ daily message cap"
```

---

### Task 8: Orchestrator (`runAdvisorTurn`) with fake-DB + fake-LLM tests

**Files:**
- Create: `lib/advisor/orchestrate.ts`
- Create: `lib/advisor/orchestrate.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient`; `AdvisorLlm`; `checkDailyMessageCap`/`DAILY_MESSAGE_CAP` from `@/lib/advisor/cap`; `loadAdvisorContext` from `@/lib/advisor/context`; `SYSTEM_PROMPT`/`buildContextBlock` from `@/lib/advisor/prompt`; `shouldUseWebSearch` from `@/lib/advisor/route-topic`; types from `@/lib/advisor/types`.
- Produces:
  ```ts
  export async function runAdvisorTurn(
    db: SupabaseClient,
    llm: AdvisorLlm,
    input: { earnerId: string; threadId: string; userMessage: string }
  ): Promise<RunAdvisorTurnResult>;
  ```

- [ ] **Step 1: Write `lib/advisor/orchestrate.ts`**

```ts
// The advisor pipeline's single entry point (mirrors lib/skills/index.ts's processCredential
// shape). Ordering is safety/cost-first: cap check BEFORE any LLM call; gap math already ran in
// loadAdvisorContext (in code); persist BOTH the user turn and the assistant reply with token_cost.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdvisorLlm,
  AdvisorMessage,
  OccupationCard,
  RunAdvisorTurnResult,
} from "@/lib/advisor/types";
import { checkDailyMessageCap } from "@/lib/advisor/cap";
import { loadAdvisorContext } from "@/lib/advisor/context";
import { SYSTEM_PROMPT, buildContextBlock } from "@/lib/advisor/prompt";
import { shouldUseWebSearch } from "@/lib/advisor/route-topic";

function rowToMessage(row: Record<string, unknown>): AdvisorMessage {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    tokenCost: (row.token_cost as number) ?? 0,
    createdAt: row.created_at as string,
  };
}

export async function runAdvisorTurn(
  db: SupabaseClient,
  llm: AdvisorLlm,
  input: { earnerId: string; threadId: string; userMessage: string }
): Promise<RunAdvisorTurnResult> {
  const userMessage = input.userMessage.trim();
  if (!userMessage) return { ok: false, reason: "empty_message" };

  // Confirm the thread exists and is owned (RLS already scopes this to the caller).
  const { data: thread } = await db
    .from("advisor_threads")
    .select("id")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!thread) return { ok: false, reason: "thread_not_found" };

  // COST GUARD: enforce the daily cap BEFORE any paid call. Over-cap => zero tokens spent.
  const cap = await checkDailyMessageCap(db, input.earnerId);
  if (!cap.underCap) return { ok: false, reason: "rate_limited", retryAt: cap.retryAt };

  // Assemble context (gap math runs in code here) and decide web search deterministically.
  const ctx = await loadAdvisorContext(db, input.earnerId, input.threadId);
  const webSearchEnabled = shouldUseWebSearch(userMessage);

  // COST GUARD (part 2): persist the user turn BEFORE the paid llm.reply call. The daily cap
  // counts role='user' rows, so writing this row now means every paid attempt is counted even if
  // llm.reply throws afterward — a user whose calls keep erroring cannot retry indefinitely and
  // burn tokens while the counter never moves. `token_cost: 0` on the user row; the assistant row
  // below carries the real cost. loadAdvisorContext already ran with the pre-insert history, so
  // this new user turn is NOT double-counted into the history handed to the model.
  const { error: userErr } = await db.from("advisor_messages").insert({
    thread_id: input.threadId,
    earner_id: input.earnerId,
    role: "user",
    content: userMessage,
    token_cost: 0,
  });
  if (userErr) throw userErr;

  const reply = await llm.reply({
    systemPrompt: SYSTEM_PROMPT,
    contextBlock: buildContextBlock(ctx),
    history: ctx.history,
    userMessage,
    webSearchEnabled,
  });

  const { data: assistantRow, error: asstErr } = await db
    .from("advisor_messages")
    .insert({
      thread_id: input.threadId,
      earner_id: input.earnerId,
      role: "assistant",
      content: reply.content,
      token_cost: reply.tokenCost,
    })
    .select("id, thread_id, role, content, token_cost, created_at")
    .single();
  if (asstErr) throw asstErr;

  // Attach the conservative v1 unverified-reliance flag to every card so OccupationCard's amber
  // "based partly on an unverified credential" flag is actually reachable (design doc §6). The
  // flag is true whenever the earner has ANY unverified credential — gaps.ts is credential-status
  // -agnostic, so this is a conservative signal, not a per-skill provenance join (deferred).
  const baseGaps = ctx.targetGap ? [ctx.targetGap] : ctx.candidateGaps;
  const occupationCards: OccupationCard[] = baseGaps.map((gap) => ({
    gap,
    reliesOnUnverified: ctx.hasUnverifiedCredentials,
  }));

  return { ok: true, message: rowToMessage(assistantRow), occupationCards };
}
```

- [ ] **Step 2: Write `lib/advisor/orchestrate.test.ts`**

Uses a small in-memory fake Supabase client covering only the chained calls the orchestrator + `loadAdvisorContext` + `cap` issue. Zero network, zero real LLM.

```ts
import { expect, test, vi } from "vitest";
import { runAdvisorTurn } from "./orchestrate";
import type { AdvisorLlm } from "@/lib/advisor/types";

// --- Minimal fake Supabase client ---------------------------------------------------------
// Supports the specific query chains used by cap.ts, context.ts and orchestrate.ts. Each table
// returns canned data; insert() records rows so we can assert what was persisted.
function makeFakeDb(opts: {
  userMessagesToday: number;
  threadExists?: boolean;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const threadExists = opts.threadExists ?? true;

  function from(table: string): any {
    const chain: any = {
      _table: table,
      _filters: {} as Record<string, unknown>,
      select(_cols?: string, cfg?: { count?: string; head?: boolean }) {
        this._count = cfg?.count;
        return this;
      },
      eq(col: string, val: unknown) {
        this._filters[col] = val;
        return this;
      },
      gte() {
        return this;
      },
      order() {
        return this;
      },
      range() {
        return Promise.resolve({ data: rowsFor(table), error: null });
      },
      maybeSingle() {
        if (table === "advisor_threads")
          return Promise.resolve({ data: threadExists ? { id: "t1" } : null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === "earners")
          return Promise.resolve({ data: { target_occupation_skill_id: null }, error: null });
        // assistant insert().select().single()
        const row = inserted[inserted.length - 1];
        return Promise.resolve({
          data: {
            id: "m-asst",
            thread_id: row.thread_id,
            role: row.role,
            content: row.content,
            token_cost: row.token_cost,
            created_at: "2026-07-02T00:00:00Z",
          },
          error: null,
        });
      },
      insert(row: Record<string, unknown>) {
        inserted.push(row);
        return {
          select: () => ({ single: this.single.bind({ _table: table }) }),
          then: (res: (v: { error: null }) => void) => res({ error: null }),
        } as any;
      },
      then(res: (v: { count?: number; data?: unknown; error: null }) => void) {
        // Terminal for head:true count queries (cap.ts) and plain selects.
        if (table === "advisor_messages" && this._count === "exact")
          return res({ count: opts.userMessagesToday, error: null });
        return res({ data: rowsFor(table), error: null });
      },
    };
    return chain;
  }

  function rowsFor(table: string): unknown[] {
    if (table === "skills")
      return [{ id: "sk1", canonical_name: "Reading", type: "skill", onet_id: null }];
    if (table === "earner_skills") return [{ skill_id: "sk1" }];
    if (table === "credentials")
      return [{ title: "Cert", issuer_name: "Iss", verification_status: "unverified" }];
    if (table === "occupation_skills") return [];
    if (table === "advisor_messages") return []; // history load
    return [];
  }

  return { from, inserted };
}

function fakeLlm(): AdvisorLlm & { reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue({
    content: "Guidance here.",
    tokenCost: 123,
    usedWebSearch: false,
  });
  return { reply } as any;
}

test("happy path persists user + assistant rows and returns ok with token_cost", async () => {
  const db = makeFakeDb({ userMessagesToday: 0 });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as any, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "What should I learn next?",
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.message.content).toBe("Guidance here.");
    expect(res.message.tokenCost).toBe(123);
  }
  const roles = db.inserted.map((r) => r.role);
  expect(roles).toEqual(["user", "assistant"]);
  expect(db.inserted[1].token_cost).toBe(123);
  expect(llm.reply).toHaveBeenCalledTimes(1);
});

test("empty message short-circuits without calling the LLM", async () => {
  const db = makeFakeDb({ userMessagesToday: 0 });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as any, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "   ",
  });
  expect(res).toEqual({ ok: false, reason: "empty_message" });
  expect(llm.reply).not.toHaveBeenCalled();
});

test("rate-limited path never calls the LLM and spends zero tokens", async () => {
  const db = makeFakeDb({ userMessagesToday: 20 }); // == DAILY_MESSAGE_CAP
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as any, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "one more question",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("rate_limited");
  expect(llm.reply).not.toHaveBeenCalled();
  expect(db.inserted).toHaveLength(0);
});

test("missing thread returns thread_not_found without calling the LLM", async () => {
  const db = makeFakeDb({ userMessagesToday: 0, threadExists: false });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as any, llm, {
    earnerId: "e1",
    threadId: "missing",
    userMessage: "hello",
  });
  expect(res).toEqual({ ok: false, reason: "thread_not_found" });
  expect(llm.reply).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the orchestrator tests (expected PASS)**

Run: `npm test -- lib/advisor/orchestrate.test.ts`
Expected: 4 passed. (The fake DB never touches the network; the fake LLM proves the cost invariants — LLM not called on empty/rate-limited/missing-thread paths.)

- [ ] **Step 4: Commit**

```bash
git add lib/advisor/orchestrate.ts lib/advisor/orchestrate.test.ts
git commit -m "feat: runAdvisorTurn orchestrator (cap-before-LLM, in-code gaps, token_cost persisted)"
```

---

### Task 9: Server Actions (`app/app/advisor/actions.ts`)

**Files:**
- Create: `app/app/advisor/actions.ts`

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/auth/require-user`), `createServerClient` (`@/lib/supabase/server`), `createAnthropicAdvisorLlmClient` (`@/lib/advisor/llm`), `runAdvisorTurn` (`@/lib/advisor/orchestrate`), `getSkillVocabulary` (`@/lib/skills/data`), types from `@/lib/advisor/types`.
- Produces:
  ```ts
  export async function createAdvisorThread(formData: FormData): Promise<void>; // redirects to /app/advisor/[id]
  export async function listAdvisorThreads(): Promise<AdvisorThreadSummary[]>;
  export async function getAdvisorThread(threadId: string): Promise<{ thread: { id: string; title: string; targetOccupationName: string | null }; messages: AdvisorMessage[] } | null>;
  export async function sendAdvisorMessage(threadId: string, content: string): Promise<RunAdvisorTurnResult>;
  export async function setTargetOccupation(formData: FormData): Promise<void>;
  ```

- [ ] **Step 1: Write `app/app/advisor/actions.ts`**

```ts
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { createAnthropicAdvisorLlmClient } from "@/lib/advisor/llm";
import { runAdvisorTurn } from "@/lib/advisor/orchestrate";
import type {
  AdvisorMessage,
  AdvisorThreadSummary,
  RunAdvisorTurnResult,
} from "@/lib/advisor/types";

const ADVISOR = "/app/advisor";

/** Create a new thread (title = first ~40 chars of the seed message, or default) and open it. */
export async function createAdvisorThread(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const seed = String(formData.get("message") ?? "").trim();
  const title = seed ? seed.slice(0, 40) : "New conversation";
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("advisor_threads")
    .insert({ earner_id: userId, title })
    .select("id")
    .single();
  if (error || !data) redirect(`${ADVISOR}?error=create_failed`);
  revalidatePath(ADVISOR);
  redirect(`${ADVISOR}/${data!.id}`);
}

export async function listAdvisorThreads(): Promise<AdvisorThreadSummary[]> {
  await requireUserId();
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("advisor_threads")
    .select("id, title, created_at")
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((t) => ({
    id: t.id as string,
    title: t.title as string,
    createdAt: t.created_at as string,
  }));
}

export async function getAdvisorThread(threadId: string): Promise<{
  thread: { id: string; title: string; targetOccupationName: string | null };
  messages: AdvisorMessage[];
} | null> {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const { data: thread } = await supabase
    .from("advisor_threads")
    .select("id, title")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) return null;

  const { data: earner } = await supabase
    .from("earners")
    .select("target_occupation_skill_id")
    .eq("id", userId)
    .single();
  let targetOccupationName: string | null = null;
  const targetId = (earner?.target_occupation_skill_id as string | null) ?? null;
  if (targetId) {
    const { data: skill } = await supabase
      .from("skills")
      .select("canonical_name")
      .eq("id", targetId)
      .single();
    targetOccupationName = (skill?.canonical_name as string | null) ?? null;
  }

  const { data: msgs } = await supabase
    .from("advisor_messages")
    .select("id, thread_id, role, content, token_cost, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  return {
    thread: { id: thread.id as string, title: thread.title as string, targetOccupationName },
    messages: (msgs ?? []).map((m) => ({
      id: m.id as string,
      threadId: m.thread_id as string,
      role: m.role as "user" | "assistant",
      content: m.content as string,
      tokenCost: (m.token_cost as number) ?? 0,
      createdAt: m.created_at as string,
    })),
  };
}

/** The core per-message pipeline. Direct-return (not redirect) so the chat UI renders the reply. */
export async function sendAdvisorMessage(
  threadId: string,
  content: string
): Promise<RunAdvisorTurnResult> {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const result = await runAdvisorTurn(supabase, createAnthropicAdvisorLlmClient(), {
    earnerId: userId,
    threadId,
    userMessage: content,
  });
  revalidatePath(`${ADVISOR}/${threadId}`);
  return result;
}

/** Set (or clear) the durable target occupation. Validates the id is a real occupation skill. */
export async function setTargetOccupation(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const skillId = String(formData.get("skill_id") ?? "").trim() || null;
  const supabase = await createServerClient();
  if (skillId) {
    const { data: row } = await supabase
      .from("skills")
      .select("id")
      .eq("id", skillId)
      .eq("type", "occupation")
      .maybeSingle();
    if (!row) redirect(`${ADVISOR}?error=invalid_occupation`);
  }
  await supabase
    .from("earners")
    .update({ target_occupation_skill_id: skillId })
    .eq("id", userId);
  revalidatePath(ADVISOR);
  redirect(ADVISOR);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Server Actions are exercised via the live-DB integration test in Task 12 and the component tests in Task 11 stub them.)

- [ ] **Step 3: Commit**

```bash
git add app/app/advisor/actions.ts
git commit -m "feat: advisor Server Actions (thread CRUD, sendAdvisorMessage, setTargetOccupation)"
```

---

### Task 10: Advisor UI — pages, thread list, target select, disclaimer, occupation card

**Files:**
- Create: `app/app/advisor/page.tsx`, `app/app/advisor/[threadId]/page.tsx`, `app/app/advisor/loading.tsx`
- Create: `components/advisor/thread-list.tsx`, `components/advisor/target-occupation-select.tsx`, `components/advisor/disclaimer-banner.tsx`, `components/advisor/occupation-card.tsx`, `components/advisor/message-bubble.tsx`
- Create: `components/advisor/disclaimer-banner.test.tsx`, `components/advisor/occupation-card.test.tsx`, `components/advisor/thread-list.test.tsx`, `components/advisor/target-occupation-select.test.tsx`

**Interfaces:**
- Consumes: `listAdvisorThreads`/`getAdvisorThread`/`createAdvisorThread`/`setTargetOccupation` from `@/app/app/advisor/actions`; `getSkillVocabulary` from `@/lib/skills/data`; `createServerClient`; `Button`; `OccupationGap`/`AdvisorThreadSummary` types.
- Produces: the advisor route tree + presentational components (props below).

- [ ] **Step 1: Write `components/advisor/disclaimer-banner.tsx`**

```tsx
/** Persistent, non-dismissible guidance-not-guarantee banner (design doc §6 safety). Rendered
 *  independent of model output so a confused/jailbroken reply can never suppress it. */
export function DisclaimerBanner() {
  return (
    <p
      role="note"
      className="rounded-md border border-[var(--color-unverified)] bg-[var(--color-unverified)]/5 px-3 py-2 text-sm text-foreground"
    >
      Trove&apos;s advisor gives guidance based on your credentials — not a guarantee of jobs,
      admission, or financial aid.
    </p>
  );
}
```

- [ ] **Step 2: Write `components/advisor/occupation-card.tsx`**

```tsx
import type { OccupationGap } from "@/lib/advisor/types";

export function OccupationCard({
  gap,
  reliesOnUnverified = false,
}: {
  gap: OccupationGap;
  reliesOnUnverified?: boolean;
}) {
  return (
    <article className="rounded-lg border border-foreground/15 bg-white p-4">
      <h3 className="font-heading text-base font-semibold">{gap.occupationName}</h3>
      <p className="mt-1 text-sm">
        You have <strong>{gap.haveCount}</strong> of <strong>{gap.totalCount}</strong> skills (
        {gap.coveragePct}%).
      </p>
      {gap.missingSkillNames.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Missing skills">
          {gap.missingSkillNames.map((name) => (
            <li
              key={name}
              className="rounded-full border border-foreground/20 px-2 py-0.5 text-xs"
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      {reliesOnUnverified && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--color-unverified)]">
          <span aria-hidden="true">⚠</span> Based partly on an unverified credential
        </p>
      )}
    </article>
  );
}
```

- [ ] **Step 3: Write `components/advisor/message-bubble.tsx`**

```tsx
export function MessageBubble({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: string;
}) {
  const isUser = role === "user";
  return (
    <div
      role="article"
      className={
        isUser
          ? "ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-white"
          : "mr-auto max-w-[80%] rounded-lg border border-foreground/15 bg-white px-3 py-2"
      }
    >
      <span className="sr-only">{isUser ? "You said:" : "Advisor said:"}</span>
      {content}
    </div>
  );
}
```

- [ ] **Step 4: Write `components/advisor/target-occupation-select.tsx`**

```tsx
"use client";

import { useRef } from "react";
import { setTargetOccupation } from "@/app/app/advisor/actions";

export function TargetOccupationSelect({
  occupations,
  selectedId,
}: {
  occupations: { id: string; name: string }[];
  selectedId: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={setTargetOccupation} className="flex flex-col gap-1">
      <label htmlFor="target-occupation" className="text-sm font-medium">
        Target occupation
      </label>
      <select
        id="target-occupation"
        name="skill_id"
        defaultValue={selectedId ?? ""}
        onChange={() => formRef.current?.requestSubmit()}
        className="min-h-11 rounded-md border border-foreground/20 px-2"
      >
        <option value="">None set</option>
        {occupations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
```

- [ ] **Step 5: Write `components/advisor/thread-list.tsx`**

```tsx
import Link from "next/link";
import { createAdvisorThread } from "@/app/app/advisor/actions";
import { Button } from "@/components/ui/button";
import type { AdvisorThreadSummary } from "@/lib/advisor/types";

export function ThreadList({
  threads,
  activeThreadId,
}: {
  threads: AdvisorThreadSummary[];
  activeThreadId: string | null;
}) {
  return (
    <nav aria-label="Conversations" className="flex flex-col gap-2">
      <form action={createAdvisorThread}>
        <Button type="submit" variant="secondary" className="w-full">
          New conversation
        </Button>
      </form>
      <ul className="flex flex-col gap-1">
        {threads.map((t) => (
          <li key={t.id}>
            <Link
              href={`/app/advisor/${t.id}`}
              aria-current={t.id === activeThreadId ? "page" : undefined}
              className={
                "block rounded-md px-3 py-2 text-sm " +
                (t.id === activeThreadId ? "bg-foreground/10 font-medium" : "hover:bg-foreground/5")
              }
            >
              {t.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 6: Write `app/app/advisor/page.tsx`** (Server Component — thread list + target select; empty chat prompt)

```tsx
import { listAdvisorThreads } from "@/app/app/advisor/actions";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { getSkillVocabulary } from "@/lib/skills/data";
import { ThreadList } from "@/components/advisor/thread-list";
import { TargetOccupationSelect } from "@/components/advisor/target-occupation-select";
import { DisclaimerBanner } from "@/components/advisor/disclaimer-banner";

export default async function AdvisorPage() {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const [threads, vocabulary, earner] = await Promise.all([
    listAdvisorThreads(),
    getSkillVocabulary(supabase),
    supabase.from("earners").select("target_occupation_skill_id").eq("id", userId).single(),
  ]);
  const occupations = vocabulary
    .filter((s) => s.type === "occupation")
    .map((s) => ({ id: s.id, name: s.canonical_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedId = (earner.data?.target_occupation_skill_id as string | null) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:flex-row">
      <aside className="md:w-64 md:shrink-0">
        <TargetOccupationSelect occupations={occupations} selectedId={selectedId} />
        <div className="mt-4">
          <ThreadList threads={threads} activeThreadId={null} />
        </div>
      </aside>
      <main className="flex-1">
        <h1 className="font-heading text-xl font-semibold">AI advisor</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Start a conversation to explore jobs you may qualify for, what to learn next, and how to
          get there.
        </p>
        <div className="mt-4">
          <DisclaimerBanner />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Write `app/app/advisor/[threadId]/page.tsx`** (Server Component — loads thread, renders `<ChatPane>` built in Task 11)

```tsx
import { notFound } from "next/navigation";
import { listAdvisorThreads, getAdvisorThread } from "@/app/app/advisor/actions";
import { ThreadList } from "@/components/advisor/thread-list";
import { ChatPane } from "@/components/advisor/chat-pane";

export default async function AdvisorThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const [threads, loaded] = await Promise.all([
    listAdvisorThreads(),
    getAdvisorThread(threadId),
  ]);
  if (!loaded) notFound();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:flex-row">
      <aside className="md:w-64 md:shrink-0">
        <ThreadList threads={threads} activeThreadId={threadId} />
      </aside>
      <main className="flex-1">
        <h1 className="font-heading text-lg font-semibold">{loaded.thread.title}</h1>
        {loaded.thread.targetOccupationName && (
          <p className="text-sm text-foreground/70">
            Target: {loaded.thread.targetOccupationName}
          </p>
        )}
        <ChatPane threadId={threadId} initialMessages={loaded.messages} />
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Write `app/app/advisor/loading.tsx`**

```tsx
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4" role="status" aria-live="polite">
      <span className="sr-only">Loading advisor…</span>
      <div className="h-8 w-40 animate-pulse rounded bg-foreground/10" />
      <div className="mt-4 h-32 w-full animate-pulse rounded bg-foreground/5" />
    </div>
  );
}
```

- [ ] **Step 9: Write the four component tests**

`components/advisor/disclaimer-banner.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DisclaimerBanner } from "./disclaimer-banner";

test("renders the guidance-not-guarantee copy with no dismiss control", () => {
  render(<DisclaimerBanner />);
  expect(screen.getByRole("note")).toHaveTextContent(/not a guarantee/i);
  expect(screen.queryByRole("button")).toBeNull();
});
```

`components/advisor/occupation-card.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OccupationCard } from "./occupation-card";
import type { OccupationGap } from "@/lib/advisor/types";

const gap: OccupationGap = {
  occupationId: "A",
  occupationName: "Registered Nurse",
  haveSkillIds: ["s1"],
  missingSkillNames: ["Critical Thinking"],
  haveCount: 1,
  totalCount: 3,
  coveragePct: 33,
};

test("renders X of Y, missing chips, and the unverified flag only when set", () => {
  const { rerender } = render(<OccupationCard gap={gap} />);
  expect(screen.getByText(/1/)).toBeInTheDocument();
  expect(screen.getByText("Critical Thinking")).toBeInTheDocument();
  expect(screen.queryByText(/unverified credential/i)).toBeNull();

  rerender(<OccupationCard gap={gap} reliesOnUnverified />);
  expect(screen.getByText(/unverified credential/i)).toBeInTheDocument();
});
```

`components/advisor/thread-list.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/app/advisor/actions", () => ({ createAdvisorThread: vi.fn() }));
import { ThreadList } from "./thread-list";

test("renders thread titles, a New conversation CTA, and marks the active thread", () => {
  render(
    <ThreadList
      threads={[
        { id: "t1", title: "Nursing path", createdAt: "" },
        { id: "t2", title: "Next steps", createdAt: "" },
      ]}
      activeThreadId="t2"
    />
  );
  expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument();
  expect(screen.getByText("Nursing path")).toBeInTheDocument();
  expect(screen.getByText("Next steps").closest("a")).toHaveAttribute("aria-current", "page");
});
```

`components/advisor/target-occupation-select.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/app/advisor/actions", () => ({ setTargetOccupation: vi.fn() }));
import { TargetOccupationSelect } from "./target-occupation-select";

test("renders a labeled select with None set + occupation options, preselecting the target", () => {
  render(
    <TargetOccupationSelect
      occupations={[
        { id: "o1", name: "Registered Nurse" },
        { id: "o2", name: "Software Developer" },
      ]}
      selectedId="o2"
    />
  );
  const select = screen.getByLabelText(/target occupation/i) as HTMLSelectElement;
  expect(select.value).toBe("o2");
  expect(screen.getByRole("option", { name: /none set/i })).toBeInTheDocument();
});
```

- [ ] **Step 10: Run the component tests (expected PASS)**

Run: `npm test -- components/advisor/disclaimer-banner.test.tsx components/advisor/occupation-card.test.tsx components/advisor/thread-list.test.tsx components/advisor/target-occupation-select.test.tsx`
Expected: all passed.

- [ ] **Step 11: Commit**

```bash
git add app/app/advisor components/advisor/disclaimer-banner.tsx components/advisor/occupation-card.tsx components/advisor/message-bubble.tsx components/advisor/target-occupation-select.tsx components/advisor/thread-list.tsx components/advisor/*.test.tsx
git commit -m "feat: advisor route tree + thread list, target select, disclaimer, occupation card"
```

---

### Task 11: Chat pane + starter prompts (client island)

**Files:**
- Create: `components/advisor/chat-pane.tsx`, `components/advisor/starter-prompts.tsx`
- Create: `components/advisor/chat-pane.test.tsx`, `components/advisor/starter-prompts.test.tsx`

**Interfaces:**
- Consumes: `sendAdvisorMessage` from `@/app/app/advisor/actions`; `AdvisorMessage`/`OccupationGap` types; `MessageBubble`, `OccupationCard`, `DisclaimerBanner`, `StarterPrompts`, `Button`.
- Produces:
  ```tsx
  export function ChatPane({ threadId, initialMessages }: { threadId: string; initialMessages: AdvisorMessage[] }): JSX.Element;
  export function StarterPrompts({ onPick }: { onPick: (text: string) => void }): JSX.Element;
  ```

- [ ] **Step 1: Write `components/advisor/starter-prompts.tsx`**

```tsx
"use client";

import { Button } from "@/components/ui/button";

const PROMPTS = [
  "What jobs fit my skills?",
  "What should I learn next?",
  "How do I get there?",
];

export function StarterPrompts({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Suggested prompts">
      {PROMPTS.map((p) => (
        <Button key={p} type="button" variant="secondary" onClick={() => onPick(p)}>
          {p}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write `components/advisor/chat-pane.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { sendAdvisorMessage } from "@/app/app/advisor/actions";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { OccupationCard } from "@/components/advisor/occupation-card";
import { DisclaimerBanner } from "@/components/advisor/disclaimer-banner";
import { StarterPrompts } from "@/components/advisor/starter-prompts";
import type { AdvisorMessage, OccupationCard as OccupationCardData } from "@/lib/advisor/types";

type Bubble = { role: "user" | "assistant"; content: string };

export function ChatPane({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: AdvisorMessage[];
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>(
    initialMessages.map((m) => ({ role: m.role, content: m.content }))
  );
  const [cards, setCards] = useState<OccupationCardData[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(text: string) {
    const content = text.trim();
    if (!content || isPending) return;
    setNotice(null);
    setBubbles((b) => [...b, { role: "user", content }]);
    setDraft("");
    startTransition(async () => {
      const res = await sendAdvisorMessage(threadId, content);
      if (res.ok) {
        setBubbles((b) => [...b, { role: "assistant", content: res.message.content }]);
        setCards(res.occupationCards);
      } else if (res.reason === "rate_limited") {
        setNotice("You've reached today's advisor limit — more tomorrow.");
      } else if (res.reason === "empty_message") {
        setNotice("Please enter a message.");
      } else {
        setNotice("This conversation could not be found.");
      }
    });
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <DisclaimerBanner />

      {bubbles.length === 0 && <StarterPrompts onPick={submit} />}

      <div className="flex flex-col gap-2" aria-label="Conversation">
        {bubbles.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} />
        ))}
      </div>

      {cards.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((c) => (
            <OccupationCard
              key={c.gap.occupationId}
              gap={c.gap}
              reliesOnUnverified={c.reliesOnUnverified}
            />
          ))}
        </div>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? "Advisor is responding" : ""}
      </span>
      {notice && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          {notice}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="flex gap-2"
      >
        <label htmlFor="advisor-input" className="sr-only">
          Message the advisor
        </label>
        <input
          id="advisor-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isPending}
          placeholder="Ask about jobs, skills, or next steps…"
          className="min-h-11 flex-1 rounded-md border border-foreground/20 px-3"
        />
        <Button type="submit" disabled={isPending || !draft.trim()}>
          {isPending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Write `components/advisor/starter-prompts.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { StarterPrompts } from "./starter-prompts";

test("clicking a chip calls onPick with the chip's exact text", async () => {
  const onPick = vi.fn();
  render(<StarterPrompts onPick={onPick} />);
  await userEvent.click(screen.getByRole("button", { name: "What should I learn next?" }));
  expect(onPick).toHaveBeenCalledWith("What should I learn next?");
});
```

- [ ] **Step 4: Write `components/advisor/chat-pane.test.tsx`** (stubs the Server Action — zero network)

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi, beforeEach } from "vitest";

const sendAdvisorMessage = vi.fn();
vi.mock("@/app/app/advisor/actions", () => ({ sendAdvisorMessage }));

import { ChatPane } from "./chat-pane";

beforeEach(() => sendAdvisorMessage.mockReset());

test("submitting renders the user bubble, the assistant reply, and a flagged occupation card", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: true,
    message: {
      id: "m1",
      threadId: "t1",
      role: "assistant",
      content: "You may qualify for nursing roles.",
      tokenCost: 10,
      createdAt: "",
    },
    // An OccupationCard payload (gap + reliesOnUnverified). The card's amber unverified flag must
    // render, proving the flag is wired end-to-end (not a structurally-dead prop).
    occupationCards: [
      {
        gap: {
          occupationId: "A",
          occupationName: "Registered Nurse",
          haveSkillIds: ["s1"],
          missingSkillNames: ["Critical Thinking"],
          haveCount: 1,
          totalCount: 3,
          coveragePct: 33,
        },
        reliesOnUnverified: true,
      },
    ],
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.type(screen.getByLabelText(/message the advisor/i), "what next?");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText("what next?")).toBeInTheDocument();
  expect(await screen.findByText(/you may qualify for nursing roles/i)).toBeInTheDocument();
  expect(await screen.findByText(/unverified credential/i)).toBeInTheDocument();
  expect(sendAdvisorMessage).toHaveBeenCalledWith("t1", "what next?");
});

test("a rate_limited result shows an inline notice and no assistant bubble", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: false,
    reason: "rate_limited",
    retryAt: "2026-07-03T00:00:00Z",
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.type(screen.getByLabelText(/message the advisor/i), "one more");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/today's advisor limit/i);
});

test("starter prompts show when empty and submit through the same action path", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: true,
    message: { id: "m", threadId: "t1", role: "assistant", content: "ok", tokenCost: 1, createdAt: "" },
    occupationCards: [],
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.click(screen.getByRole("button", { name: "What jobs fit my skills?" }));
  expect(sendAdvisorMessage).toHaveBeenCalledWith("t1", "What jobs fit my skills?");
});
```

- [ ] **Step 5: Run the chat-pane + starter-prompts tests (expected PASS)**

Run: `npm test -- components/advisor/chat-pane.test.tsx components/advisor/starter-prompts.test.tsx`
Expected: all passed. No real Anthropic call (the action is stubbed with `vi.mock`).

- [ ] **Step 6: Commit**

```bash
git add components/advisor/chat-pane.tsx components/advisor/starter-prompts.tsx components/advisor/chat-pane.test.tsx components/advisor/starter-prompts.test.tsx
git commit -m "feat: advisor chat pane + starter prompts (optimistic UI, rate-limit notice, a11y)"
```

---

### Task 12: Hosted-DB integration tests (fake LLM only) + final verification

**Files:**
- Create: `tests/db/onet-occupation-skills.test.ts`
- Create: `tests/db/advisor.test.ts`

**Interfaces:**
- Consumes: `adminClient` / `makeUserClient` from `tests/db/*`; `runAdvisorTurn` from `@/lib/advisor/orchestrate`; a hand-written fake `AdvisorLlm`.
- Produces: end-to-end confirmation that RLS, the cap, the FK, and persistence hold against the real Postgres, with the LLM faked (the only non-real piece).

- [ ] **Step 1: Write `tests/db/onet-occupation-skills.test.ts`**

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("occupation_skills has been seeded and its FK join to skills resolves", async () => {
  const { count, error } = await admin
    .from("occupation_skills")
    .select("*", { count: "exact", head: true });
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(0);

  const { data, error: joinErr } = await admin
    .from("occupation_skills")
    .select("importance, occupation:skills!occupation_skills_occupation_id_fkey(canonical_name), skill:skills!occupation_skills_skill_id_fkey(canonical_name)")
    .limit(1);
  expect(joinErr).toBeNull();
  expect(data?.[0]).toBeTruthy();
});

test("occupation_skills is world-readable but not client-writable", async () => {
  const { client, userId } = await makeUserClient(`os-rls-${Date.now()}@example.com`);
  created.push(userId);

  const { error: readErr } = await client
    .from("occupation_skills")
    .select("occupation_id", { head: true })
    .limit(1);
  expect(readErr).toBeNull(); // read_all policy

  // pick a real (occupation, skill) pair to satisfy the FKs, then confirm the full write surface
  // (INSERT / UPDATE / DELETE) is rejected — only occupation_skills_read_all (SELECT) exists.
  const { data: occ } = await admin.from("skills").select("id").eq("type", "occupation").limit(1).single();
  const { data: sk } = await admin.from("skills").select("id").eq("type", "skill").limit(1).single();

  const { error: insertErr } = await client
    .from("occupation_skills")
    .insert({ occupation_id: occ!.id, skill_id: sk!.id, importance: 4 });
  expect(insertErr).not.toBeNull(); // no insert policy for the authenticated role

  // UPDATE against an existing seeded row (or a no-match filter) must be blocked / affect no rows.
  const { data: existing } = await admin
    .from("occupation_skills")
    .select("occupation_id, skill_id")
    .limit(1)
    .single();
  const { data: updRows, error: updErr } = await client
    .from("occupation_skills")
    .update({ importance: 1 })
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .select();
  // With no UPDATE policy, RLS either errors or silently matches zero rows — assert nothing changed.
  expect(updErr !== null || (updRows ?? []).length === 0).toBe(true);

  const { data: delRows, error: delErr } = await client
    .from("occupation_skills")
    .delete()
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .select();
  expect(delErr !== null || (delRows ?? []).length === 0).toBe(true);

  // Confirm the seeded row is untouched via the admin (RLS-bypassing) client.
  const { data: after } = await admin
    .from("occupation_skills")
    .select("importance")
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .single();
  expect(after!.importance).not.toBe(1);
});
```

- [ ] **Step 2: Write `tests/db/advisor.test.ts`**

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";
import { runAdvisorTurn } from "@/lib/advisor/orchestrate";
import type { AdvisorLlm } from "@/lib/advisor/types";
import { DAILY_MESSAGE_CAP } from "@/lib/advisor/cap";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

const fakeLlm: AdvisorLlm = {
  async reply() {
    return { content: "Some guidance.", tokenCost: 42, usedWebSearch: false };
  },
};

async function makeEarner(email: string) {
  const { client, userId } = await makeUserClient(email);
  created.push(userId);
  // earners row (RLS earners_self_insert requires id = auth.uid()).
  await client.from("earners").insert({ id: userId, handle: `h${Date.now()}${Math.random().toString(36).slice(2, 6)}` });
  return { client, userId };
}

test("runAdvisorTurn persists owner-scoped thread + user/assistant messages with token_cost", async () => {
  const { client, userId } = await makeEarner(`adv-a-${Date.now()}@example.com`);
  const { data: thread } = await client
    .from("advisor_threads")
    .insert({ earner_id: userId, title: "T" })
    .select("id")
    .single();

  const res = await runAdvisorTurn(client, fakeLlm, {
    earnerId: userId,
    threadId: thread!.id,
    userMessage: "What should I learn next?",
  });
  expect(res.ok).toBe(true);

  const { data: msgs } = await client
    .from("advisor_messages")
    .select("role, content, token_cost")
    .eq("thread_id", thread!.id)
    .order("created_at", { ascending: true });
  expect(msgs?.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs?.find((m) => m.role === "assistant")?.token_cost).toBe(42);
});

test("a second earner cannot read the first earner's thread or messages (RLS)", async () => {
  const a = await makeEarner(`adv-owner-${Date.now()}@example.com`);
  const { data: thread } = await a.client
    .from("advisor_threads")
    .insert({ earner_id: a.userId, title: "Private" })
    .select("id")
    .single();
  await runAdvisorTurn(a.client, fakeLlm, {
    earnerId: a.userId,
    threadId: thread!.id,
    userMessage: "hello",
  });

  const b = await makeEarner(`adv-intruder-${Date.now()}@example.com`);
  const { data: seenThreads } = await b.client.from("advisor_threads").select("id").eq("id", thread!.id);
  expect(seenThreads ?? []).toHaveLength(0);
  const { data: seenMsgs } = await b.client.from("advisor_messages").select("id").eq("thread_id", thread!.id);
  expect(seenMsgs ?? []).toHaveLength(0);
});

test("target_occupation_skill_id FK holds and on-delete-set-null fires", async () => {
  const { client, userId } = await makeEarner(`adv-target-${Date.now()}@example.com`);
  // create a throwaway occupation skill via admin, point the earner at it, then delete it.
  const { data: occ } = await admin
    .from("skills")
    .insert({ canonical_name: `Test Occ ${Date.now()}`, type: "occupation", onet_id: `99-${Date.now()}` })
    .select("id")
    .single();
  await client.from("earners").update({ target_occupation_skill_id: occ!.id }).eq("id", userId);
  await admin.from("skills").delete().eq("id", occ!.id);
  const { data: earner } = await client.from("earners").select("target_occupation_skill_id").eq("id", userId).single();
  expect(earner!.target_occupation_skill_id).toBeNull(); // on delete set null
});

test("the daily cap is enforced on the real table and never calls the LLM once exceeded", async () => {
  const { client, userId } = await makeEarner(`adv-cap-${Date.now()}@example.com`);
  const { data: thread } = await client
    .from("advisor_threads")
    .insert({ earner_id: userId, title: "Cap" })
    .select("id")
    .single();

  // Seed DAILY_MESSAGE_CAP user messages directly, then the next turn must be rate_limited.
  const seedRows = Array.from({ length: DAILY_MESSAGE_CAP }, () => ({
    thread_id: thread!.id,
    earner_id: userId,
    role: "user",
    content: "x",
    token_cost: 0,
  }));
  await client.from("advisor_messages").insert(seedRows);

  let llmCalls = 0;
  const countingLlm: AdvisorLlm = {
    async reply() {
      llmCalls += 1;
      return { content: "nope", tokenCost: 1, usedWebSearch: false };
    },
  };
  const res = await runAdvisorTurn(client, countingLlm, {
    earnerId: userId,
    threadId: thread!.id,
    userMessage: "one more",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("rate_limited");
  expect(llmCalls).toBe(0);
});
```

- [ ] **Step 3: Run the integration tests (expected PASS)**

Run: `npm test -- tests/db/onet-occupation-skills.test.ts tests/db/advisor.test.ts`
Expected: all passed. (Requires the `0006` migration applied and `scripts/seed-onet.mjs` run — Tasks 1–2. The LLM is faked; no real Anthropic/web-search call is made. Cleanup deletes the created auth users; FK `on delete cascade` removes their earners/threads/messages, and the throwaway occupation skill is deleted inline.)

- [ ] **Step 4: Full suite + typecheck + build**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: no type errors; all Plan 1–5 tests pass; build succeeds. Plan 5 adds: `onet-parse` (occupation-skill cases), `gaps`, `prompt`, `route-topic`, `history`, `cap`, `llm`, `orchestrate`, and the `components/advisor/*` + `tests/db/onet-occupation-skills` + `tests/db/advisor` suites.

- [ ] **Step 5: Grep guard — no test constructs the real adapter or touches the SDK / a real key**

A single literal `createAnthropicAdvisorLlmClient()` grep is too weak: it misses
`createAnthropicAdvisorLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY })` and any-args
construction, and it doesn't catch a test importing `@anthropic-ai/sdk`, calling `new Anthropic(`,
or reading `process.env.ANTHROPIC_API_KEY`. Broaden it to fail on ALL of those in test files. The
ONLY permitted SDK touch is `lib/advisor/llm.test.ts`, which injects a fake `AnthropicLike` and
never references the real key — so exclude that one file and assert it never reads the env key.

Run:
```bash
# (a) No test file anywhere constructs the advisor adapter (any args) or the extraction adapter,
#     imports the Anthropic SDK, news up Anthropic, or reads the API key.
BAD=$(grep -rnE \
  'createAnthropicAdvisorLlmClient\(|from "@anthropic-ai/sdk"|new Anthropic\(|process\.env\.ANTHROPIC_API_KEY' \
  --include="*.test.ts" --include="*.test.tsx" . \
  | grep -v '^./lib/advisor/llm.test.ts:' || true)
echo "offenders:"; echo "$BAD"
test -z "$BAD" && echo "GUARD OK: no real-API touch outside lib/advisor/llm.test.ts"

# (b) Even the one permitted SDK-adjacent test must never read the real key.
grep -n "ANTHROPIC_API_KEY" lib/advisor/llm.test.ts && echo "FAIL: llm.test.ts references the key" || echo "GUARD OK: llm.test.ts never reads ANTHROPIC_API_KEY"
```
Expected: `$BAD` is empty (`GUARD OK: no real-API touch outside lib/advisor/llm.test.ts`), and the
second grep prints `GUARD OK: llm.test.ts never reads ANTHROPIC_API_KEY`. This proves no test can
spend real tokens: every test injects a fake `AdvisorLlm`/`AnthropicLike` or stubs the Server
Action, and `route-topic.ts` is asserted purely on its boolean (no real `web_search` call anywhere).

- [ ] **Step 6: Commit**

```bash
git add tests/db/onet-occupation-skills.test.ts tests/db/advisor.test.ts
git commit -m "test: hosted-DB integration for advisor (RLS, cap, FK) with a faked LLM"
```

---

## Self-Review

**Spec coverage (Plan 5 scope = design doc §6 AI advisor per-message flow, §8 advisor UX, §9 Plan 5 = the AI advisor only — NOT the sponsor console/billing which is Plan 6):**
- §6 **context assembly** (earner_skills + verified/unverified credentials + target role + thread history): `loadAdvisorContext` (Task 7) reads `earner_skills` (Plan 2's rollup), buckets `credentials` verified/unverified **in code** from the `verification_status` enum (excludes `failed`), reads the durable `earners.target_occupation_skill_id`, and trims history via the pure `trimHistory`. ✅
- §6 **map skills to O*NET occupations + compute "you have X of Y skills" gaps IN CODE not the model:** the CRITICAL DATA GAP is closed by migration `0006` + the `parseOccupationSkillImportance` parser + the `seed-onet.mjs` extension (Tasks 1–2), and the gap is computed by the pure, deterministic `computeOccupationGaps`/`rankOccupationCandidates` (Task 4). The model receives only the finished `{haveCount, totalCount, missingSkillNames, coveragePct}` struct via `buildContextBlock` — never raw rows, never a counting request. ✅
- §6 **call Claude Sonnet with context + scoped system prompt:** `lib/advisor/llm.ts` pins `claude-sonnet-4-6` (identical literal to `lib/skills/llm.ts`), `max_tokens` 1024, injectable `AnthropicLike`; `runAdvisorTurn` passes `SYSTEM_PROMPT` + `buildContextBlock(ctx)`. ✅
- §6 **web search only for time-sensitive/external:** the pure `shouldUseWebSearch` decides in code; the `web_search` tool is passed only when true (default OFF); tested by boolean assertion, never a live tool call. ✅
- §6 **three topics unified** (jobs I qualify for / what to learn next / how to get there): the three `StarterPrompts` chips + the single system prompt cover all three through one code path. ✅
- §6 **cost controls** (server-side only; per-earner daily cap; Sonnet default; gap math in code; web search only when external; trimmed history): mapped 1:1 to Global Constraints and enforced — cap checked BEFORE any LLM call (`runAdvisorTurn` step order), and the user turn is persisted BEFORE `llm.reply` so a call that errors after the model responds still counts against the cap (no free infinite retries). The cap window is anchored to `APP_TZ` (not UTC) so it can't be doubled across the local-day boundary. Gap math pure, history tail-windowed (and forced to start with a `user` turn so the real API never 400s), web-search heuristic tightened so evergreen salary/qualification questions stay OFF, `token_cost` persisted. ✅
- §6 **safety** (guidance-not-a-guarantee; flag reliance on UNVERIFIED credentials): the `SYSTEM_PROMPT` carries both (asserted in `prompt.test.ts`); verified/unverified are labeled buckets built in code; a persistent non-dismissible `DisclaimerBanner` renders independent of model output; AND the action-guiding occupation cards carry a live `reliesOnUnverified` flag (`runAdvisorTurn` sets it from `ctx.hasUnverifiedCredentials`), so the amber unverified-reliance flag actually renders (a `chat-pane.test.tsx` case asserts it) rather than being a structurally-dead prop. ✅
- §8 **advisor UX** (clean chat, suggested starter prompts, inline occupation cards, plain language, WCAG-AA, mobile-first): `ChatPane` + `StarterPrompts` + `OccupationCard` + `MessageBubble`, `aria-live` pending region, `role="alert"` notices, real `<label>`s, 44×44px `Button`, thread list collapsing below `md:`, ~6th–8th-grade copy. ✅
- §9 **Plan 5 boundary:** advisor only. Explicitly NOT the sponsor console/billing (Plan 6) — no sponsor/Stripe surface touched. ✅

**Deferred / flagged (stated so they aren't silently dropped):**
- **Token streaming is OUT of v1.** `sendAdvisorMessage` returns the full reply in one round-trip (Sonnet, `max_tokens` 1024, short replies). Streaming would need a route handler (none exist in this repo); defer to a later plan if latency bites. (Task 9/11.)
- **LLM-based history summarization is OUT of v1** — `trimHistory` is a tail-window (avoids a second paid call to shrink context); upgrade to real summarization later if threads grow long. (Task 5.)
- **`reliesOnUnverified` on occupation cards is a CONSERVATIVE per-earner flag in v1, not a per-skill provenance join.** The card flag is now actually wired (not dead UI): `runAdvisorTurn` sets `reliesOnUnverified = ctx.hasUnverifiedCredentials` on every returned `OccupationCard`, so the amber "based partly on an unverified credential" flag renders whenever the earner has ANY unverified credential — satisfying design doc §6's mandate to flag unverified reliance at the action-guiding surface, not only in prose. The refinement to per-skill credential→skill provenance (flag ONLY the cards whose held skills actually derive from an unverified credential) is deferred; `gaps.ts` stays credential-status-agnostic by design, and the conservative over-flag is the safe direction (it never hides an unverified dependency). (Tasks 3/8/10/11.)
- **Rate limiting is count-based over `advisor_messages`, not a separate counter table + RPC.** Simpler, no extra migration surface, no PostgREST-transaction complications; a race could in theory admit one extra message under heavy concurrency, which is acceptable for a soft cost cap at pilot scale. (Task 7.)
- **Candidate occupation ranking when no target is set** loads the full `occupation_skills` table (single-digit-thousands rows, one indexed read) and ranks in code; fine at v1 scale. Keyset pagination / a top-N filtered candidate query is a later concern (same `TODO` already noted in `getSkillVocabulary`). The per-turn re-fetch of the skills vocabulary (`getSkillVocabulary`, ~700 RLS-scoped rows) and the full `occupation_skills` read on the no-target path are the two known per-message DB-egress amplifiers; both are RLS-scoped session reads, acceptable at pilot scale, and could be cached later without a schema change. (Task 7.)
- **`occupation_skills` does not enforce the occupation-type invariant in the schema (accepted v1 trade-off).** Both `occupation_id` and `skill_id` reference the generic `skills(id)`; nothing at the DB level restricts `occupation_id` to `type='occupation'` rows or `skill_id` to `type in ('skill','competency')`. The invariant is enforced BY CONSTRUCTION: the seed only inserts occupation→skill Element-ID pairs, and `setTargetOccupation` (Task 9) validates `type='occupation'` in code before writing `earners.target_occupation_skill_id`. A future bad manual insert could violate it undetected; if stronger guarantees are wanted later, add a trigger validating `skills.type` on insert into `occupation_skills`. Documented here so no executor assumes the FK enforces the type invariant. (Tasks 1/9.)

**Placeholder scan:** No "similar to Task N" / "add error handling" / elided-body placeholders. Every code step shows complete, final code; every test step states the exact command + expected outcome. The one migration (`0006`) is fully written; no other schema change is needed (advisor conversation tables + their RLS already exist). ✅

**Type consistency (verified across tasks):**
- The Plan-5 type set is defined once in `lib/advisor/types.ts` (Task 3) and imported via `@/lib/advisor/types`. `AdvisorLlm` is the single injected boundary (adapter in Task 6, fakes in Tasks 8/11/12).
- `OccupationGap` is produced by `computeOccupationGaps` (Task 4), consumed by `buildContextBlock` (Task 5) and `loadAdvisorContext` (Task 7); the orchestrator wraps each gap in an `OccupationCard { gap, reliesOnUnverified }` (Task 3 type) for `runAdvisorTurn`'s `occupationCards` (Task 8), which flows unchanged through `sendAdvisorMessage`'s return (Task 9) into `ChatPane` (Task 11), which passes `gap` + `reliesOnUnverified` to the presentational `OccupationCard` component (Task 10) — one shape end to end.
- `RunAdvisorTurnResult` is identical in `orchestrate.ts` (producer), `actions.ts`'s `sendAdvisorMessage` (pass-through), and `ChatPane` (consumer switches on `ok`/`reason`).
- SQL names match verbatim: `occupation_skills(occupation_id, skill_id, importance)`, `earners.target_occupation_skill_id`, `advisor_messages(thread_id, earner_id, role, content, token_cost, created_at)` from `0002_core_schema.sql`, and `verification_status` values (`verified`/`unverified`/`failed`) from the enum.
- Plan 2 composition is by reference only: `getSkillVocabulary` from `@/lib/skills/data` and the `earner_skills` shape are consumed unmodified; `lib/skills/onet-parse.ts` gains one additive export with no change to existing parsers. ✅

**Cost / safety-invariants scan:**
- **No real Anthropic / web-search in tests:** every test injects a fake `AdvisorLlm` (`llm.test.ts` injects a fake `AnthropicLike`; `orchestrate.test.ts`/`advisor.test.ts` inject a fake `AdvisorLlm`; `cap.test.ts` injects a fake `db`; component tests `vi.mock` the Server Action). `route-topic.ts` is asserted on its boolean output only — no live `web_search` call anywhere. The broadened grep guard (Task 12 Step 5) fails on ANY test that constructs `createAnthropicAdvisorLlmClient(` (any args), imports `@anthropic-ai/sdk`, calls `new Anthropic(`, or reads `process.env.ANTHROPIC_API_KEY` — the only permitted SDK touch is `lib/advisor/llm.test.ts` (fake `AnthropicLike`, never the real key). ✅
- **Daily cap before any paid call, APP_TZ-anchored, retry-proof:** `runAdvisorTurn` runs `checkDailyMessageCap` before `llm.reply`, and persists the user turn between the two so a post-response error still counts (no free retries). The window floors on the `APP_TZ` day, not UTC (a doubled window would break the cost ceiling); `cap.test.ts` asserts the 23:59-vs-00:01 local boundary lands in the right day and the `underCap = sentToday < cap` semantics. Unit (Task 8), pure (Task 7 `cap.test.ts`), and live-DB (Task 12) tests all assert the LLM is never called when capped (`llmCalls === 0`). ✅
- **Gap math in code, deterministic:** `gaps.test.ts` proves coverage %, the minOverlap filter, the divide-by-zero guard, and order-independence. The model never computes gaps. ✅
- **Server-side only + no secrets:** all Anthropic construction is inside `lib/advisor/llm.ts`, invoked only from `"use server"` actions; `ANTHROPIC_API_KEY` never crosses to the client; no `NEXT_PUBLIC_` key exposure. ✅
- **token_cost recorded:** the assistant `advisor_messages` insert persists `reply.tokenCost`; asserted in both the fake-DB unit test and the live-DB integration test. ✅
- **Guidance-not-guarantee + unverified flagging:** enforced in the system prompt (asserted), in code-bucketed context lists, and in the always-on UI disclaimer. ✅

**Known environmental dependencies:** Task 1's migration and Task 12's integration tests require the hosted Supabase project reachable + `.env.local` populated; Task 12 also requires the O*NET seed (Task 2) to have run so `occupation_skills` has rows. No test requires `ANTHROPIC_API_KEY` (fake `AdvisorLlm` injected everywhere) or reaches a real web-search endpoint — CI stays at zero LLM/web-search spend, consistent with Plans 1–4. **No new runtime dependencies** are added.
