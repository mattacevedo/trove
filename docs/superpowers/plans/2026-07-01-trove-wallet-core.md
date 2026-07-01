# Trove Wallet Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Trove **wallet core** (Plan 3) — the end-to-end loop that turns a credential into a displayed, skills-enriched wallet card. An earner adds a credential three ways — **OB/VC by URL**, **file upload** (raw OB JSON or a "baked" PNG/SVG badge with an embedded assertion), or **manual entry** — and Trove: parses the credential envelope into the `credentials` columns, stores any uploaded file in a private Supabase Storage bucket, sets an honest `verification_status` (`verified`/`unverified`/`failed`), calls Plan 2's `processCredential` to extract + normalize + roll up skills, and renders the credential in the earner's **My Wallet** card grid with a prominent "Add credential" CTA. Every parse/verify/roll-up helper is a pure or dependency-injected function so no unit test touches the network or a paid LLM.

**Architecture:** A strict **pure-core / impure-shell** split under `lib/credentials/`, mirroring `lib/skills/`'s conventions exactly (DI'd `SupabaseClient` first argument like `provisionEarner` and Plan 2's `data.ts`; DI'd `fetch`/`llm`; `@/` import alias; Vitest; `tests/db/*` helpers for hosted-DB integration). The credential subsystem has three pure transforms (`parse-ob` = envelope → `{title, issuerName, issuedDate, description}`; `extract-baked-badge` = image bytes → embedded assertion JSON; `verify` detection helpers), one impure verifier shell (`verify.ts`'s network fetch, DI'd), one impure storage adapter (`storage.ts`, the only module touching Supabase Storage), and one impure orchestrator (`create.ts` → `createCredentialAndProcess`) that the three **Server Actions** (`app/app/wallet/actions.ts`) call. The orchestrator is a pure consumer of Plan 2's already-shipped public surface — `processCredential(db, llm, credentialId)` from `@/lib/skills/index.ts` and `createAnthropicLlmClient()` from `@/lib/skills/llm.ts` — modifying neither. The UI is a Server-Component wallet grid (`app/app/page.tsx`) plus one Client-Component "Add credential" island (a hand-rolled focus-trapped modal with three tabbed forms), following Plan 1's minimal-dependency, WCAG-AA, mobile-first conventions. A single new migration (`0004_credential_storage.sql`) creates the private bucket + path-scoped Storage RLS, applied via the existing Management-API script.

**Tech Stack:** TypeScript, `@supabase/supabase-js` + `@supabase/ssr` (already installed), `@anthropic-ai/sdk` (installed in Plan 2), **`jose`** (new — RFC 7515/7519 JWS/JWT verification for OB3.0/VC, pure JS, WebCrypto-based, zero native deps), `multiformats` (new — small; base58btc + multicodec decode for the `did:key` → JWK helper the JWT verifier needs), React 19 + Next.js 16 (Server Actions, Server Components), Vitest + `@testing-library/react` for unit/component/integration tests. No PNG library — the baked-badge iTXt/tEXt chunk reader is hand-rolled (documented binary format), matching how `lib/skills/onet-parse.ts` hand-rolls its tab parser.

## Global Constraints

Every task's requirements implicitly include these (binding, from the spec and Plans 1–2):

- **Product name:** Trove. Domain: trove.io.
- **Stack (do not substitute):** Next.js + Supabase (Postgres/RLS/Auth/Storage) + Vercel + Stripe + Postmark + **Claude Sonnet 4.6**. Model id for all AI work: `claude-sonnet-4-6`, reached ONLY through `lib/skills/llm.ts`'s `createAnthropicLlmClient()`. Opus only if a specific later task needs it (none here). Plan 3 never constructs prompts or calls the model directly — it delegates all AI to Plan 2's `processCredential`.
- **AI is server-side only.** The `ANTHROPIC_API_KEY` never reaches the client and is never referenced outside Plan 2. Server Actions run server-side; no `NEXT_PUBLIC_` exposure of any key.
- **Cost-conscious ("not rich"):** Plan 3 adds no new model calls — it invokes `processCredential` exactly once per created credential, which is itself structured-first + content-hash cached (Plan 2). Verification is a plain HTTP fetch (OB2.x) or pure crypto (`jose`, no network for `did:key`); no LLM is used for verification or parsing.
- **Migrations:** applied to the hosted Supabase project by POSTing SQL to the **Management API** via `node scripts/apply-migration.mjs <file>` (NOT `supabase db push`), numbered sequentially. The last committed migration is `0003_rls_policies.sql`; this plan adds exactly one, `supabase/migrations/0004_credential_storage.sql` (the Storage bucket + path-scoped `storage.objects` RLS). No other schema change is needed — the `credentials` columns and `verification_status` enum already exist in `0002_core_schema.sql`.
- **No secrets in git.** `.env.local` is git-ignored and already populated (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
- **Reuse Plan 1 + Plan 2, do not fork:** import UI reuses `components/ui/button.tsx` (`Button`, variants `primary`/`secondary`/`ghost`, already 44×44px via `min-h-11 min-w-11`) and `components/verification-badge.tsx` (`VerificationBadge`, status `verified`/`unverified`/`failed`, icon+text). Auth pattern mirrors `app/login/actions.ts` (`"use server"`, `createServerClient()`, FormData in, `redirect` out) and `app/app/layout.tsx` (`getUser()` → `redirect("/login")`). Skills enrichment is Plan 2's `processCredential` — consumed unmodified.
- **Server Actions run under the earner's own session client** (`createServerClient()` from `lib/supabase/server.ts`, anon-key + cookies), NOT service-role. RLS is the actual enforcement layer; `credentials_owner_all` / `credential_skills_owner_all` / `earner_skills_owner_all` (`0003_rls_policies.sql`) already permit an earner's own rows. The insert always sets `earner_id: user.id` server-side (never trust a client value) — defense in depth. No service-role client is ever used in a request-serving path.
- **WCAG AA + mobile-first (non-negotiable):** 4.5:1 contrast, visible focus rings, full keyboard nav, 44×44px targets, real `<label>`s, `role="alert"`/`role="status"` live regions, `prefers-reduced-motion` (already handled in `app/globals.css`). The wallet + Add-credential flow must excel at 375px. Verification state is always unmissable (`VerificationBadge`, never color alone).
- **Vitest serial config unchanged:** `vitest.config.ts` runs `fileParallelism:false`, `pool:"forks"` (iCloud path constraint). Do not change it.
- **Mirror existing test patterns:** colocated `*.test.ts(x)` beside pure source (zero network/LLM/DB — inject `fetch`/`llm`/action stubs); hosted-DB integration tests under `tests/db/` use `adminClient()` (service-role, bypasses RLS) or `makeUserClient()` (RLS-scoped session) from `tests/db/*`, cleaning up with `admin.auth.admin.deleteUser(id)` in `afterAll` (FK `on delete cascade` from `0002_core_schema.sql` removes dependent `credentials`/`credential_skills`/`earner_skills`). Storage objects are NOT FK-cascaded — integration tests that upload must explicitly remove objects in `afterAll`. **No test calls the real Anthropic API** (inject a fake `LlmClient` as `lib/skills/*` tests already do) and **no test calls a real issuer URL** (inject `fetch`).
- **Verification honesty (spec §5):** three states only. `verified` = OB2.x hosted assertion re-fetched, not revoked, AND identity-matched (the re-fetched document's `id` equals the stored assertion's `id`), or an OB3.0/VC signature cryptographically verified. `unverified` = manual entries, any credential whose verification mechanism is out of v1 scope / not attemptable, OR a hosted assertion that is reachable but carries no `id` to prove identity against (reachable ≠ verified). `failed` = a mechanism was attempted and did NOT pass (fetch error, revoked, id mismatch, bad/expired signature). A totally unfetchable/unparseable `ob_url` never becomes a row at all (nothing to store); a stored-but-degraded file/URL credential still lands in the wallet, honestly `unverified`.

---

## File Structure

Files created/modified in this plan and their single responsibility:

- `package.json` / `package-lock.json` — MODIFIED: add `jose` + `multiformats` dependencies
- `lib/credentials/types.ts` — CREATE: all shared Plan-3 types; the only module every other `lib/credentials/*` file may import from; zero SDK imports
- `lib/credentials/parse-ob.ts` — CREATE: pure `parseOpenBadge(rawJson): ParsedCredential` — normalizes OB2.x Assertion+BadgeClass / OB3.0 VC `credentialSubject.achievement` / generic VC into `{title, issuerName, issuedDate, description}`; reuses the shape-detection idioms proven in `lib/skills/extract.ts`
- `lib/credentials/extract-baked-badge.ts` — CREATE: pure `extractBakedAssertion(buffer, mime)` — scans a PNG `iTXt`/`tEXt` chunk keyed `openbadges`, or an SVG `<openbadges:assertion>` element / base64 `verify` attribute; best-effort, returns `null` when nothing embedded (never throws)
- `lib/credentials/verify.ts` — CREATE: impure shell; pure detection helpers (`detectHostedVerify`, `detectJwt`) + DI'd-`fetch` `verifyCredential(input, opts)` — OB2.x hosted re-fetch + OB3.0/VC JWT (`jose`, `did:key` only); everything else honest `unverified`/`failed`
- `lib/credentials/did-key.ts` — CREATE: pure `didKeyToPublicJwk(verificationMethod): JWK | null` — decodes a `did:key:z…` Ed25519 multibase key to a JWK for `jose`; `multiformats` for base58btc/multicodec; the ONE small in-repo crypto helper
- `lib/credentials/storage.ts` — CREATE: impure; the ONLY module touching Supabase Storage; DI'd `db` first arg; `uploadCredentialFile` / `getSignedFileUrl`
- `lib/credentials/create.ts` — CREATE: impure orchestrator `createCredentialAndProcess(db, llm, input)` — derives fields, uploads file, inserts the `credentials` row, verifies, updates status, calls Plan 2's `processCredential` (swallowing skills failures); the one function all three Server Actions call
- `app/app/wallet/actions.ts` — CREATE: the three Server Actions (`"use server"`) `importByUrl` / `importByFile` / `importManual`, plus `reverifyCredential`; parse+validate FormData, auth, delegate to `create.ts`, `revalidatePath`, redirect/return
- `app/app/wallet/import/page.tsx` — CREATE: the "Add credential" route (Server Component shell) rendering the tabbed client dialog inline; reads `searchParams.error` for degraded-JS inline messages
- `app/app/page.tsx` — MODIFY: My Wallet — RLS-scoped `credentials` fetch → `EmptyWalletState` | `CredentialGrid`; always renders `<AddCredentialLauncher />`
- `app/app/loading.tsx` — CREATE: skeleton for the wallet RSC data-fetch suspense boundary
- `components/credential-card.tsx` — CREATE: Server Component card (`<li>`) — title, issuer, formatted date, `<VerificationBadge>`, `<ReverifyButton>`
- `components/credential-grid.tsx` — CREATE: Server Component responsive `<ul>` grid of cards
- `components/empty-wallet-state.tsx` — CREATE: Server Component empty state + Add-credential CTA
- `components/add-credential/add-credential-launcher.tsx` — CREATE: Client island — CTA button + focus-trapped `<AddCredentialDialog>`
- `components/add-credential/add-credential-dialog.tsx` — CREATE: Client hand-rolled accessible modal + 3-tab (`URL`/`File`/`Manual`) tablist
- `components/add-credential/import-by-url-form.tsx` — CREATE: Client URL form (`useActionState`)
- `components/add-credential/import-by-file-form.tsx` — CREATE: Client file form (client pre-check)
- `components/add-credential/import-manual-form.tsx` — CREATE: Client manual form
- `components/reverify-button.tsx` — CREATE: Client per-card re-verify (`useTransition`, `aria-live`)
- `supabase/migrations/0004_credential_storage.sql` — CREATE: private `credential-files` bucket + path-scoped `storage.objects` RLS
- `lib/credentials/parse-ob.test.ts` — CREATE: pure unit tests for envelope parsing
- `lib/credentials/extract-baked-badge.test.ts` — CREATE: pure unit tests (hand-built PNG/SVG fixtures)
- `lib/credentials/verify.test.ts` — CREATE: pure detection + injected-`fetch` + real-crypto JWT tests
- `lib/credentials/did-key.test.ts` — CREATE: pure round-trip test (generate key → did:key → JWK)
- `components/credential-card.test.tsx`, `components/credential-grid.test.tsx`, `components/empty-wallet-state.test.tsx`, `components/add-credential/add-credential-launcher.test.tsx`, `components/add-credential/import-manual-form.test.tsx`, `components/reverify-button.test.tsx` — CREATE: component tests (Testing Library, action stubs, zero network)
- `tests/db/credentials-import.test.ts` — CREATE: hosted-DB integration — `createCredentialAndProcess` (manual) creates row + `earner_skills`; skills failure never rolls back the row
- `tests/db/credential-storage-rls.test.ts` — CREATE: hosted-DB integration — earner B cannot read earner A's uploaded file

---

### Task 1: Shared types + `jose`/`multiformats` dependencies

**Files:**
- Create: `lib/credentials/types.ts`
- Modify: `package.json` (add `jose`, `multiformats`)

**Interfaces:**
- Consumes: nothing (foundation task for Plan 3)
- Produces (the canonical type set every later Plan-3 module imports from `@/lib/credentials/types`):
  ```ts
  export type VerificationStatus = "verified" | "unverified" | "failed";
  export type CredentialSource = "ob_url" | "ob_file" | "manual"; // matches credential_source enum
  export type VerificationMethod = "ob2_hosted" | "vc_jwt" | "none";

  export interface ParsedCredential {
    title: string;
    issuerName: string;
    issuedDate: string | null; // ISO yyyy-mm-dd or null
    description: string;
  }

  export interface VerifyInput { source: CredentialSource; raw_json: unknown; }
  export interface VerifyResult {
    status: VerificationStatus;
    method: VerificationMethod;
    detail: string;
  }
  export interface VerifyOpts { fetchImpl?: typeof fetch; clock?: () => Date; }

  export type NewCredentialInput =
    | { earnerId: string; source: "ob_url"; raw_json: unknown; sourceUrl: string }
    | { earnerId: string; source: "ob_file"; fileBuffer: Buffer; fileMime: string; fileName: string }
    | { earnerId: string; source: "manual"; manual: { title: string; issuerName: string; issuedDate: string | null; description: string } };

  export interface CreateCredentialResult { credentialId: string; verificationStatus: VerificationStatus; }
  ```

- [ ] **Step 1: Install the verification dependencies**

```bash
npm install jose multiformats
```

Expected: `jose` and `multiformats` appear under `"dependencies"` in `package.json`.

- [ ] **Step 2: Write `lib/credentials/types.ts`**

```ts
// Shared types for the Trove wallet-core (Plan 3). This is the ONLY module every other
// lib/credentials/* file may import from. It imports nothing from the Supabase, Anthropic,
// or jose SDKs — keeping the pure core dependency-free and unit-testable.

/** The three honest verification states (matches the verification_status enum, 0002_core_schema.sql). */
export type VerificationStatus = "verified" | "unverified" | "failed";

/** Matches the credential_source enum in 0002_core_schema.sql. */
export type CredentialSource = "ob_url" | "ob_file" | "manual";

/** Which mechanism produced a VerifyResult (for diagnostics / detail strings). */
export type VerificationMethod = "ob2_hosted" | "vc_jwt" | "none";

/** Normalized credential envelope, mapped onto the credentials columns. */
export interface ParsedCredential {
  title: string;
  issuerName: string;
  issuedDate: string | null; // ISO yyyy-mm-dd or null
  description: string;
}

export interface VerifyInput {
  source: CredentialSource;
  raw_json: unknown;
}

export interface VerifyResult {
  status: VerificationStatus;
  method: VerificationMethod;
  detail: string;
}

/** fetch + clock are injectable so unit tests never touch the network or wall-clock time. */
export interface VerifyOpts {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

/** Discriminated union describing one import attempt. Built by the Server Actions. */
export type NewCredentialInput =
  | { earnerId: string; source: "ob_url"; raw_json: unknown; sourceUrl: string }
  | {
      earnerId: string;
      source: "ob_file";
      fileBuffer: Buffer;
      fileMime: string;
      fileName: string;
    }
  | {
      earnerId: string;
      source: "manual";
      manual: {
        title: string;
        issuerName: string;
        issuedDate: string | null;
        description: string;
      };
    };

export interface CreateCredentialResult {
  credentialId: string;
  verificationStatus: VerificationStatus;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors (types-only module, nothing references it yet).

- [ ] **Step 4: Commit**

```bash
git add lib/credentials/types.ts package.json package-lock.json
git commit -m "feat: wallet-core shared types and jose/multiformats deps"
```

---

### Task 2: Parse the OB/VC envelope (pure)

**Files:**
- Create: `lib/credentials/parse-ob.ts`, `lib/credentials/parse-ob.test.ts`

**Interfaces:**
- Consumes: `ParsedCredential` from `@/lib/credentials/types`
- Produces:
  ```ts
  export function parseOpenBadge(rawJson: unknown): ParsedCredential; // pure, sync, never throws
  ```
  Maps OB2.x Assertion (`badge.name`/`badge.description`/`issuedOn`/`badge.issuer.name`), OB2.x BadgeClass (`name`/`description`/`issuer.name`), OB3.0/VC (`name` or `credentialSubject.achievement.name`/`.description`, `issuer.name`, `issuanceDate`/`validFrom`) into `{title, issuerName, issuedDate, description}`. Unrecognized/garbage input returns a safe empty-ish shape (`title:""`, `issuerName:""`, `issuedDate:null`, `description:""`) rather than throwing — the caller decides whether an empty title blocks creation.

- [ ] **Step 1: Write the failing tests `lib/credentials/parse-ob.test.ts`**

```ts
import { expect, test } from "vitest";
import { parseOpenBadge } from "./parse-ob";

test("OB2.x Assertion pulls name/description/date from nested badge + issuedOn", () => {
  const raw = {
    type: "Assertion",
    issuedOn: "2024-05-01T00:00:00Z",
    badge: {
      name: "Welding Level 1",
      description: "Basic MIG welding.",
      issuer: { name: "Acme Trade School" },
    },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Welding Level 1",
    issuerName: "Acme Trade School",
    issuedDate: "2024-05-01",
    description: "Basic MIG welding.",
  });
});

test("OB2.x BadgeClass reads top-level name/description/issuer, no date", () => {
  const raw = {
    type: "BadgeClass",
    name: "Data Literacy",
    description: "Reading charts and tables.",
    issuer: { name: "OpenU" },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Data Literacy",
    issuerName: "OpenU",
    issuedDate: null,
    description: "Reading charts and tables.",
  });
});

test("OB3.0/VC reads credentialSubject.achievement + issuer.name + issuanceDate", () => {
  const raw = {
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuanceDate: "2025-01-15T12:00:00Z",
    issuer: { id: "did:web:issuer.example", name: "Future State College" },
    credentialSubject: {
      achievement: {
        name: "Project Management",
        description: "Plan, schedule, deliver.",
      },
    },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Project Management",
    issuerName: "Future State College",
    issuedDate: "2025-01-15",
    description: "Plan, schedule, deliver.",
  });
});

test("VC validFrom is used when issuanceDate is absent; issuer may be a bare string", () => {
  const raw = {
    validFrom: "2026-03-09",
    issuer: "Standalone Issuer",
    credentialSubject: { achievement: { name: "Time Management" } },
  };
  const out = parseOpenBadge(raw);
  expect(out.issuedDate).toBe("2026-03-09");
  expect(out.issuerName).toBe("Standalone Issuer");
  expect(out.title).toBe("Time Management");
  expect(out.description).toBe("");
});

test("achievement may be an array — first entry drives title/description", () => {
  const raw = {
    credentialSubject: {
      achievement: [
        { name: "Customer Service", description: "Help customers." },
        { name: "Scheduling" },
      ],
    },
  };
  const out = parseOpenBadge(raw);
  expect(out.title).toBe("Customer Service");
  expect(out.description).toBe("Help customers.");
});

test("null / non-object / unrecognized input returns a safe empty shape (never throws)", () => {
  const empty = { title: "", issuerName: "", issuedDate: null, description: "" };
  expect(parseOpenBadge(null)).toEqual(empty);
  expect(parseOpenBadge("not json")).toEqual(empty);
  expect(parseOpenBadge({ foo: "bar" })).toEqual(empty);
});

test("an empty title is the guard predicate: unrecognized envelopes yield no title", () => {
  // importByUrl / importByFile use `!parseOpenBadge(raw).title` as the "don't persist a garbage
  // row" guard. Assert that a valid-JSON-but-unrelated object and an empty object both fail it,
  // while a real OB envelope passes it — locking the invariant the Server Actions depend on.
  expect(parseOpenBadge({}).title).toBe("");
  expect(parseOpenBadge({ status: "ok" }).title).toBe("");
  expect(parseOpenBadge({ type: "BadgeClass", name: "Real", issuer: { name: "I" } }).title).toBe(
    "Real"
  );
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/credentials/parse-ob.test.ts`
Expected: FAIL — `lib/credentials/parse-ob.ts` does not exist.

- [ ] **Step 3: Write `lib/credentials/parse-ob.ts`**

```ts
import type { ParsedCredential } from "@/lib/credentials/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Accept an issuer that is either a { name } object or a bare string. */
function issuerName(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  return rec ? str(rec.name) : "";
}

/** Normalize an ISO datetime or date to yyyy-mm-dd; null when absent/unparseable. */
function isoDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Pure envelope parser across OB2.x (Assertion / BadgeClass) and OB3.0/VC shapes.
 * Returns a safe empty-ish ParsedCredential for anything unrecognized — never throws.
 */
export function parseOpenBadge(rawJson: unknown): ParsedCredential {
  const empty: ParsedCredential = {
    title: "",
    issuerName: "",
    issuedDate: null,
    description: "",
  };
  const root = asRecord(rawJson);
  if (!root) return empty;

  // OB2.x Assertion: name/description live under badge; date is issuedOn.
  const badge = asRecord(root.badge);
  if (badge) {
    return {
      title: str(badge.name),
      issuerName: issuerName(badge.issuer),
      issuedDate: isoDate(root.issuedOn),
      description: str(badge.description),
    };
  }

  // OB3.0 / VC: credentialSubject.achievement (object or array).
  const subject = asRecord(root.credentialSubject);
  if (subject) {
    const achievementRaw = subject.achievement;
    const achievement = Array.isArray(achievementRaw)
      ? asRecord(achievementRaw[0])
      : asRecord(achievementRaw);
    if (achievement) {
      return {
        title: str(achievement.name) || str(root.name),
        issuerName: issuerName(root.issuer),
        issuedDate: isoDate(root.issuanceDate) ?? isoDate(root.validFrom),
        description: str(achievement.description),
      };
    }
  }

  // OB2.x BadgeClass (or a flat VC with top-level name).
  if (str(root.name)) {
    return {
      title: str(root.name),
      issuerName: issuerName(root.issuer),
      issuedDate:
        isoDate(root.issuedOn) ??
        isoDate(root.issuanceDate) ??
        isoDate(root.validFrom),
      description: str(root.description),
    };
  }

  return empty;
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/credentials/parse-ob.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/credentials/parse-ob.ts lib/credentials/parse-ob.test.ts
git commit -m "feat: pure OB2.x/OB3.0/VC credential-envelope parser"
```

---

### Task 3: Extract baked assertions from PNG/SVG (pure)

> **Format note.** OB2.0 "baked" badges embed the assertion JSON either in a PNG `iTXt`/`tEXt`
> chunk keyed `openbadges` (spec: https://www.imsglobal.org/openbadges/baked), or in an SVG
> `<openbadges:assertion>` element / a base64 `verify` attribute. This parser is deliberately
> best-effort for v1: it scans the documented chunk/element structure directly (no PNG library)
> and returns `null` — never throws — when nothing parseable is found, so the caller falls back
> to storing the file `unverified` with `raw_json: null`. Both `iTXt` and `tEXt` are covered
> because real-world exports use both.

**Files:**
- Create: `lib/credentials/extract-baked-badge.ts`, `lib/credentials/extract-baked-badge.test.ts`

**Interfaces:**
- Consumes: nothing (pure, self-contained)
- Produces:
  ```ts
  export function extractBakedAssertion(
    buffer: Buffer,
    mime: "image/png" | "image/svg+xml"
  ): unknown | null; // parsed JSON assertion, or null when none embedded / unparseable
  ```

- [ ] **Step 1: Write the failing tests `lib/credentials/extract-baked-badge.test.ts`**

```ts
import { expect, test } from "vitest";
import { extractBakedAssertion } from "./extract-baked-badge";

// --- Hand-build a minimal PNG with one iTXt chunk keyed "openbadges" ---
// We do NOT need a valid image — only the chunk framing the parser scans.
// Chunk layout: 4-byte big-endian length | 4-byte type | data | 4-byte CRC.
// iTXt data: keyword \0 compressionFlag(1) compressionMethod(1) langTag \0
//            translatedKeyword \0 text
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); // parser ignores CRC; zeros are fine
  return Buffer.concat([len, typeBuf, data, crc]);
}

function iTXtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0]), // null after keyword
    Buffer.from([0]), // compression flag (0 = uncompressed)
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    Buffer.from(text, "utf8"),
  ]);
  return chunk("iTXt", data);
}

function tEXtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0]), // null separator
    Buffer.from(text, "latin1"),
  ]);
  return chunk("tEXt", data);
}

const ASSERTION = { type: "Assertion", badge: { name: "Baked Badge" } };

test("extracts an assertion from a PNG iTXt chunk keyed 'openbadges'", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    iTXtChunk("openbadges", JSON.stringify(ASSERTION)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toEqual(ASSERTION);
});

test("extracts an assertion from a PNG tEXt chunk keyed 'openbadges'", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    tEXtChunk("openbadges", JSON.stringify(ASSERTION)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toEqual(ASSERTION);
});

test("PNG with no openbadges chunk returns null", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    iTXtChunk("Description", "just a picture"),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toBeNull();
});

test("compressed iTXt (compressionFlag=1) is unsupported in v1 -> null (documents the boundary)", () => {
  // Real production baked PNGs sometimes zlib-compress the iTXt payload. v1 does not inflate it;
  // it returns null so the caller stores the image honestly `unverified` rather than crashing.
  const data = Buffer.concat([
    Buffer.from("openbadges", "ascii"),
    Buffer.from([0]), // null after keyword
    Buffer.from([1]), // compression flag = 1 (COMPRESSED — unsupported)
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    Buffer.from([0x78, 0x9c, 0x01], "latin1"), // bogus "compressed" bytes; must not be parsed
  ]);
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    chunk("iTXt", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toBeNull();
});

test("extracts an assertion from an SVG <openbadges:assertion> element", () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="http://openbadges.org">` +
    `<openbadges:assertion verify="x">${JSON.stringify(ASSERTION)}</openbadges:assertion>` +
    `</svg>`;
  expect(extractBakedAssertion(Buffer.from(svg, "utf8"), "image/svg+xml")).toEqual(
    ASSERTION
  );
});

test("SVG without an assertion element returns null", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
  expect(extractBakedAssertion(Buffer.from(svg, "utf8"), "image/svg+xml")).toBeNull();
});

test("garbage bytes never throw — return null", () => {
  expect(extractBakedAssertion(Buffer.from([1, 2, 3, 4]), "image/png")).toBeNull();
  expect(extractBakedAssertion(Buffer.from("<svg", "utf8"), "image/svg+xml")).toBeNull();
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/credentials/extract-baked-badge.test.ts`
Expected: FAIL — `lib/credentials/extract-baked-badge.ts` does not exist.

- [ ] **Step 3: Write `lib/credentials/extract-baked-badge.ts`**

```ts
// Best-effort baked-badge assertion extractor. Never throws — returns null on any failure.
// PNG spec: https://www.imsglobal.org/openbadges/baked

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BAKED_KEYWORD = "openbadges";

function tryJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Walk PNG chunks; return the text payload of an iTXt/tEXt chunk keyed "openbadges". */
function readPngBakedText(buffer: Buffer): string | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break; // truncated / malformed
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString("ascii", 0, nul);
        if (keyword === BAKED_KEYWORD) {
          if (type === "tEXt") {
            return data.toString("latin1", nul + 1);
          }
          // iTXt: after keyword\0 comes compressionFlag(1), compressionMethod(1),
          // langTag\0, translatedKeyword\0, then the (uncompressed) text.
          const compressionFlag = data[nul + 1];
          if (compressionFlag !== 0) return null; // compressed iTXt unsupported in v1
          let p = nul + 3; // skip flag + method
          const langEnd = data.indexOf(0, p);
          if (langEnd === -1) return null;
          const transEnd = data.indexOf(0, langEnd + 1);
          if (transEnd === -1) return null;
          return data.toString("utf8", transEnd + 1);
        }
      }
    }
    offset = dataEnd + 4; // skip 4-byte CRC
    if (type === "IEND") break;
  }
  return null;
}

/** Pull assertion JSON from an SVG <openbadges:assertion> element (or plain <assertion>). */
function readSvgBakedText(svg: string): string | null {
  const match =
    svg.match(/<openbadges:assertion[^>]*>([\s\S]*?)<\/openbadges:assertion>/) ??
    svg.match(/<assertion[^>]*>([\s\S]*?)<\/assertion>/);
  return match ? match[1].trim() : null;
}

/**
 * Extract an embedded Open Badges assertion from a baked PNG or SVG.
 * Returns the parsed JSON, or null when nothing parseable is embedded.
 */
export function extractBakedAssertion(
  buffer: Buffer,
  mime: "image/png" | "image/svg+xml"
): unknown | null {
  try {
    const text =
      mime === "image/png"
        ? readPngBakedText(buffer)
        : readSvgBakedText(buffer.toString("utf8"));
    if (!text) return null;
    return tryJson(text);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/credentials/extract-baked-badge.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/credentials/extract-baked-badge.ts lib/credentials/extract-baked-badge.test.ts
git commit -m "feat: best-effort baked PNG/SVG Open Badges assertion extractor"
```

---

### Task 4: `did:key` → JWK decoder (pure)

> **Scope.** v1's crypto verification path handles ONLY `did:key` Ed25519 verification methods —
> the DID literally encodes the public key, so no network resolution is needed. `did:web`,
> `did:ion`, etc. (which require remote resolution) are deliberately OUT of v1 and cause the
> verifier to return honest `unverified`. This helper decodes exactly the `did:key:z6Mk…`
> Ed25519 multibase form to a JWK that `jose` can verify with.

**Files:**
- Create: `lib/credentials/did-key.ts`, `lib/credentials/did-key.test.ts`

**Interfaces:**
- Consumes: `multiformats/bases/base58` (base58btc decode)
- Produces:
  ```ts
  export interface Ed25519Jwk { kty: "OKP"; crv: "Ed25519"; x: string; }
  export function didKeyToPublicJwk(verificationMethod: string): Ed25519Jwk | null;
  ```
  Accepts a `did:key:z…` string (optionally with a `#…` fragment) and returns the Ed25519 public JWK, or `null` for any non-`did:key`, non-Ed25519, or malformed input.

- [ ] **Step 1: Write the failing tests `lib/credentials/did-key.test.ts`**

```ts
import { expect, test } from "vitest";
import { generateKeyPair, exportJWK } from "jose";
import { base58btc } from "multiformats/bases/base58";
import { didKeyToPublicJwk } from "./did-key";

// Build a did:key from a freshly generated Ed25519 public key, then round-trip it.
async function makeDidKey(): Promise<{ did: string; expectedX: string }> {
  const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  const rawX = Buffer.from(jwk.x as string, "base64url"); // 32-byte Ed25519 public key
  // multicodec prefix for ed25519-pub is 0xed 0x01
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawX]);
  const did = `did:key:${base58btc.encode(prefixed)}`;
  return { did, expectedX: jwk.x as string };
}

test("decodes a did:key Ed25519 verificationMethod to a matching JWK", async () => {
  const { did, expectedX } = await makeDidKey();
  const jwk = didKeyToPublicJwk(`${did}#${did.slice("did:key:".length)}`);
  expect(jwk).not.toBeNull();
  expect(jwk!.kty).toBe("OKP");
  expect(jwk!.crv).toBe("Ed25519");
  expect(jwk!.x).toBe(expectedX);
});

test("accepts a bare did:key without a fragment", async () => {
  const { did, expectedX } = await makeDidKey();
  expect(didKeyToPublicJwk(did)!.x).toBe(expectedX);
});

test("returns null for non-did:key methods and malformed input", () => {
  expect(didKeyToPublicJwk("did:web:issuer.example")).toBeNull();
  expect(didKeyToPublicJwk("not-a-did")).toBeNull();
  expect(didKeyToPublicJwk("did:key:zNotBase58!!!")).toBeNull();
  expect(didKeyToPublicJwk("")).toBeNull();
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/credentials/did-key.test.ts`
Expected: FAIL — `lib/credentials/did-key.ts` does not exist.

- [ ] **Step 3: Write `lib/credentials/did-key.ts`**

```ts
import { base58btc } from "multiformats/bases/base58";

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string; // base64url of the 32-byte public key
}

// multicodec varint prefix for ed25519-pub is [0xed, 0x01].
const ED25519_PREFIX = [0xed, 0x01];

/**
 * Decode a `did:key` Ed25519 verification method into an Ed25519 public JWK.
 * Returns null for any non-did:key, non-Ed25519, or malformed input. Pure, no I/O.
 */
export function didKeyToPublicJwk(verificationMethod: string): Ed25519Jwk | null {
  if (typeof verificationMethod !== "string") return null;
  // Strip an optional DID-URL fragment (#...).
  const did = verificationMethod.split("#")[0];
  const prefix = "did:key:";
  if (!did.startsWith(prefix)) return null;
  const multibase = did.slice(prefix.length);
  if (!multibase.startsWith("z")) return null; // z = base58btc multibase

  let decoded: Uint8Array;
  try {
    decoded = base58btc.decode(multibase);
  } catch {
    return null;
  }
  if (decoded.length !== ED25519_PREFIX.length + 32) return null;
  if (decoded[0] !== ED25519_PREFIX[0] || decoded[1] !== ED25519_PREFIX[1]) return null;

  const raw = decoded.slice(ED25519_PREFIX.length);
  const x = Buffer.from(raw).toString("base64url");
  return { kty: "OKP", crv: "Ed25519", x };
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/credentials/did-key.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/credentials/did-key.ts lib/credentials/did-key.test.ts
git commit -m "feat: pure did:key Ed25519 -> JWK decoder for VC verification"
```

---

### Task 5: Verify a credential (impure shell, DI'd fetch/crypto)

> **v1 verification scope (explicit).** IN: (1) **OB2.x hosted** — re-fetch the assertion's
> hosted URL, detected across BOTH the legacy `verify.url`/`badge.verify.url` shape AND the
> canonical OB2.0 shape (`verification: { type: "HostedBadge" | "hosted" }` with the assertion
> URL in the top-level `id`). Then confirm not revoked AND that the re-fetched document is the
> SAME assertion by matching the stored assertion `id` against the hosted body's `id` → `verified`.
> Fetch failure / revoked / **id mismatch** → `failed`. When the stored credential carries no `id`
> to match against (e.g. a legacy `verify.url` assertion with no top-level id), verification is
> honest `unverified` — reachable-but-unprovable is NOT `verified`, closing the "any 200 = verified"
> gap. (2) **OB3.0/VC JWT** — a compact JWS (bare string or `proof.jwt`) whose signature verifies
> against a `did:key`-resolved Ed25519 key via `jose` → `verified`; tampered/expired/malformed →
> `failed`. OUT (honest `unverified`, never crash): manual entries (the verifier is not even
> invoked); DataIntegrityProof / Ed25519Signature2020 LD-proofs (the heavy `@digitalbazaar`
> JSON-LD stack is deferred — flag for a follow-up once a real OB3.0 pilot badge exists to test
> against); non-`did:key` verification methods (`did:web` etc.); StatusList2021 revocation for VCs;
> any proof type other than JWT. This is the single biggest deliberate scope cut in Plan 3.
>
> **Realistic field expectation (do not over-promise).** Given the cuts above, the only credentials
> that will actually reach `verified` in v1 are (a) OB2.x hosted assertions that carry a matchable
> `id` and re-fetch to the same document, and (b) compact-JWT VCs signed with `did:key`. Legacy
> id-less hosted badges, `did:web`/LD-proof OB3.0 badges, and everything else land honestly at
> `unverified`. Expect a meaningful fraction of real-world imports to be `unverified` at launch —
> "verification" is an honest, narrow v1 capability, not a claim to verify most badges in the field.

**Files:**
- Create: `lib/credentials/verify.ts`, `lib/credentials/verify.test.ts`

**Interfaces:**
- Consumes: `VerifyInput`, `VerifyResult`, `VerifyOpts`, `VerificationStatus` from `@/lib/credentials/types`; `didKeyToPublicJwk` from `@/lib/credentials/did-key`; `jose`
- Produces:
  ```ts
  export function detectHostedVerify(rawJson: unknown): { url: string } | null; // pure
  export function detectJwt(rawJson: unknown): string | null;                    // pure
  export async function verifyCredential(input: VerifyInput, opts?: VerifyOpts): Promise<VerifyResult>;
  ```
  `verifyCredential`: `manual` → always `{status:"unverified", method:"none"}` (no fetch). Otherwise dispatch: JWT present → crypto path; else hosted-verify present → fetch path; else `unverified`. `fetchImpl` defaults to global `fetch`; injected in every test so no real issuer is ever called.

- [ ] **Step 1: Write the failing tests `lib/credentials/verify.test.ts`**

```ts
import { beforeAll, expect, test, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { base58btc } from "multiformats/bases/base58";
import { detectHostedVerify, detectJwt, verifyCredential } from "./verify";
import type { VerifyInput } from "@/lib/credentials/types";

// ---- OB2.x hosted detection + fetch path ----
test("detectHostedVerify finds legacy verify.url and badge.verify.url; null otherwise", () => {
  expect(detectHostedVerify({ verify: { type: "hosted", url: "https://x/a" } })).toEqual({
    url: "https://x/a",
  });
  expect(
    detectHostedVerify({ badge: { verify: { type: "hosted", url: "https://x/b" } } })
  ).toEqual({ url: "https://x/b" });
  expect(detectHostedVerify({ foo: 1 })).toBeNull();
});

test("detectHostedVerify handles canonical OB2.0 (verification:HostedBadge, url in id)", () => {
  expect(
    detectHostedVerify({
      id: "https://issuer.example/assertions/1",
      verification: { type: "HostedBadge" },
    })
  ).toEqual({ url: "https://issuer.example/assertions/1" });
  // A hosted verification block whose id is not an https URL has no re-fetch target.
  expect(
    detectHostedVerify({ id: "urn:uuid:abc", verification: { type: "hosted" } })
  ).toBeNull();
});

function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// Canonical OB2.0 assertion carrying an id, so the identity match has something to compare.
const HOSTED_ASSERTION = {
  id: "https://issuer.example/assertions/1",
  verification: { type: "HostedBadge" },
};

test("hosted verify: reachable, id matches, not revoked -> verified", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ id: HOSTED_ASSERTION.id, revoked: false }),
  });
  expect(res.status).toBe("verified");
  expect(res.method).toBe("ob2_hosted");
});

test("hosted verify: reachable but hosted id is a DIFFERENT assertion -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    // Reachable, not revoked, but an unrelated document — must NOT be verified.
    fetchImpl: fetchReturning({ id: "https://issuer.example/assertions/999", revoked: false }),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: legacy verify.url with no stored id -> unverified (cannot prove identity)", async () => {
  const input: VerifyInput = {
    source: "ob_url",
    raw_json: { verify: { type: "hosted", url: "https://issuer/a" } },
  };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ revoked: false }),
  });
  // Reachable + not revoked, but no id to match against -> honest unverified, never verified.
  expect(res.status).toBe("unverified");
  expect(res.method).toBe("ob2_hosted");
});

test("hosted verify: revoked -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ id: HOSTED_ASSERTION.id, revoked: true }),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: fetch not ok (404) -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({}, false, 404),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: fetch throws -> failed (never rejects)", async () => {
  const throwing = vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const res = await verifyCredential(
    { source: "ob_url", raw_json: HOSTED_ASSERTION },
    { fetchImpl: throwing }
  );
  expect(res.status).toBe("failed");
});

// ---- OB3.0/VC JWT crypto path (real keys, no network) ----
let signedVc: string;
let expiredVc: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const rawX = Buffer.from(jwk.x as string, "base64url");
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawX]);
  const did = `did:key:${base58btc.encode(prefixed)}`;
  const kid = `${did}#${did.slice("did:key:".length)}`;

  signedVc = await new SignJWT({ vc: { type: ["VerifiableCredential"] } })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  expiredVc = await new SignJWT({ vc: {} })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);
});

test("detectJwt finds a bare compact JWS and a proof.jwt; null otherwise", () => {
  expect(detectJwt("aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
  expect(detectJwt({ proof: { jwt: "aaa.bbb.ccc" } })).toBe("aaa.bbb.ccc");
  expect(detectJwt({ credentialSubject: {} })).toBeNull();
});

test("VC JWT: valid signature (did:key) -> verified", async () => {
  const res = await verifyCredential({ source: "ob_url", raw_json: signedVc });
  expect(res.status).toBe("verified");
  expect(res.method).toBe("vc_jwt");
});

test("VC JWT: tampered payload -> failed", async () => {
  const parts = signedVc.split(".");
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
  const res = await verifyCredential({ source: "ob_url", raw_json: tampered });
  expect(res.status).toBe("failed");
});

test("VC JWT: expired -> failed", async () => {
  const res = await verifyCredential({ source: "ob_url", raw_json: expiredVc });
  expect(res.status).toBe("failed");
});

// ---- honest fall-throughs ----
test("manual source is always unverified and never fetches", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const res = await verifyCredential({ source: "manual", raw_json: null }, { fetchImpl });
  expect(res).toMatchObject({ status: "unverified", method: "none" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("no proof and no hosted-verify block -> unverified", async () => {
  const res = await verifyCredential({
    source: "ob_file",
    raw_json: { credentialSubject: { achievement: { name: "X" } } },
  });
  expect(res.status).toBe("unverified");
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- lib/credentials/verify.test.ts`
Expected: FAIL — `lib/credentials/verify.ts` does not exist.

- [ ] **Step 3: Write `lib/credentials/verify.ts`**

```ts
import { importJWK, jwtVerify } from "jose";
import type {
  VerifyInput,
  VerifyOpts,
  VerifyResult,
} from "@/lib/credentials/types";
import { didKeyToPublicJwk } from "@/lib/credentials/did-key";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function result(
  status: VerifyResult["status"],
  method: VerifyResult["method"],
  detail: string
): VerifyResult {
  return { status, method, detail };
}

const HOSTED_TYPES = new Set(["hosted", "HostedBadge"]);

/**
 * Detect an OB2.x hosted verification target across both shapes:
 *   - Legacy OB1.1 / some OB2.0: { verify: { type:'hosted', url } } (top-level or under badge).
 *   - Canonical OB2.0: { verification: { type:'HostedBadge' | 'hosted' } } with the assertion
 *     URL carried in the top-level `id` (an https URL), NOT a verify.url field.
 * Returns the https re-fetch URL, or null when no hosted mechanism is present.
 */
export function detectHostedVerify(rawJson: unknown): { url: string } | null {
  const root = asRecord(rawJson);
  if (!root) return null;

  // Legacy verify.url shape (top-level or under badge).
  for (const holder of [root, asRecord(root.badge) ?? {}]) {
    const verify = asRecord((holder as Record<string, unknown>).verify);
    if (verify && typeof verify.url === "string" && verify.url.length > 0) {
      return { url: verify.url };
    }
  }

  // Canonical OB2.0: verification/verify block with a hosted type, URL in the top-level id.
  const verification =
    asRecord(root.verification) ?? asRecord(root.verify);
  const vType = verification && typeof verification.type === "string" ? verification.type : "";
  if (verification && HOSTED_TYPES.has(vType)) {
    const id = typeof root.id === "string" ? root.id : "";
    if (id.startsWith("http://") || id.startsWith("https://")) {
      return { url: id };
    }
  }
  return null;
}

/** A compact JWS: a bare "a.b.c" string, or nested under proof.jwt. */
export function detectJwt(rawJson: unknown): string | null {
  if (typeof rawJson === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(rawJson)) {
    return rawJson;
  }
  const root = asRecord(rawJson);
  const proof = asRecord(root?.proof);
  const jwt = proof?.jwt;
  if (typeof jwt === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) return jwt;
  return null;
}

async function verifyJwt(jwt: string): Promise<VerifyResult> {
  try {
    const decodeHeader = (): Record<string, unknown> => {
      const [encodedHeader] = jwt.split(".");
      return JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    };
    const header = decodeHeader();
    const kid = typeof header.kid === "string" ? header.kid : "";
    const jwk = didKeyToPublicJwk(kid);
    if (!jwk) {
      // Non-did:key (e.g. did:web) or missing kid: out of v1 scope — honest unverified.
      return result("unverified", "none", "unsupported verification method");
    }
    const key = await importJWK(jwk, "EdDSA");
    await jwtVerify(jwt, key); // throws on bad signature or expiry
    return result("verified", "vc_jwt", "did:key EdDSA signature valid");
  } catch (e) {
    return result("failed", "vc_jwt", (e as Error).message);
  }
}

/** The assertion's own identifier, used to confirm the hosted document is the SAME assertion. */
function assertionId(rawJson: unknown): string | null {
  const root = asRecord(rawJson);
  if (!root) return null;
  return typeof root.id === "string" && root.id.length > 0 ? root.id : null;
}

async function verifyHosted(
  url: string,
  storedId: string | null,
  fetchImpl: typeof fetch
): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return result("failed", "ob2_hosted", `hosted fetch ${res.status}`);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return result("failed", "ob2_hosted", "hosted response not JSON");
    if (body.revoked === true) return result("failed", "ob2_hosted", "revoked");
    // Identity match: the hosted document must be the SAME assertion we stored, not just
    // any reachable non-revoked JSON. Compare the stored assertion id (if any) against the
    // hosted body's own id. A mismatch means the URL points at an unrelated document -> failed.
    // Only enforced when the stored credential carries an id to compare against; when it has
    // none, we cannot prove identity, so we return honest `unverified` rather than false-verified.
    const hostedId = typeof body.id === "string" ? body.id : null;
    if (storedId) {
      if (hostedId && hostedId === storedId) {
        return result("verified", "ob2_hosted", "hosted assertion matches, not revoked");
      }
      return result(
        "failed",
        "ob2_hosted",
        `hosted id mismatch (stored ${storedId}, hosted ${hostedId ?? "none"})`
      );
    }
    return result(
      "unverified",
      "ob2_hosted",
      "hosted assertion reachable but no id to match against"
    );
  } catch (e) {
    return result("failed", "ob2_hosted", (e as Error).message);
  }
}

/**
 * Set a credential's honest verification status. Manual -> always unverified (no fetch).
 * Dispatch order: VC JWT crypto (did:key), then OB2.x hosted re-fetch, else unverified.
 */
export async function verifyCredential(
  input: VerifyInput,
  opts?: VerifyOpts
): Promise<VerifyResult> {
  if (input.source === "manual") {
    return result("unverified", "none", "manual entry");
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const jwt = detectJwt(input.raw_json);
  if (jwt) return verifyJwt(jwt);

  const hosted = detectHostedVerify(input.raw_json);
  if (hosted) return verifyHosted(hosted.url, assertionId(input.raw_json), fetchImpl);

  return result("unverified", "none", "no verifiable proof present");
}
```

- [ ] **Step 4: Run the tests (expected PASS)**

Run: `npm test -- lib/credentials/verify.test.ts`
Expected: 14 passed. (Real Ed25519 crypto via `jose`; zero network — hosted fetch is injected, JWT path is `did:key` so needs none.)

- [ ] **Step 5: Commit**

```bash
git add lib/credentials/verify.ts lib/credentials/verify.test.ts
git commit -m "feat: OB2.x hosted + OB3.0/VC did:key JWT verification (honest unverified fallback)"
```

---

### Task 6: Storage bucket + policies (migration) and storage adapter

> **Migration numbering.** `0003_rls_policies.sql` is the last committed migration, so this is
> `0004_credential_storage.sql`. Apply it EXACTLY as Plans 1–2 apply migrations:
> `node scripts/apply-migration.mjs supabase/migrations/0004_credential_storage.sql` (POSTs the
> SQL to the Supabase Management API — never `supabase db push`). `storage.objects` policies are
> just more SQL on a Supabase-managed table, so the existing generic script handles them.

**Files:**
- Create: `supabase/migrations/0004_credential_storage.sql`, `lib/credentials/storage.ts`
- Test: exercised by `tests/db/credential-storage-rls.test.ts` (Task 12)

**Interfaces:**
- Consumes: `SupabaseClient` from `@supabase/supabase-js`
- Produces:
  ```ts
  export async function uploadCredentialFile(
    db: SupabaseClient,
    earnerId: string,
    credentialId: string,
    fileBuffer: Buffer,
    fileMime: string,
    fileName: string
  ): Promise<{ storagePath: string }>;
  export async function getSignedFileUrl(
    db: SupabaseClient,
    storagePath: string,
    expiresInSeconds?: number
  ): Promise<string>;
  ```
  Bucket: `credential-files` (private). Path convention: `{earnerId}/{credentialId}/{sanitizedFileName}` — the leading folder is `earnerId` so the Storage RLS `(storage.foldername(name))[1] = auth.uid()::text` scopes reads/writes to the owner.

- [ ] **Step 1: Write `supabase/migrations/0004_credential_storage.sql`**

```sql
-- Private bucket for uploaded credential files (raw OB JSON, baked PNG/SVG).
-- Applied via the Management API: node scripts/apply-migration.mjs supabase/migrations/0004_credential_storage.sql
insert into storage.buckets (id, name, public)
values ('credential-files', 'credential-files', false)
on conflict (id) do nothing;

-- Path convention: {earner_id}/{credential_id}/{filename}. An earner may read/write/delete
-- only objects under their own uuid-prefixed folder — mirrors credentials_owner_all
-- (0003_rls_policies.sql). Service-role bypasses RLS for server-side test seeding.
create policy credential_files_owner_select on storage.objects
  for select using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy credential_files_owner_insert on storage.objects
  for insert with check (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- upsert:true in uploadCredentialFile takes the UPDATE path when an object already exists at the
-- path (e.g. a retried Server Action re-running createCredentialAndProcess for the same credentialId,
-- or a future replace-file flow). Without an UPDATE policy those writes would be RLS-denied. Scoped
-- identically to insert/select so an earner may only overwrite objects in their own folder.
create policy credential_files_owner_update on storage.objects
  for update using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy credential_files_owner_delete on storage.objects
  for delete using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

- [ ] **Step 2: Apply the migration**

Run: `node scripts/apply-migration.mjs supabase/migrations/0004_credential_storage.sql`
Expected: prints `Applied supabase/migrations/0004_credential_storage.sql. Response: ...` (the script logs `Applied ${file}. Response: ${text}`). Idempotent for the bucket (`on conflict do nothing`); re-running fails only on duplicate policy names — if you must re-apply, drop the four policies (`credential_files_owner_select`/`_insert`/`_update`/`_delete`) first. If the response reports a policy-syntax error against the live Storage engine, fix the `storage.foldername`/`auth.uid()` expression to match the dashboard's Storage-policy editor before proceeding (Storage RLS syntax should be validated here, as `0003` was validated via `tests/db/rls.test.ts`).

- [ ] **Step 3: Write `lib/credentials/storage.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "credential-files";

/** Strip path separators / control chars from a user-supplied file name. */
function sanitizeFileName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim();
  return base.length > 0 ? base : "file";
}

/**
 * Upload a credential's source file to the private bucket under {earnerId}/{credentialId}/.
 * Returns the storage path to persist in credentials.storage_path.
 */
export async function uploadCredentialFile(
  db: SupabaseClient,
  earnerId: string,
  credentialId: string,
  fileBuffer: Buffer,
  fileMime: string,
  fileName: string
): Promise<{ storagePath: string }> {
  const storagePath = `${earnerId}/${credentialId}/${sanitizeFileName(fileName)}`;
  const { error } = await db.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, { contentType: fileMime, upsert: true });
  if (error) throw error;
  return { storagePath };
}

/** Signed URL for private display in the wallet (default 1h). */
export async function getSignedFileUrl(
  db: SupabaseClient,
  storagePath: string,
  expiresInSeconds = 3600
): Promise<string> {
  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (RLS behavior is proven in Task 12's integration test, which needs the whole import path.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_credential_storage.sql lib/credentials/storage.ts
git commit -m "feat: private credential-files Storage bucket + path-scoped RLS + upload adapter"
```

---

### Task 7: Import orchestrator — `createCredentialAndProcess` (impure)

**Files:**
- Create: `lib/credentials/create.ts`
- Test: exercised by `tests/db/credentials-import.test.ts` (Task 12); pure branches covered there

**Interfaces:**
- Consumes: `NewCredentialInput`, `CreateCredentialResult`, `ParsedCredential`, `VerificationStatus` from `@/lib/credentials/types`; `parseOpenBadge` from `@/lib/credentials/parse-ob`; `extractBakedAssertion` from `@/lib/credentials/extract-baked-badge`; `verifyCredential` from `@/lib/credentials/verify`; `uploadCredentialFile` from `@/lib/credentials/storage`; `processCredential` from `@/lib/skills/index`; `LlmClient` from `@/lib/skills/types`; `SupabaseClient`
- Produces:
  ```ts
  export interface CreateDeps { verifyFetch?: typeof fetch; }
  export async function createCredentialAndProcess(
    db: SupabaseClient,
    llm: LlmClient,
    input: NewCredentialInput,
    deps?: CreateDeps
  ): Promise<CreateCredentialResult>;
  ```
  Pipeline: (1) derive `raw_json` + `ParsedCredential` per source (manual → direct fields; ob_url → parse `raw_json`; ob_file → JSON.parse for `application/json`, else `extractBakedAssertion` for PNG/SVG, `null` when unparseable); (2) for `ob_file`, `crypto.randomUUID()` a credentialId and `uploadCredentialFile` BEFORE insert so `storage_path` is known; (3) insert `credentials` (`earner_id`, `source`, `raw_json`, `issuer_name`, `title`, `issued_date`, `storage_path`, `verification_status:'unverified'`); (4) `verifyCredential` → `update` the row's `verification_status`; (5) `try { await processCredential(db, llm, id) } catch { log }` — skills failure never fails the import; (6) return `{ credentialId, verificationStatus }`.

- [ ] **Step 1: Write `lib/credentials/create.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateCredentialResult,
  NewCredentialInput,
  ParsedCredential,
  VerificationStatus,
  VerifyInput,
} from "@/lib/credentials/types";
import type { LlmClient } from "@/lib/skills/types";
import { parseOpenBadge } from "@/lib/credentials/parse-ob";
import { extractBakedAssertion } from "@/lib/credentials/extract-baked-badge";
import { verifyCredential } from "@/lib/credentials/verify";
import { uploadCredentialFile } from "@/lib/credentials/storage";
import { processCredential } from "@/lib/skills/index";

export interface CreateDeps {
  verifyFetch?: typeof fetch;
}

/**
 * Derive the JSON payload for a file import: parse JSON directly, else extract a baked assertion.
 * `mime` is expected to be a canonical type (`application/json` | `image/png` | `image/svg+xml`);
 * the Server Action (`importByFile`) normalizes browser MIME quirks + extension fallback before
 * calling here, so an unrecognized `mime` correctly yields `null` (stored `unverified`).
 */
function rawJsonFromFile(
  buffer: Buffer,
  mime: string
): unknown | null {
  if (mime === "application/json") {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (mime === "image/png" || mime === "image/svg+xml") {
    return extractBakedAssertion(buffer, mime);
  }
  return null;
}

/**
 * The single function all three import Server Actions call. Creates the credentials row,
 * uploads any file, sets an honest verification_status, and runs Plan 2's skills engine.
 * Post-insert failures (verification, skills) never delete the row — an imported credential
 * always lands in the wallet, honestly (spec §5).
 */
export async function createCredentialAndProcess(
  db: SupabaseClient,
  llm: LlmClient,
  input: NewCredentialInput,
  deps?: CreateDeps
): Promise<CreateCredentialResult> {
  let rawJson: unknown | null = null;
  let parsed: ParsedCredential;
  let storagePath: string | null = null;
  let credentialId = randomUUID();

  if (input.source === "manual") {
    // Persist the user-entered description into raw_json so Plan 2's descriptionFrom(raw_json)
    // (which reads root.description) feeds it to the skills extractor. Without this, a manual
    // credential's description would be silently dropped and only its title would drive extraction.
    // Store null (not an empty object) when there is no description, keeping rows tidy.
    rawJson = input.manual.description
      ? { description: input.manual.description }
      : null;
    parsed = {
      title: input.manual.title,
      issuerName: input.manual.issuerName,
      issuedDate: input.manual.issuedDate,
      description: input.manual.description,
    };
  } else if (input.source === "ob_url") {
    rawJson = input.raw_json;
    parsed = parseOpenBadge(rawJson);
  } else {
    // ob_file: upload first so storage_path is known at insert time.
    rawJson = rawJsonFromFile(input.fileBuffer, input.fileMime);
    parsed = parseOpenBadge(rawJson);
    const uploaded = await uploadCredentialFile(
      db,
      input.earnerId,
      credentialId,
      input.fileBuffer,
      input.fileMime,
      input.fileName
    );
    storagePath = uploaded.storagePath;
  }

  const { data: inserted, error: insErr } = await db
    .from("credentials")
    .insert({
      id: credentialId,
      earner_id: input.earnerId,
      source: input.source,
      raw_json: rawJson,
      issuer_name: parsed.issuerName,
      title: parsed.title,
      issued_date: parsed.issuedDate,
      storage_path: storagePath,
      verification_status: "unverified",
    })
    .select("id")
    .single();
  if (insErr) {
    // The file was uploaded BEFORE the insert (so storage_path is known at insert time). If the
    // insert fails, best-effort delete the just-uploaded object so we don't leak an orphaned,
    // unreferenced Storage file (Storage objects are NOT FK-cascaded — nothing else reaps them).
    if (storagePath) {
      await db.storage
        .from("credential-files")
        .remove([storagePath])
        .catch(() => {
          /* best-effort cleanup; the original insert error is what we surface */
        });
    }
    throw insErr;
  }
  credentialId = inserted.id as string;

  // Verify + persist honest status (skills run regardless of the outcome).
  const verifyInput: VerifyInput = { source: input.source, raw_json: rawJson };
  const verification = await verifyCredential(verifyInput, {
    fetchImpl: deps?.verifyFetch,
  });
  const verificationStatus: VerificationStatus = verification.status;
  const { error: updErr } = await db
    .from("credentials")
    .update({ verification_status: verificationStatus })
    .eq("id", credentialId);
  if (updErr) throw updErr;

  // Skills enrichment — a failure here must never fail the import.
  try {
    await processCredential(db, llm, credentialId);
  } catch (e) {
    console.error(
      `processCredential failed for credential ${credentialId}: ${(e as Error).message}`
    );
  }

  return { credentialId, verificationStatus };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Full behavior — including "skills failure does not roll back the row" — is proven in Task 12's hosted-DB integration test, which needs a real `credentials` row + `earner_skills` write.)

- [ ] **Step 3: Commit**

```bash
git add lib/credentials/create.ts
git commit -m "feat: createCredentialAndProcess import orchestrator (parse->store->verify->skills)"
```

---

### Task 8: Server Actions — the three import entry points

**Files:**
- Create: `app/app/wallet/actions.ts`

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server`; `createAnthropicLlmClient` from `@/lib/skills/llm`; `createCredentialAndProcess` from `@/lib/credentials/create`; `verifyCredential` from `@/lib/credentials/verify` (for re-verify)
- Produces:
  ```ts
  export async function importByUrl(formData: FormData): Promise<void>;
  export async function importByFile(formData: FormData): Promise<void>;
  export async function importManual(formData: FormData): Promise<void>;
  export async function reverifyCredential(formData: FormData): Promise<void>;
  ```
  Each: parse/validate FormData → auth via `supabase.auth.getUser()` (redirect `/login` if none) → build `NewCredentialInput` → `createCredentialAndProcess` → `revalidatePath("/app")` → `redirect("/app")`. Validation failures redirect to `/app/wallet/import?error=<code>` (read by the import page). A totally unfetchable/unparseable `ob_url` redirects with an error rather than creating a garbage row (spec §5).

> **Why Server Actions (not route handlers).** Imports are always triggered from Trove's own
> "Add credential" form — a form submit is the natural fit, and Server Actions give CSRF
> protection, progressive enhancement, and typed FormData for free. Route handlers are reserved
> for stable public-URL contracts (like `app/auth/confirm/route.ts`) or non-browser callers;
> neither applies here.

- [ ] **Step 1: Write `app/app/wallet/actions.ts`**

```ts
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAnthropicLlmClient } from "@/lib/skills/llm";
import { createCredentialAndProcess } from "@/lib/credentials/create";
import { verifyCredential } from "@/lib/credentials/verify";
import { parseOpenBadge } from "@/lib/credentials/parse-ob";

const IMPORT = "/app/wallet/import";
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// Accepted content types keyed by canonical MIME. Browsers/OSes are inconsistent about the MIME
// they attach to uploads (SVG often arrives as text/xml or empty; JSON as text/plain or empty),
// so we ALSO accept by file extension and normalize to a canonical MIME the parser understands.
const MIME_BY_EXT: Record<string, string> = {
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
};
const KNOWN_MIME = new Set(Object.values(MIME_BY_EXT));

/**
 * Resolve an upload to a canonical MIME the pipeline understands, tolerating browser MIME quirks:
 * trust a known `upload.type`, else fall back to the file extension. Returns null when neither
 * yields a supported type (→ bad_type).
 */
function resolveUploadMime(type: string, name: string): string | null {
  if (KNOWN_MIME.has(type)) return type;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function requireUserId(): Promise<string> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}

export async function importByUrl(formData: FormData): Promise<void> {
  const url = String(formData.get("url") ?? "").trim();
  if (!url || !isHttpUrl(url)) redirect(`${IMPORT}?error=invalid_url`);

  const userId = await requireUserId();

  // Keep redirect() OUT of the try/catch blocks: redirect() signals via a thrown NEXT_REDIRECT
  // control-flow error, which a bare catch would swallow. We set outcome locals inside try and
  // branch/redirect once afterward. The fetch and the JSON parse get SEPARATE try/catch blocks so
  // a reachable-but-non-JSON body (HTTP 200 returning HTML/truncated text) reports invalid_json,
  // not the misleading fetch_failed. (spec §5: an unfetchable/unparseable ob_url never becomes a row.)
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    redirect(`${IMPORT}?error=fetch_failed`);
  }
  if (!res.ok) redirect(`${IMPORT}?error=fetch_failed`);

  let raw_json: unknown;
  try {
    raw_json = await res.json();
  } catch {
    redirect(`${IMPORT}?error=invalid_json`);
  }
  if (raw_json === null || typeof raw_json !== "object") {
    redirect(`${IMPORT}?error=invalid_json`);
  }

  // Guard the envelope BEFORE inserting: parseOpenBadge never throws and returns an empty-title
  // shape for unrecognized JSON (e.g. {} or an unrelated API's {"status":"ok"}). Persisting that
  // would leave the earner with a blank, unexplained card and violate the "no garbage row" invariant.
  if (!parseOpenBadge(raw_json).title) {
    redirect(`${IMPORT}?error=unrecognized_credential`);
  }

  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "ob_url",
    raw_json,
    sourceUrl: url,
  });
  revalidatePath("/app");
  redirect("/app");
}

export async function importByFile(formData: FormData): Promise<void> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect(`${IMPORT}?error=no_file`);
  const upload = file as File;
  const fileMime = resolveUploadMime(upload.type, upload.name);
  if (!fileMime) redirect(`${IMPORT}?error=bad_type`);
  if (upload.size > MAX_FILE_BYTES) redirect(`${IMPORT}?error=too_large`);

  const userId = await requireUserId();
  const fileBuffer = Buffer.from(await upload.arrayBuffer());

  // For a JSON upload we can validate the envelope up front (an unrecognized JSON file should not
  // become a blank row). Baked PNG/SVG are best-effort: they legitimately store `unverified` with
  // raw_json:null when nothing is embedded (spec §5), so we do NOT block those here — the image is
  // still worth keeping in the wallet even if we could not extract an assertion.
  if (fileMime === "application/json") {
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(fileBuffer.toString("utf8"));
    } catch {
      redirect(`${IMPORT}?error=invalid_json`);
    }
    if (!parseOpenBadge(parsedJson).title) {
      redirect(`${IMPORT}?error=unrecognized_credential`);
    }
  }

  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "ob_file",
    fileBuffer,
    fileMime, // canonical MIME, so the pipeline's parser/branching is deterministic
    fileName: upload.name,
  });
  revalidatePath("/app");
  redirect("/app");
}

export async function importManual(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) redirect(`${IMPORT}?error=missing_title`);

  const userId = await requireUserId();
  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "manual",
    manual: {
      title,
      issuerName: String(formData.get("issuer_name") ?? "").trim(),
      issuedDate: String(formData.get("issued_date") ?? "").trim() || null,
      description: String(formData.get("description") ?? "").trim(),
    },
  });
  revalidatePath("/app");
  redirect("/app");
}

/**
 * On-demand re-verify (spec §5's verify affordance). Reloads raw_json, re-runs the identical
 * verifyCredential, and persists the new status. RLS ensures the earner owns the row.
 */
export async function reverifyCredential(formData: FormData): Promise<void> {
  const credentialId = String(formData.get("credential_id") ?? "").trim();
  if (!credentialId) redirect("/app");

  await requireUserId();
  const supabase = await createServerClient();
  const { data: cred } = await supabase
    .from("credentials")
    .select("id, source, raw_json")
    .eq("id", credentialId)
    .single();
  if (cred) {
    const result = await verifyCredential({
      source: cred.source as "ob_url" | "ob_file" | "manual",
      raw_json: cred.raw_json ?? null,
    });
    await supabase
      .from("credentials")
      .update({ verification_status: result.status })
      .eq("id", credentialId);
  }
  revalidatePath("/app");
  redirect("/app");
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Server Actions are integration-tested end-to-end via the import path in Task 12 through `createCredentialAndProcess`; the actions themselves are thin adapters over it.)

- [ ] **Step 3: Commit**

```bash
git add app/app/wallet/actions.ts
git commit -m "feat: wallet import Server Actions (url/file/manual) + on-demand re-verify"
```

---

### Task 9: Wallet grid UI — card, grid, empty state (Server Components)

> **Depends on Task 10 — implement Task 10 FIRST.** This task's Server Components import
> `AddCredentialLauncher` (empty-wallet-state) and `ReverifyButton` (credential-card), both created
> in Task 10, which has NO dependency on this task. A subagent running strictly in order MUST
> implement Task 10 before Task 9 so this task's tests reach a real green/commit cycle atomically —
> the tests below render the real client components (fine in jsdom) and will fail to import if Task 10
> is absent. If you are executing sequentially and Task 10 is not yet done, jump to Task 10, complete
> and commit it, then return here. (Tasks 9 and 10 may also be executed together as one unit.)

**Files:**
- Create: `components/credential-card.tsx`, `components/credential-grid.tsx`, `components/empty-wallet-state.tsx`
- Create: `components/credential-card.test.tsx`, `components/credential-grid.test.tsx`, `components/empty-wallet-state.test.tsx`

**Interfaces:**
- Consumes: `VerificationBadge` from `@/components/verification-badge`; `Button` from `@/components/ui/button`; `AddCredentialLauncher` from `@/components/add-credential/add-credential-launcher` (Task 10 — implemented first); `ReverifyButton` from `@/components/reverify-button` (Task 10 — implemented first)
- Produces:
  ```ts
  export interface WalletCredential {
    id: string;
    title: string;
    issuer_name: string;
    issued_date: string | null;
    verification_status: "verified" | "unverified" | "failed";
  }
  export function CredentialCard(props: { credential: WalletCredential }): React.JSX.Element;
  export function CredentialGrid(props: { credentials: WalletCredential[] }): React.JSX.Element;
  export function EmptyWalletState(): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`components/credential-card.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CredentialCard, type WalletCredential } from "./credential-card";

const base: WalletCredential = {
  id: "c1",
  title: "Welding Level 1",
  issuer_name: "Acme Trade School",
  issued_date: "2024-05-01",
  verification_status: "verified",
};

test("renders title, issuer, formatted date, and the verified badge", () => {
  render(<CredentialCard credential={base} />);
  expect(screen.getByRole("heading", { name: "Welding Level 1" })).toBeInTheDocument();
  expect(screen.getByText("Acme Trade School")).toBeInTheDocument();
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

test("shows a fallback when the issued date is missing", () => {
  render(<CredentialCard credential={{ ...base, issued_date: null }} />);
  expect(screen.getByText("Date not provided")).toBeInTheDocument();
});

test("shows the failed badge for a failed credential", () => {
  render(<CredentialCard credential={{ ...base, verification_status: "failed" }} />);
  expect(screen.getByText("Verification failed")).toBeInTheDocument();
});
```

`components/credential-grid.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CredentialGrid, type WalletCredential } from "./credential-grid";

function cred(id: string, title: string): WalletCredential {
  return { id, title, issuer_name: "I", issued_date: null, verification_status: "unverified" };
}

test("renders one list item per credential", () => {
  render(
    <CredentialGrid credentials={[cred("a", "Alpha"), cred("b", "Beta"), cred("c", "Gamma")]} />
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("Gamma")).toBeInTheDocument();
});
```

`components/empty-wallet-state.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { EmptyWalletState } from "./empty-wallet-state";

test("shows the empty message and an Add-credential CTA", () => {
  render(<EmptyWalletState />);
  expect(screen.getByText(/your wallet is empty/i)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /add (your first )?credential/i })
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- components/credential-card.test.tsx components/credential-grid.test.tsx components/empty-wallet-state.test.tsx`
Expected: FAIL — the components (and their Task-10 imports) do not exist yet.

- [ ] **Step 3: Write `components/credential-card.tsx`**

```tsx
import { VerificationBadge } from "@/components/verification-badge";
import { ReverifyButton } from "@/components/reverify-button";

export interface WalletCredential {
  id: string;
  title: string;
  issuer_name: string;
  issued_date: string | null;
  verification_status: "verified" | "unverified" | "failed";
}

function formatDate(iso: string | null): string {
  if (!iso) return "Date not provided";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "Date not provided";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function CredentialCard({ credential }: { credential: WalletCredential }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-foreground/10 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-heading text-lg font-semibold leading-snug">
          {credential.title || "Untitled credential"}
        </h3>
        <VerificationBadge status={credential.verification_status} />
      </div>
      <p className="text-sm text-foreground/80">
        {credential.issuer_name || "Unknown issuer"}
      </p>
      <p className="text-sm text-foreground/60">{formatDate(credential.issued_date)}</p>
      <div className="mt-auto pt-2">
        <ReverifyButton credentialId={credential.id} />
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Write `components/credential-grid.tsx`**

```tsx
import { CredentialCard, type WalletCredential } from "@/components/credential-card";

export type { WalletCredential };

export function CredentialGrid({
  credentials,
}: {
  credentials: WalletCredential[];
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {credentials.map((c) => (
        <CredentialCard key={c.id} credential={c} />
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Write `components/empty-wallet-state.tsx`**

```tsx
import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";

export function EmptyWalletState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-foreground/20 px-4 py-16 text-center">
      <h2 className="font-heading text-xl font-semibold">Your wallet is empty</h2>
      <p className="max-w-sm text-foreground/70">
        Add your certificates, badges, and licenses to build a verifiable skills profile.
      </p>
      <AddCredentialLauncher label="Add your first credential" />
    </div>
  );
}
```

- [ ] **Step 6: Run the tests (expected PASS)**

Run: `npm test -- components/credential-card.test.tsx components/credential-grid.test.tsx components/empty-wallet-state.test.tsx`
Expected: 3 + 1 + 1 = passing (7 assertions across the files). Task 10's `AddCredentialLauncher`/`ReverifyButton` are already present (implemented first, per the dependency note above), so the imports resolve and the suite is green.

- [ ] **Step 7: Commit**

```bash
git add components/credential-card.tsx components/credential-grid.tsx components/empty-wallet-state.tsx \
  components/credential-card.test.tsx components/credential-grid.test.tsx components/empty-wallet-state.test.tsx
git commit -m "feat: wallet credential card, grid, and empty state (accessible, mobile-first)"
```

---

### Task 10: Add-credential flow — launcher, dialog, forms, re-verify (Client Components)

> **Implement this BEFORE Task 9.** Task 10 has no dependency on Task 9's grid components, but
> Task 9 imports `AddCredentialLauncher` and `ReverifyButton` from here. Building Task 10 first lets
> both tasks complete atomic TDD (red → green → commit) cycles. Its own tests below stub nothing and
> pass standalone.

> **Accessibility bar (WCAG AA, non-negotiable — spec §8).** The dialog is `role="dialog"
> aria-modal="true"` labelled by its heading; focus moves into it on open and returns to the
> launcher on close; Escape and backdrop click close it; the tablist is `role="tablist"` with
> arrow-key navigation; every input has a real `<label>`; errors render in `role="alert"`,
> success in `role="status"`. Pending states change button TEXT ("Adding…"), never spinner-only.
> Full-screen sheet under `sm`, centered card at `sm+`. Reuses `Button` (already 44×44px).

**Files:**
- Create: `components/add-credential/add-credential-launcher.tsx`, `components/add-credential/add-credential-dialog.tsx`, `components/add-credential/import-by-url-form.tsx`, `components/add-credential/import-by-file-form.tsx`, `components/add-credential/import-manual-form.tsx`, `components/reverify-button.tsx`
- Create: `components/add-credential/add-credential-launcher.test.tsx`, `components/add-credential/import-manual-form.test.tsx`, `components/reverify-button.test.tsx`

**Interfaces:**
- Consumes: `Button` from `@/components/ui/button`; the Server Actions from `@/app/app/wallet/actions` (bound to `<form action={...}>`)
- Produces:
  ```ts
  export function AddCredentialLauncher(props: { label?: string }): React.JSX.Element;
  export function AddCredentialDialog(props: { onClose: () => void }): React.JSX.Element;
  export function ImportByUrlForm(): React.JSX.Element;
  export function ImportByFileForm(): React.JSX.Element;
  export function ImportManualForm(): React.JSX.Element;
  export function ReverifyButton(props: { credentialId: string }): React.JSX.Element;
  ```
  The forms use plain `<form action={serverAction}>` (progressive enhancement; the actions redirect on success). Client-side required-field guards prevent empty submits and surface inline `role="alert"` messages.

- [ ] **Step 1: Write the failing tests**

`components/add-credential/add-credential-launcher.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AddCredentialLauncher } from "./add-credential-launcher";

test("clicking the launcher opens the dialog and moves focus to the first tab", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  const trigger = screen.getByRole("button", { name: /add credential/i });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeInTheDocument();
  // Focus must land on a meaningful control — the first (URL) tab — not the bare close "✕".
  const urlTab = screen.getByRole("tab", { name: /url/i });
  expect(document.activeElement).toBe(urlTab);
});

test("Escape closes the dialog and returns focus to the launcher", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  const trigger = screen.getByRole("button", { name: /add credential/i });
  await user.click(trigger);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(trigger);
});

test("the dialog exposes URL, File, and Manual tabs", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));
  expect(screen.getByRole("tab", { name: /url/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /file/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /manual/i })).toBeInTheDocument();
});
```

`components/add-credential/import-manual-form.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ImportManualForm } from "./import-manual-form";

test("renders labelled required title + optional fields", () => {
  render(<ImportManualForm />);
  expect(screen.getByLabelText(/title/i)).toBeRequired();
  expect(screen.getByLabelText(/issuer/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
});

test("blocks submit with an empty title and shows a role=alert message", async () => {
  const user = userEvent.setup();
  render(<ImportManualForm />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));
  expect(screen.getByRole("alert")).toHaveTextContent(/title is required/i);
});
```

`components/reverify-button.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ReverifyButton } from "./reverify-button";

test("renders a re-verify control carrying the credential id", () => {
  render(<ReverifyButton credentialId="c-123" />);
  const button = screen.getByRole("button", { name: /verify/i });
  expect(button).toBeInTheDocument();
  const hidden = button
    .closest("form")!
    .querySelector('input[name="credential_id"]') as HTMLInputElement;
  expect(hidden.value).toBe("c-123");
});
```

- [ ] **Step 2: Run the tests (expected FAIL)**

Run: `npm test -- components/add-credential components/reverify-button.test.tsx`
Expected: FAIL — the components do not exist yet.

- [ ] **Step 3: Write `components/reverify-button.tsx`**

```tsx
"use client";

import { useTransition } from "react";
import { reverifyCredential } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

export function ReverifyButton({ credentialId }: { credentialId: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => startTransition(() => reverifyCredential(formData))}
    >
      <input type="hidden" name="credential_id" value={credentialId} />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? "Verifying…" : "Re-verify"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? "Verifying credential" : ""}
      </span>
    </form>
  );
}
```

- [ ] **Step 4: Write `components/add-credential/import-manual-form.tsx`**

```tsx
"use client";

import { useState } from "react";
import { importManual } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

const field =
  "mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 text-base";

export function ImportManualForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importManual}
      className="space-y-4"
      onSubmit={(e) => {
        const title = new FormData(e.currentTarget).get("title");
        if (!String(title ?? "").trim()) {
          e.preventDefault();
          setError("Title is required.");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="m-title" className="block text-sm font-medium">
          Title
        </label>
        <input id="m-title" name="title" required className={field} />
      </div>
      <div>
        <label htmlFor="m-issuer" className="block text-sm font-medium">
          Issuer
        </label>
        <input id="m-issuer" name="issuer_name" className={field} />
      </div>
      <div>
        <label htmlFor="m-date" className="block text-sm font-medium">
          Date earned
        </label>
        <input id="m-date" name="issued_date" type="date" className={field} />
      </div>
      <div>
        <label htmlFor="m-desc" className="block text-sm font-medium">
          Description
        </label>
        <textarea id="m-desc" name="description" rows={3} className={field} />
      </div>
      {error ? (
        <p className="text-sm text-[var(--color-failed)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full">
        Add credential
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: Write `components/add-credential/import-by-url-form.tsx`**

```tsx
"use client";

import { useState } from "react";
import { importByUrl } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

export function ImportByUrlForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importByUrl}
      className="space-y-4"
      onSubmit={(e) => {
        const url = String(new FormData(e.currentTarget).get("url") ?? "").trim();
        if (!url) {
          e.preventDefault();
          setError("Paste a credential URL.");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="u-url" className="block text-sm font-medium">
          Credential URL
        </label>
        <input
          id="u-url"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://issuer.example/badge.json"
          required
          className="mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 text-base"
        />
      </div>
      {error ? (
        <p className="text-sm text-[var(--color-failed)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full">
        Add credential
      </Button>
    </form>
  );
}
```

- [ ] **Step 6: Write `components/add-credential/import-by-file-form.tsx`**

```tsx
"use client";

import { useState } from "react";
import { importByFile } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ".json,.png,.svg,application/json,image/png,image/svg+xml";

export function ImportByFileForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importByFile}
      className="space-y-4"
      onSubmit={(e) => {
        const file = new FormData(e.currentTarget).get("file");
        if (!(file instanceof File) || file.size === 0) {
          e.preventDefault();
          setError("Choose a badge file (.json, .png, or .svg).");
        } else if (file.size > MAX_BYTES) {
          e.preventDefault();
          setError("File is too large (5 MB max).");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="f-file" className="block text-sm font-medium">
          Badge file
        </label>
        <input
          id="f-file"
          name="file"
          type="file"
          accept={ACCEPT}
          required
          className="mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 py-2 text-base"
        />
        <p className="mt-1 text-sm text-foreground/60">
          Open Badges JSON, or a baked PNG / SVG badge. Some badge images don&apos;t include
          embedded data — if yours doesn&apos;t import, paste its URL or add it manually.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-[var(--color-failed)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full">
        Add credential
      </Button>
    </form>
  );
}
```

- [ ] **Step 7: Write `components/add-credential/add-credential-dialog.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { ImportByUrlForm } from "./import-by-url-form";
import { ImportByFileForm } from "./import-by-file-form";
import { ImportManualForm } from "./import-manual-form";

type Tab = "url" | "file" | "manual";
const TABS: { id: Tab; label: string }[] = [
  { id: "url", label: "URL" },
  { id: "file", label: "File" },
  { id: "manual", label: "Manual" },
];

export function AddCredentialDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("url");
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstTabRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on mount, onto the FIRST TAB (the first meaningful control) rather
  // than whatever happens to be first in DOM order — landing on a bare "✕" close icon is an
  // accessibility smell. The tablist is rendered before the close button in DOM order too, so even
  // a generic first-focusable heuristic would not grab the dismiss control.
  useEffect(() => {
    (firstTabRef.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      ))?.focus();
  }, []);

  // Escape to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onTabKey(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + TABS.length) % TABS.length;
    setTab(TABS[next].id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cred-title"
        className="w-full max-w-md rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl"
      >
        <h2 id="add-cred-title" className="mb-4 font-heading text-lg font-semibold">
          Add credential
        </h2>

        {/* Tablist BEFORE the close button in DOM order, so focus/tab order reaches a meaningful
            control (a tab) before the dismiss "✕". */}
        <div role="tablist" aria-label="Import method" className="mb-4 flex gap-1">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={i === 0 ? firstTabRef : undefined}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={
                "min-h-11 flex-1 rounded-md px-3 text-sm font-medium " +
                (tab === t.id
                  ? "bg-primary text-white"
                  : "bg-foreground/5 text-foreground hover:bg-foreground/10")
              }
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-11 min-w-11 shrink-0 rounded-md text-foreground/60 hover:bg-foreground/5"
          >
            ✕
          </button>
        </div>

        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "url" ? <ImportByUrlForm /> : null}
          {tab === "file" ? <ImportByFileForm /> : null}
          {tab === "manual" ? <ImportManualForm /> : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Write `components/add-credential/add-credential-launcher.tsx`**

```tsx
"use client";

import { useRef, useState } from "react";
import { AddCredentialDialog } from "./add-credential-dialog";
import { cn } from "@/lib/cn";

// The trigger needs a ref so focus can return to it on dialog close. The repo's
// components/ui/button.tsx types its props as React.ButtonHTMLAttributes & {variant?}, which does
// NOT include `ref` — passing ref={triggerRef} to <Button> is a hard TS2322 error under this
// repo's @types/react@19 + tsconfig. Rather than modify Plan 1's shared Button, we render a native
// <button> here, reusing Button's exact class string so it stays visually identical (primary variant).
const TRIGGER_CLASSES = cn(
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-4 text-base font-medium",
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  "disabled:pointer-events-none disabled:opacity-50",
  "bg-primary text-white hover:bg-secondary"
);

export function AddCredentialLauncher({ label }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    triggerRef.current?.focus(); // return focus to the trigger
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={TRIGGER_CLASSES}
        onClick={() => setOpen(true)}
      >
        {label ?? "Add credential"}
      </button>
      {open ? <AddCredentialDialog onClose={close} /> : null}
    </>
  );
}
```

> **Why a native `<button>`, not `<Button>`, for the trigger.** `components/ui/button.tsx` (Plan 1)
> types its props as `React.ButtonHTMLAttributes<HTMLButtonElement> & { variant? }`, which does NOT
> include `ref` (ref comes from `ClassAttributes`/`RefAttributes`, not `ButtonHTMLAttributes`).
> Passing `ref={triggerRef}` to `<Button>` is a hard compile error (`TS2322: Property 'ref' does not
> exist on type 'IntrinsicAttributes & ButtonHTMLAttributes<...> & { variant? }'`) under this repo's
> `@types/react@19` + `tsconfig`, which would break `npx tsc --noEmit` in Task 11 Step 4 and Task 12
> Step 5. We therefore render a native `<button>` reusing Button's exact class string, leaving Plan 1's
> shared `Button` untouched. (Every OTHER button in this flow — the forms' submit buttons, the
> re-verify button — needs no ref and keeps using `<Button>`.)

- [ ] **Step 9: Run the tests (expected PASS)**

Run: `npm test -- components/add-credential components/reverify-button.test.tsx`
Expected: all passing (3 launcher + 2 manual-form + 1 reverify).

- [ ] **Step 10: Commit**

```bash
git add components/add-credential components/reverify-button.tsx
git commit -m "feat: accessible Add-credential dialog (URL/file/manual tabs) + re-verify button"
```

---

### Task 11: Wire the wallet page + import route + loading skeleton

**Files:**
- Modify: `app/app/page.tsx`
- Create: `app/app/loading.tsx`, `app/app/wallet/import/page.tsx`

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server`; `CredentialGrid`/`WalletCredential` from `@/components/credential-grid`; `EmptyWalletState` from `@/components/empty-wallet-state`; `AddCredentialLauncher` from `@/components/add-credential/add-credential-launcher`
- Produces: the rendered My Wallet screen (card grid + Add CTA), a skeleton loading state, and a dedicated `/app/wallet/import` route (progressive-enhancement fallback that reads `?error=<code>`)

- [ ] **Step 1: Rewrite `app/app/page.tsx`**

```tsx
import { createServerClient } from "@/lib/supabase/server";
import { CredentialGrid, type WalletCredential } from "@/components/credential-grid";
import { EmptyWalletState } from "@/components/empty-wallet-state";
import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";

export default async function WalletHome() {
  const supabase = await createServerClient();
  // RLS (credentials_owner_all) scopes this to the signed-in earner — no manual filter needed.
  const { data } = await supabase
    .from("credentials")
    .select("id, title, issuer_name, issued_date, verification_status")
    .order("created_at", { ascending: false });
  const credentials = (data ?? []) as WalletCredential[];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-bold">My Wallet</h1>
        {credentials.length > 0 ? <AddCredentialLauncher /> : null}
      </div>
      {credentials.length === 0 ? (
        <EmptyWalletState />
      ) : (
        <CredentialGrid credentials={credentials} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `app/app/loading.tsx`**

```tsx
export default function WalletLoading() {
  return (
    <div>
      <div className="mb-6 h-8 w-40 animate-pulse rounded bg-foreground/10" />
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-32 animate-pulse rounded-lg border border-foreground/10 bg-foreground/5"
          />
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Write `app/app/wallet/import/page.tsx`**

```tsx
import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_url: "That does not look like a valid URL. Paste the full https:// address.",
  fetch_failed: "We could not reach that URL. Check the link and try again.",
  invalid_json: "That URL did not return valid JSON.",
  unrecognized_credential: "That URL did not return a recognizable credential.",
  no_file: "Choose a badge file to upload.",
  bad_type: "That file type is not supported. Use JSON, PNG, or SVG.",
  too_large: "That file is too large (5 MB max).",
  missing_title: "A title is required for a manual credential.",
};

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] : null;
  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-heading text-2xl font-bold">Add a credential</h1>
      <p className="mt-2 text-foreground/70">
        Import by URL, upload a badge file, or enter one manually.
      </p>
      {message ? (
        <p className="mt-4 text-sm text-[var(--color-failed)]" role="alert">
          {message}
        </p>
      ) : null}
      <div className="mt-6">
        <AddCredentialLauncher label="Add credential" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; the build succeeds (Server Components + client islands compile; Server Actions resolve).

- [ ] **Step 5: Commit**

```bash
git add app/app/page.tsx app/app/loading.tsx app/app/wallet/import/page.tsx
git commit -m "feat: wire My Wallet grid + Add-credential CTA + import route + loading skeleton"
```

---

### Task 12: Hosted-DB integration — import flow + Storage RLS

> **Requires:** reachable hosted Supabase, `.env.local` populated, the O\*NET vocabulary seeded
> (Plan 2's `node scripts/seed-onet.mjs`), and the `0004_credential_storage.sql` migration applied
> (Task 6). No real Anthropic call (inject a fake `LlmClient`); no real issuer URL (manual source
> needs no fetch). Cleanup deletes the auth user (cascades `credentials`/`credential_skills`/
> `earner_skills`) AND explicitly removes Storage objects (not FK-cascaded).

**Files:**
- Create: `tests/db/credentials-import.test.ts`, `tests/db/credential-storage-rls.test.ts`

**Interfaces:**
- Consumes: `adminClient()` from `./admin-client`, `makeUserClient()` from `./user-client`; `createCredentialAndProcess` from `@/lib/credentials/create`; `uploadCredentialFile` from `@/lib/credentials/storage`; `LlmClient` from `@/lib/skills/types`
- Produces: proof that (1) a manual import creates the row + rolls up `earner_skills` via the real skills engine, (2) a thrown `processCredential` never rolls back the credential row, (3) Storage RLS isolates earners.

- [ ] **Step 1: Write the failing import-flow test `tests/db/credentials-import.test.ts`**

```ts
import { afterAll, expect, test, vi } from "vitest";
import { adminClient } from "./admin-client";
import { createCredentialAndProcess } from "@/lib/credentials/create";
import { getSkillVocabulary } from "@/lib/skills/data";
import type { LlmClient } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

async function seedEarner(): Promise<string> {
  const email = `imp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin
    .from("earners")
    .insert({ id: earnerId, handle: `imp${Date.now()}${Math.floor(Math.random() * 1000)}` });
  return earnerId;
}

test("manual import: creates an unverified row and rolls up earner_skills", async () => {
  const earnerId = await seedEarner();
  // Use a real seeded skill name so normalize produces an exact match via the fake LLM.
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill")!;
  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => [
      { rawName: target.canonical_name, type: "skill" as const, confidence: 0.7, source: "llm" as const },
    ]),
  };

  const { credentialId, verificationStatus } = await createCredentialAndProcess(
    admin,
    fakeLlm,
    {
      earnerId,
      source: "manual",
      manual: {
        title: "Paper Certificate",
        issuerName: "Night School",
        issuedDate: "2023-09-01",
        description: "Some description text.",
      },
    }
  );

  expect(verificationStatus).toBe("unverified");

  const { data: row } = await admin
    .from("credentials")
    .select("source, title, issuer_name, issued_date, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row).toMatchObject({
    source: "manual",
    title: "Paper Certificate",
    issuer_name: "Night School",
    issued_date: "2023-09-01",
    verification_status: "unverified",
  });

  const { data: es } = await admin
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  expect(es).toHaveLength(1);
  expect(es![0].skill_id).toBe(target.id);
});

test("a thrown processCredential does NOT roll back / delete the credential row", async () => {
  const earnerId = await seedEarner();
  const throwingLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("simulated skills failure");
    }),
  };

  // Manual with a description forces the LLM path (no structured data), so the throw fires.
  const { credentialId } = await createCredentialAndProcess(admin, throwingLlm, {
    earnerId,
    source: "manual",
    manual: {
      title: "Resilient Cert",
      issuerName: "Issuer",
      issuedDate: null,
      description: "text that triggers llm extraction",
    },
  });

  const { data: row } = await admin
    .from("credentials")
    .select("id, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row?.id).toBe(credentialId); // row survived the skills failure
  expect(row?.verification_status).toBe("unverified");
});
```

- [ ] **Step 2: Run the import-flow test (expected PASS)**

Run: `npm test -- tests/db/credentials-import.test.ts`
Expected: 2 passed. (Requires seeded vocabulary; if `vocab.find` returns undefined, run `node scripts/seed-onet.mjs`.)

- [ ] **Step 3: Write the failing Storage-RLS test `tests/db/credential-storage-rls.test.ts`**

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];
const uploadedPaths: string[] = [];

afterAll(async () => {
  if (uploadedPaths.length > 0) {
    await admin.storage.from("credential-files").remove(uploadedPaths);
  }
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("earner B cannot read earner A's uploaded credential file", async () => {
  const a = await makeUserClient(`sa-${Date.now()}@example.com`);
  const b = await makeUserClient(`sb-${Date.now()}@example.com`);
  created.push(a.userId, b.userId);
  await a.client.from("earners").insert({ id: a.userId, handle: `sa${Date.now()}` });
  await b.client.from("earners").insert({ id: b.userId, handle: `sb${Date.now()}` });

  // A uploads under their own {userId}/... path via their RLS-scoped session client.
  const path = `${a.userId}/cred-1/badge.json`;
  const { error: upErr } = await a.client.storage
    .from("credential-files")
    .upload(path, Buffer.from('{"type":"Assertion"}'), {
      contentType: "application/json",
      upsert: true,
    });
  expect(upErr).toBeNull();
  uploadedPaths.push(path);

  // B tries to download A's object — Storage RLS must deny it.
  const { data: bData, error: bErr } = await b.client.storage
    .from("credential-files")
    .download(path);
  expect(bData).toBeNull();
  expect(bErr).not.toBeNull();

  // A can download their own object.
  const { data: aData, error: aErr } = await a.client.storage
    .from("credential-files")
    .download(path);
  expect(aErr).toBeNull();
  expect(aData).not.toBeNull();
});

test("earner B cannot upload into earner A's folder", async () => {
  const a = await makeUserClient(`sc-${Date.now()}@example.com`);
  const b = await makeUserClient(`sd-${Date.now()}@example.com`);
  created.push(a.userId, b.userId);
  // Insert earners rows for parity with real signed-up users (and the first test in this file),
  // so the fixture stays consistent and forward-compatible with any future earners-aware policy.
  await a.client.from("earners").insert({ id: a.userId, handle: `sc${Date.now()}` });
  await b.client.from("earners").insert({ id: b.userId, handle: `sd${Date.now()}` });

  const { error } = await b.client.storage
    .from("credential-files")
    .upload(`${a.userId}/cred-x/evil.json`, Buffer.from("{}"), {
      contentType: "application/json",
      upsert: true,
    });
  expect(error).not.toBeNull(); // insert policy checks foldername[1] = auth.uid()
});
```

- [ ] **Step 4: Run the Storage-RLS test (expected PASS)**

Run: `npm test -- tests/db/credential-storage-rls.test.ts`
Expected: 2 passed. (Requires the `0004` migration applied. If B's download unexpectedly succeeds, the Storage policies did not apply — re-check Task 6 Step 2's Management-API response.)

- [ ] **Step 5: Full suite + typecheck + build**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: no type errors; all Plan 1 + Plan 2 + Plan 3 tests pass; build succeeds. (Plan 3 adds: parse-ob, extract-baked-badge, did-key, verify, credential-card, credential-grid, empty-wallet-state, add-credential-launcher, import-manual-form, reverify-button, credentials-import, credential-storage-rls.)

- [ ] **Step 6: Commit**

```bash
git add tests/db/credentials-import.test.ts tests/db/credential-storage-rls.test.ts
git commit -m "test: hosted-DB integration for import flow + credential-file Storage RLS"
```

---

## Self-Review

**Spec coverage (Plan 3 scope = design doc §4 import paths, §5 import & verification, §8 My Wallet UX, §9 subsystem 1 wallet core):**
- §4/§5 **Import path 1 — OB/VC by URL:** `importByUrl` Server Action fetches (own try/catch → `fetch_failed`), parses JSON in a SEPARATE try/catch (`invalid_json` for a reachable-but-non-JSON body — distinct from an unreachable URL), and guards the parsed envelope with `parseOpenBadge` (empty title → `unrecognized_credential`) so a syntactically-valid-but-unrecognized object (e.g. `{}` or an unrelated API's `{"status":"ok"}`) never becomes a blank wallet row. `redirect()` is kept out of the try blocks (it signals via a thrown `NEXT_REDIRECT`). ✅
- §5 **Import path 2 — file upload incl. baked PNG/SVG:** `importByFile` → `createCredentialAndProcess` → `rawJsonFromFile` (JSON direct; `extractBakedAssertion` for PNG `iTXt`/`tEXt` + SVG element, best-effort) → private Storage upload (`storage_path` set). Unparseable image still stored `unverified` (`raw_json: null`). ✅
- §5 **Import path 3 — manual entry:** `importManual` → always `unverified`, still feeds the skills profile (verifier not invoked; `processCredential` runs). The user-entered description is persisted into `raw_json` (`{ description }`) so Plan 2's `descriptionFrom` feeds it to the extractor — the manual description is NOT dropped. ✅
- §4 **Metadata parse → `credentials` columns:** `parseOpenBadge` maps OB2.x/OB3.0/VC → `{title, issuerName, issuedDate, description}` written verbatim into `title`/`issuer_name`/`issued_date` (`raw_json`, `storage_path`, `source` also set). ✅
- §5 **Verification (verified/unverified/failed):** OB2.x hosted re-fetch — detection covers BOTH the legacy `verify.url` shape and canonical OB2.0 (`verification: HostedBadge` + URL in `id`); `verified` requires not-revoked AND an identity match (re-fetched `id` == stored `id`), so a reachable-but-unrelated document is `failed` and a reachable id-less assertion is honest `unverified` (closing the "any 200 = verified" gap); 404/throw/revoked/mismatch → failed. OB3.0/VC compact-JWT signature via `jose` against a `did:key` Ed25519 key (valid → verified; tampered/expired → failed); everything out of scope → honest `unverified`. On-demand re-verify (`reverifyCredential` + `ReverifyButton`) reuses the identical `verifyCredential`. Expectation set honestly (Task 5 scope note): a meaningful fraction of real-world imports will be `unverified` at launch. ✅
- §5 **Supabase Storage:** private `credential-files` bucket + path-scoped `storage.objects` RLS via `0004_credential_storage.sql`, applied through the Management-API script; cross-earner isolation proven in `credential-storage-rls.test.ts`. ✅
- §8 **My Wallet:** RSC card grid (`CredentialGrid`/`CredentialCard` with `VerificationBadge`), `EmptyWalletState`, prominent `AddCredentialLauncher` CTA; loading skeleton; mobile-first grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`), full-screen dialog under `sm`; WCAG-AA dialog (focus trap/return, Escape, `role=dialog/tablist/alert/status`, real `<label>`s, 44×44px via `Button`). ✅
- §9 subsystem-1 **wiring:** import → `credentials` row → `processCredential` (Plan 2, unmodified) → grid refresh via `revalidatePath`. Explicitly NOT the public profile (Plan 4), advisor (Plan 5), or sponsor console (Plan 6). ✅

**Deferred / flagged (stated so they aren't silently dropped):**
- **OB3.0/VC LD-proofs (DataIntegrityProof / Ed25519Signature2020) and non-`did:key` DID methods (`did:web` etc.)** are OUT of v1 — the heavy `@digitalbazaar` JSON-LD stack + general DID resolution is the single biggest scope risk; v1 verifies only compact JWT VCs against `did:key` and returns honest `unverified` for the rest. Flag for a follow-up once a real OB3.0 pilot badge exists to test against. (Task 5.)
- **VC StatusList2021 revocation** not checked (only the OB2.x hosted path gets revocation, for free via re-fetch). (Task 5.)
- **Compressed iTXt** PNG chunks unsupported (best-effort → `null`; a test documents this boundary). More broadly, baked-badge extraction is **best-effort**: many real production PNGs store the assertion in a zlib-compressed iTXt chunk or as a URL rather than inline JSON, so a meaningful fraction of real baked badges will not parse and will land honestly `unverified` (`raw_json: null`). The file-import copy tells the earner to fall back to URL/manual when an image doesn't import. (Task 3 / Task 10 file form.)
- **Displaying / downloading the uploaded original file is OUT of v1 scope.** `getSignedFileUrl` (`storage.ts`) is implemented and exported (so a later "View original file" affordance is a one-liner) but is intentionally NOT wired into any card/grid this plan — `WalletCredential` carries only title/issuer/date/status. The export is deliberate forward-provisioning, not an oversight; wiring a signed-URL "View file" button on `CredentialCard` for `source:'ob_file'` is a Plan-4/follow-up item. (Task 6 / Task 9.)
- **Field-level granular error display** beyond `?error=<code>` redirect + inline client guards is a possible follow-up (`useActionState` plumbing) — acceptable for v1's plain UX. (Tasks 8/10/11.)
- **Synchronous `processCredential` in the request path** is acceptable at pilot scale; move to a background job later if LLM latency bites. (Task 7.)

**Placeholder scan:** No "similar to Task N" / "add error handling" / elided-body placeholders. Every code step shows complete, final code, and every test step states the exact command + expected pass count. The one migration (`0004`) is fully written; all others reuse existing schema. ✅

**Type consistency (verified across tasks):**
- The Plan-3 type set is defined once in `lib/credentials/types.ts` (Task 1) and imported via `@/lib/credentials/types`. `VerificationStatus`/`CredentialSource` values match the `verification_status` and `credential_source` enums in `0002_core_schema.sql` verbatim.
- `parseOpenBadge(rawJson): ParsedCredential` (Task 2) is used in two consistent places: `actions.ts` (Task 8) calls it as an up-front envelope guard (empty title → `unrecognized_credential` redirect, never a garbage row) for `ob_url` and JSON `ob_file` imports, and `createCredentialAndProcess` (Task 7) calls it again to derive the persisted `credentials(earner_id, source, raw_json, issuer_name, title, issued_date, storage_path, verification_status)` — exact column names from `0002_core_schema.sql`. (Baked PNG/SVG are exempt from the guard: an image with no embedded assertion is still stored honestly `unverified`.)
- `verifyCredential(input: VerifyInput, opts?: VerifyOpts): Promise<VerifyResult>` is identical in `verify.ts` (producer), `create.ts` (consumer), and `actions.ts`'s `reverifyCredential` (consumer); `fetchImpl` injected in every test.
- `WalletCredential` (`components/credential-card.tsx`) is `Pick<credentials, id|title|issuer_name|issued_date|verification_status>` — exactly the columns `app/app/page.tsx` selects.
- Plan 2 composition is by reference only: `processCredential(db, llm, credentialId)` from `@/lib/skills/index` and `createAnthropicLlmClient()` from `@/lib/skills/llm`, and `LlmClient`/`getSkillVocabulary` from `@/lib/skills/*` — no Plan 2 signature is changed. ✅

**Known environmental dependencies:** Task 6's migration and Task 12's integration tests require the hosted Supabase project reachable + `.env.local` populated; Task 12 also requires the O\*NET seed to have run (Plan 2). No test requires `ANTHROPIC_API_KEY` (fake `LlmClient` injected everywhere) or reaches a real issuer URL (`fetch` injected; manual source needs none) — CI stays at zero LLM/issuer-network spend, consistent with Plans 1–2.
