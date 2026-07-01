# Trove Public Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Task ordering:** implement Tasks 1 → 2 → 3 → **5 → 4** → 6. Task 4 (the public page) imports artifacts created in Task 5 (the verify action + `PublicVerifyButton`), and Task 5 has no dependency on Task 4, so Task 5 MUST be completed before Task 4 for each task's `tsc` to be green on its own. (The tasks are numbered by feature area; the two are simply executed 5-before-4.)

**Goal:** Build the Trove **public verifiable profile** (Plan 4) — the smallest slice of the core loop's step 5, "publish a verifiable public profile." An earner flips a single `public_profile_enabled` toggle on their wallet, and anyone (no account needed) can visit `/u/[handle]` to see that earner's display name and **all** of their credentials — publishing is **all-or-nothing at the profile level**: it exposes every current and future credential in the wallet (there is no per-credential visibility flag in Plan 4). Each credential shows its honest `VerificationBadge` state plus an on-demand **"Check now"** affordance that re-runs the exact same cryptographic/hosted verification against the issuer — **without ever writing to the database**. The public read path is enforced entirely by additive Postgres RLS policies gated on `public_profile_enabled = true`; anonymous viewers can only ever SELECT rows for earners who opted in, and can never write anything. The live-verify affordance reuses the already-shipped pure `verifyCredential()` unchanged, wrapped in a read-only Server Action with a bounded (https-only, private-IP-blocked, redirect-manual, timed-out) fetch to blunt the SSRF surface of the outbound issuer request.

**Architecture:** One new migration (`0005_public_profile_rls.sql`) adds two additive `for select` RLS policies — `earners_public_select` and `credentials_public_select` — alongside the existing owner-only policies from `0003_rls_policies.sql`. Postgres OR's permissive policies, so the owner keeps full self-access and anon gains **only** opted-in visibility; no policy is modified or dropped, and no service-role bypass or `SECURITY DEFINER` view is used (house style is raw RLS on base tables). The **publish toggle** is a small addition to the existing wallet home (`app/app/page.tsx`) via a new `PublishProfileCard` and a `updatePublicProfileEnabled` Server Action in a new `app/app/actions.ts`, reusing a newly-extracted `requireUserId()` helper — the write rides the pre-existing `earners_self_update` policy, so no new write policy is needed. The **public page** (`app/u/[handle]/page.tsx`) is an unauthenticated Server Component that queries the anon-key server client (which works fine without a session) and relies on RLS for the security boundary; a missing handle and a `public_profile_enabled = false` earner surface **identically** as "not found" (RLS returns zero rows in both cases, preventing enumeration of opted-out earners). The **live-verify affordance** is a read-only Server Action `publicReverifyCredential(handle, credentialId)` in `app/u/[handle]/actions.ts` that re-loads `raw_json` through the same anon-RLS path — joined to the viewed profile's `handle` so a viewer can only re-verify credentials on the profile they are on — calls `verifyCredential()` with an injected `boundedFetch`, and returns the transient `VerifyResult` for display — it **never** calls `.update()`. **The existing `CredentialCard`/`CredentialGrid` (Plan 3) are reused, not forked:** they gain an optional `action?: ReactNode` slot (and the grid an `action?: (credential) => ReactNode` render-prop) so the same components render both the authenticated wallet (with the write-capable `ReverifyButton`) and the public page (with a read-only `PublicVerifyButton`). No `formatDate`/markup is duplicated. The public page passes a `PublicVerifyButton` into that slot, replacing the write-capable `ReverifyButton`.

**Tech Stack:** TypeScript, `@supabase/supabase-js` + `@supabase/ssr` (already installed), React 19 + Next.js 16 (Server Actions, Server Components, dynamic route segments), Vitest + `@testing-library/react` for unit/component/integration tests. **No new dependencies** — this plan reuses `verifyCredential` (Plan 3, `jose`/`multiformats` already installed), the existing design-system `Button`/`VerificationBadge`, and the existing anon-key Supabase client factories. `AbortSignal.timeout` (Node ≥ 17.3 / the project's runtime) is used for the bounded fetch; no polyfill.

## Global Constraints

Every task's requirements implicitly include these (binding, from the spec and Plans 1–3):

- **Product name:** Trove. Domain: trove.io.
- **Stack (do not substitute):** Next.js + Supabase (Postgres/RLS/Auth/Storage) + Vercel + Stripe + Postmark + Claude Sonnet 4.6. Plan 4 adds **no AI** — it is the public profile only. It does NOT touch the AI advisor (Plan 5), the sponsor console (Plan 6), or any profile "portfolio" extras. No model is ever called on this path.
- **RLS is the enforcement layer, not app code.** The anon read path is added as raw additive `for select` policies on the base `earners`/`credentials` tables (house style, per `0003_rls_policies.sql`), NOT a `SECURITY DEFINER` view/function and NOT service-role + code-level gating. `.eq("public_profile_enabled", true)` in a query is defense-in-depth/short-circuit only — the RLS policy is what actually prevents access.
- **Migrations:** applied to the hosted Supabase project by POSTing SQL to the **Management API** via `node scripts/apply-migration.mjs <file>` (NOT `supabase db push`), numbered sequentially. The last committed migration is `0004_credential_storage.sql`; this plan adds exactly one, `supabase/migrations/0005_public_profile_rls.sql`. No schema change is needed — `earners.handle` (`citext unique not null`), `earners.display_name`, `earners.public_profile_enabled` (`boolean not null default false`), and all `credentials` columns already exist in `0002_core_schema.sql`.
- **No secrets in git.** `.env.local` is git-ignored and already populated (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). No `NEXT_PUBLIC_` exposure of any new secret; the public page uses the same anon key already shipped to the browser.
- **Anon can NEVER write.** This migration adds **only** `for select` policies. No insert/update/delete policy is granted to anon on `earners` or `credentials`, so the existing owner-only for-all policies (`credentials_owner_all`, `earners_self_*`) remain the sole write path, and RLS defaults to deny absent a matching policy. The live-verify affordance is **display-only**: `publicReverifyCredential` never calls `.update()`/`.upsert()` — even if it did by mistake, no anon update policy exists to permit it (enforced twice). The write-capable `ReverifyButton` (Plan 3) must NOT appear on the public page.
- **Missing and disabled are indistinguishable.** A nonexistent handle and an earner with `public_profile_enabled = false` both surface as the same "not found" state — RLS returns zero rows for both, preventing enumeration of who has opted out. The page calls `notFound()` on zero rows.
- **Anon exposure is limited to what the page needs.** The public page's `earners` query selects only `handle, display_name` (+`id` to key the credentials query); the `credentials` query for the *page render* selects only card fields (`id, title, issuer_name, issued_date, verification_status`) — **`raw_json` is NOT part of the page's SELECT**. `raw_json` is read only inside the live-verify Server Action, on-demand, for the single credential being re-checked (still via the same anon-RLS path). RLS gates access; the narrow select-lists are defense-in-depth against accidental payload leakage. `storage_path` is never selected for the public page (see SSRF/leakage notes below). **Known tradeoff (raw_json PII):** because `credentials_public_select` grants anon `select` on the whole row, an anon client *can* still request `raw_json` directly for any published credential, and `raw_json` is the full imported OB2/VC assertion — which per the Open Badges spec MAY carry a `recipient` identity/email, `evidence` URLs, or issuer-internal metadata that the rendered card never shows. Exposing it is **accepted** here because the same document is what the badge itself already publishes and it is required by the on-demand verify affordance; it is NOT asserted to be non-sensitive. Task 5's implementer MUST inspect the real imported-assertion shapes (`recipient`, `credentialSubject`) in the pilot's issuer set before this ships broadly; a redacted projection or a `security definer` verify RPC (which would let `raw_json` stay non-anon-readable) is a documented follow-up if PII is found.
- **SSRF/abuse bounds (stated honestly).** The outbound issuer fetch in the live-verify path is wrapped in a `boundedFetch` with, in order: **https-only** (throws before any network call on non-https URLs); a **literal-private-IP block** — the URL host is parsed and rejected before any network call if it is a literal IP address (IPv4 or IPv6, including IPv4-mapped IPv6) in a loopback / private / link-local / ULA range (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`) or a known cloud-metadata host (`metadata.google.internal`, `metadata`); **`redirect: "manual"`** (a redirect cannot transparently pivot into an internal address — the redirect is surfaced, not followed); and a **5s `AbortSignal.timeout`** (bounds a single request). This closes the direct-literal-private-IP SSRF class where an earner stores a hosted-verify URL like `https://169.254.169.254/…`, `https://[::1]:6379/`, or `https://10.0.0.1/` (the URL comes from earner-controlled `raw_json` via `detectHostedVerify()`, so it is untrusted). **Deferred, honestly NOT solved here (documented in code + follow-up):** a *hostname* that legitimately resolves via DNS to a private IP (DNS-rebinding / attacker-controlled resolver) is still reachable, because Node `fetch` does not expose the resolved IP and this plan does not add a pre-resolve `dns.lookup` guard — narrowing this fully is a follow-up (`dns.lookup` + block private results, or an egress proxy/allowlist). Per-IP / per-handle rate limiting also does NOT exist yet (candidate follow-up: a token bucket keyed by handle+credentialId). The authenticated `reverifyCredential` (Plan 3) keeps plain `fetch` since that earner already trusts their own submitted URL.
- **Reuse Plan 1–3, do not fork:** reuse `components/ui/button.tsx` (`Button`, `primary`/`secondary`/`ghost`, already 44×44px via `min-h-11 min-w-11`), `components/verification-badge.tsx` (`VerificationBadge`), and `lib/credentials/verify.ts`'s `verifyCredential(input, opts)` **unmodified** (`opts.fetchImpl` is the existing injection seam). **Reuse the existing `components/credential-card.tsx` (`CredentialCard`) and `components/credential-grid.tsx` (`CredentialGrid`) rather than creating parallel `public-credential-*.tsx` files** — add an optional action slot (Task 4) so one component set serves both the authenticated wallet and the public page; do NOT copy `formatDate`/card markup into a fork. Auth pattern mirrors `app/app/wallet/actions.ts` (`"use server"`, `createServerClient()`, `redirect` on no user). The public page's `createServerClient()` call works unauthenticated — it just forwards cookies/anon-key with no session.
- **WCAG AA + mobile-first (non-negotiable):** 4.5:1 contrast, visible focus rings, full keyboard nav, 44×44px targets, real `<label>`s, `role="status"`/`aria-live` live regions, `prefers-reduced-motion` (already handled in `app/globals.css`). The public profile and the "Check now" affordance must excel at 375px. Verification state is always unmissable (`VerificationBadge`, never color alone). The public profile must read as trustworthy and shareable with no account needed (spec §8 screen 3).
- **Vitest serial config unchanged:** `vitest.config.ts` runs `fileParallelism:false`, `pool:"forks"` (iCloud path constraint). Do not change it.
- **Mirror existing test patterns:** colocated `*.test.ts(x)` beside pure/component source (zero network/LLM/DB — inject `fetch`/action/Supabase stubs); hosted-DB integration tests under `tests/db/` use `adminClient()` (service-role, bypasses RLS) and `makeUserClient()` (RLS-scoped session) from `tests/db/*`, plus a fresh **anon** client via `createClient(url, anonKey)` (mirroring `lib/supabase/client.ts`) to exercise the anon policies; clean up seeded users with `admin.auth.admin.deleteUser(id)` in `afterAll` (FK `on delete cascade` from `0002_core_schema.sql` removes dependent `credentials`). No test calls a real issuer URL (inject `fetch`).

---

## File Structure

Files created/modified in this plan and their single responsibility:

- `supabase/migrations/0005_public_profile_rls.sql` — CREATE: two additive `for select` policies — `earners_public_select` and `credentials_public_select` — gated on `public_profile_enabled = true`; the anon read path. No write policy.
- `lib/auth/require-user.ts` — CREATE: extracted `requireUserId()` helper (redirect to `/login` if unauthenticated), previously inlined in `app/app/wallet/actions.ts`; now shared by two action files.
- `app/app/wallet/actions.ts` — MODIFY: import `requireUserId` from the extracted helper instead of its local copy (behavior-identical refactor).
- `app/app/actions.ts` — CREATE: `updatePublicProfileEnabled(formData)` Server Action — RLS-scoped update of the earner's own `public_profile_enabled`, then `revalidatePath("/app")`.
- `components/publish-profile-card.tsx` — CREATE: Server Component publish control — explanation, current-state label, a per-state `<form action={updatePublicProfileEnabled}>` toggle, the `/u/{handle}` URL, and a client copy-link island.
- `components/copy-link-button.tsx` — CREATE: the one small client island (`"use client"`) — `navigator.clipboard.writeText`, keyboard-reachable, 44×44px.
- `app/app/page.tsx` — MODIFY: fetch the earner's `handle, public_profile_enabled` alongside credentials; render `<PublishProfileCard />` above the grid/empty state.
- `app/u/[handle]/page.tsx` — CREATE: unauthenticated public profile Server Component — resolves the earner by handle via anon-RLS, loads their credentials, renders the reused `CredentialGrid` with a `PublicVerifyButton` action slot; `notFound()` on zero rows.
- `app/u/[handle]/actions.ts` — CREATE: `publicReverifyCredential(handle, credentialId)` read-only Server Action + `boundedFetch`; re-loads `raw_json` via anon-RLS (joined to the viewed `handle`), calls `verifyCredential`, returns the `VerifyResult` — never writes.
- `components/credential-card.tsx` — MODIFY: add an optional `action?: ReactNode` slot; when provided, render it in the footer instead of the default `<ReverifyButton>`. Behavior-identical for the existing wallet call site (no `action` → `ReverifyButton`, as today).
- `components/credential-grid.tsx` — MODIFY: add an optional `renderAction?: (credential: WalletCredential) => ReactNode` prop; forwards `renderAction?.(c)` into each card's `action` slot. No change when omitted.
- `components/public-verify-button.tsx` — CREATE: Client island — "Check now" button (`useTransition`), `role="status"` live region seeded with the credential's last-known status and rendering the transient live result. Takes `handle` + `credentialId`.
- `app/u/[handle]/not-found.tsx` — CREATE: friendly public 404 (profile not found / not published — same copy for both, per the missing-vs-disabled invariant).
- `supabase/migrations/0005_public_profile_rls.sql` tests → `tests/db/public-profile-rls.test.ts` — CREATE: hosted-DB integration proving the fail-closed anon boundary (private hidden, public visible, toggle-back hides again, missing==disabled enumeration parity, anon cannot write [insert rejected; update/delete error-or-zero-rows + owner-side unchanged proof], owner self-access unaffected).
- `lib/auth/require-user.test.ts` — CREATE: unit test — redirects to `/login` when no session (stubbed Supabase client).
- `components/publish-profile-card.test.tsx` — CREATE: component test — renders handle/URL, correct state label, opposite-state form points at the right `enabled` value, copy button keyboard-reachable.
- `app/u/[handle]/public-reverify.test.ts` — CREATE: unit test — `publicReverifyCredential` returns `null` when no row (and never calls `verifyCredential`), returns the `VerifyResult` on the happy path, and NEVER calls `.update()`/`.upsert()`; `boundedFetch` throws synchronously (before any network call) on non-https AND on literal-private-IP hosts (`https://169.254.169.254/`, `https://[::1]/`, `https://10.0.0.1/`), and passes `redirect:"manual"` + an `AbortSignal` to the underlying fetch for a public https host.
- `components/public-verify-button.test.tsx` — CREATE: component test — renders "Check now" (44×44px), invokes the injected action with `(handle, credentialId)`, surfaces the returned status in a `role="status"` region, and shows the seeded `initialStatus` before any click.

---

### Task 1: Anon read RLS (migration 0005) + fail-closed integration tests

> **Enforcement note.** Two ADDITIVE `for select` policies on the base tables. Postgres OR's permissive policies, so these only ADD anon/public visibility for opted-in earners — they never narrow the owner's own access (the `earners_self_*` / `credentials_owner_all` policies from `0003` are untouched). No `to anon` clause is needed: `for select using (...)` with no `to` role applies to `public` (all roles), which is what we want, since a logged-in non-owner viewing a friend's public page must also work. Writes are unaffected — no insert/update/delete policy is added, so anon writes stay RLS-denied by default.

**Files:**
- Create: `supabase/migrations/0005_public_profile_rls.sql`, `tests/db/public-profile-rls.test.ts`

**Interfaces:**
- Consumes: existing `earners`/`credentials` tables and `earners_self_*` / `credentials_owner_all` policies (`0003_rls_policies.sql`); `earners.public_profile_enabled boolean` (`0002_core_schema.sql`).
- Produces (SQL, in `0005_public_profile_rls.sql`):
  ```sql
  create policy earners_public_select on earners
    for select using (public_profile_enabled = true);

  create policy credentials_public_select on credentials
    for select using (
      exists (
        select 1 from earners e
        where e.id = credentials.earner_id
          and e.public_profile_enabled = true
      )
    );
  ```

- [ ] **Step 1: Write `supabase/migrations/0005_public_profile_rls.sql`**

```sql
-- Trove Plan 4: anonymous public-profile read path.
-- Applied via the Management API: node scripts/apply-migration.mjs supabase/migrations/0005_public_profile_rls.sql
--
-- Two ADDITIVE `for select` policies. Postgres OR's permissive policies together, so these
-- ONLY add anon/public visibility for earners who opted in (public_profile_enabled = true);
-- they never narrow the owner's own access (earners_self_select / credentials_owner_all from
-- 0003 remain in force). No `to` role clause => applies to `public` (all roles), which is what
-- we want: an anonymous visitor AND a logged-in non-owner viewing a friend's page both work.
-- No insert/update/delete policy is added, so anon writes stay RLS-denied by default.

-- Public read: an opted-in earner exposes their row (handle/display_name/id/created_at/flag)
-- to anyone. None of those columns is sensitive; a row-level policy is sufficient (no view needed).
create policy earners_public_select on earners
  for select using (public_profile_enabled = true);

-- Public read: credentials belonging to an opted-in earner. The EXISTS subquery re-checks the
-- parent earner's flag live on every row read, so flipping public_profile_enabled off takes
-- effect immediately with no staleness window.
-- KNOWN TRADEOFF (not a settled fact): this grants anon `select` on the WHOLE credential row,
-- including raw_json. The public PAGE query deliberately selects only card fields; the verify
-- action reads raw_json on-demand for one credential. But an anon client CAN still request
-- raw_json directly. raw_json is the full imported OB2/VC assertion, which per the Open Badges
-- spec MAY carry a `recipient` identity/email, `evidence` URLs, or issuer-internal metadata not
-- shown on the card. Exposing it is ACCEPTED here because it is the same document the badge
-- itself already publishes and is required by the on-demand verify affordance (spec §5) — it is
-- NOT claimed to be non-sensitive. FOLLOW-UP before broad production rollout: audit real OB2
-- `recipient`-field shapes in the pilot issuer set; if PII is present, add a redacted projection
-- or move verify behind a `security definer` RPC so raw_json need not be anon-readable.
create policy credentials_public_select on credentials
  for select using (
    exists (
      select 1 from earners e
      where e.id = credentials.earner_id
        and e.public_profile_enabled = true
    )
  );
```

- [ ] **Step 2: Apply the migration to the hosted project**

Run: `node scripts/apply-migration.mjs supabase/migrations/0005_public_profile_rls.sql`
Expected: success (the two policies are created). Re-running is not idempotent (`create policy` errors if it exists) — this is consistent with how prior migrations in this repo are applied once, in order.

- [ ] **Step 3: Write the fail-closed integration tests `tests/db/public-profile-rls.test.ts`**

```ts
import { afterAll, expect, test } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];

// A fresh, unauthenticated anon-key client — mirrors lib/supabase/client.ts, no session.
function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("anon cannot read a private earner's profile or credentials, but the owner still can", async () => {
  const owner = await makeUserClient(`pub-${Date.now()}@example.com`);
  created.push(owner.userId);
  const handle = `pp${Date.now()}`;

  // Seed an earner with public_profile_enabled defaulting to false, plus one credential.
  await owner.client
    .from("earners")
    .insert({ id: owner.userId, handle, display_name: "Test Earner" });
  await owner.client
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Private Cred" });

  const anon = anonClient();

  // (1) private: anon sees zero rows on both tables.
  const anonEarner = await anon.from("earners").select("*").eq("handle", handle);
  expect(anonEarner.data).toEqual([]);
  const anonCreds = await anon.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(anonCreds.data).toEqual([]);

  // (1b) ENUMERATION PARITY: an EXISTING-but-disabled handle must be byte-for-byte
  // indistinguishable at the query level from a handle that was never created. Both must
  // return exactly the same zero-row result and no error — otherwise an attacker could tell
  // "opted-out but exists" from "does not exist" (the missing==disabled invariant).
  const neverHandle = `nope${Date.now()}`;
  const anonMissing = await anon.from("earners").select("*").eq("handle", neverHandle);
  expect(anonMissing.error).toBeNull();
  expect(anonEarner.error).toBeNull();
  expect(anonMissing.data).toEqual(anonEarner.data); // both [] — no distinguishing signal

  // (5) additive proof: the OWNER's own self-access is unaffected while private.
  const ownEarner = await owner.client.from("earners").select("*").eq("id", owner.userId);
  expect(ownEarner.data).toHaveLength(1);
  const ownCreds = await owner.client.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(ownCreds.data).toHaveLength(1);

  // (2) flip public_profile_enabled true -> anon can now read both.
  await owner.client
    .from("earners")
    .update({ public_profile_enabled: true })
    .eq("id", owner.userId);

  const anonEarner2 = await anon.from("earners").select("handle, display_name").eq("handle", handle);
  expect(anonEarner2.data).toHaveLength(1);
  expect(anonEarner2.data![0].display_name).toBe("Test Earner");
  const anonCreds2 = await anon
    .from("credentials")
    .select("id, title, raw_json")
    .eq("earner_id", owner.userId);
  expect(anonCreds2.data).toHaveLength(1);
  expect(anonCreds2.data![0].title).toBe("Private Cred");
  // raw_json is readable to anon (present as a key, even if null). The public PAGE query does NOT
  // select it (card fields only); it is read on-demand by the verify action. This assertion documents
  // the accepted policy-level tradeoff (see the migration comment) — the whole row is anon-selectable.
  expect(anonCreds2.data![0]).toHaveProperty("raw_json");

  // (3) toggle back to false -> anon access disappears again (no staleness; EXISTS re-evaluates).
  await owner.client
    .from("earners")
    .update({ public_profile_enabled: false })
    .eq("id", owner.userId);
  const anonEarner3 = await anon.from("earners").select("*").eq("handle", handle);
  expect(anonEarner3.data).toEqual([]);
  const anonCreds3 = await anon.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(anonCreds3.data).toEqual([]);
});

test("anon cannot write to earners or credentials regardless of public_profile_enabled", async () => {
  const owner = await makeUserClient(`pubw-${Date.now()}@example.com`);
  created.push(owner.userId);
  const handle = `ppw${Date.now()}`;
  await owner.client
    .from("earners")
    .insert({ id: owner.userId, handle, public_profile_enabled: true });
  const { data: credRow } = await owner.client
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Owned" })
    .select("id")
    .single();

  const anon = anonClient();

  // A robust "write was denied" assertion: under RLS a disallowed write either returns an error
  // OR returns zero affected rows (PostgREST behavior differs by verb) — both are acceptable, a
  // NON-empty data array is NOT. Pinning to exactly one behavior is brittle (undocumented), so
  // accept either and separately PROVE the row is unchanged via the owner client below.
  const writeDenied = (r: { data: unknown; error: unknown }) =>
    r.error != null || ((r.data as unknown[] | null) ?? []).length === 0;

  // anon UPDATE of verification_status: RLS matches no update policy.
  const upd = await anon
    .from("credentials")
    .update({ verification_status: "verified" })
    .eq("id", credRow!.id)
    .select();
  expect(writeDenied(upd)).toBe(true);

  // Prove the UPDATE did not land: owner still sees the original 'unverified'.
  const { data: afterUpd } = await owner.client
    .from("credentials")
    .select("verification_status")
    .eq("id", credRow!.id)
    .single();
  expect(afterUpd!.verification_status).toBe("unverified");

  // anon INSERT into either table is rejected (no anon insert policy).
  const insCred = await anon
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Injected" });
  expect(insCred.error).not.toBeNull();
  const insEarner = await anon
    .from("earners")
    .insert({ id: crypto.randomUUID(), handle: `x${Date.now()}` });
  expect(insEarner.error).not.toBeNull();

  // anon DELETE is denied (error or zero rows).
  const del = await anon.from("credentials").delete().eq("id", credRow!.id).select();
  expect(writeDenied(del)).toBe(true);

  // Final confirmation: the row still exists and is untouched after all write attempts.
  const { data: after } = await owner.client
    .from("credentials")
    .select("verification_status")
    .eq("id", credRow!.id)
    .single();
  expect(after!.verification_status).toBe("unverified");
});
```

- [ ] **Step 4: Run the integration tests (expected PASS after migration applied)**

Run: `npm test -- tests/db/public-profile-rls.test.ts`
Expected: 2 passed. (If they fail with anon seeing rows, the migration was not applied — re-run Step 2.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0005_public_profile_rls.sql tests/db/public-profile-rls.test.ts
git commit -m "feat: additive anon-read RLS for public profiles (gated on public_profile_enabled)"
```

---

### Task 2: Extract `requireUserId()` helper (DRY refactor)

> **Scope.** Pure extraction — move the ~6-line `requireUserId` currently inlined in `app/app/wallet/actions.ts` into a shared module so the new publish-toggle action (Task 3) reuses it. Behavior is identical; the wallet actions import the shared copy.

**Files:**
- Create: `lib/auth/require-user.ts`, `lib/auth/require-user.test.ts`
- Modify: `app/app/wallet/actions.ts` (import the shared helper, delete the local copy)

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server`; `redirect` from `next/navigation`.
- Produces:
  ```ts
  export async function requireUserId(): Promise<string>; // redirects to /login if unauthenticated
  ```

- [ ] **Step 1: Write the failing test `lib/auth/require-user.test.ts`**

```ts
import { afterEach, expect, test, vi } from "vitest";

// Mock the server client + redirect so this is a pure unit test (no cookies, no network).
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ auth: { getUser } }),
}));
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

afterEach(() => {
  getUser.mockReset();
  redirect.mockClear();
});

test("returns the user id when authenticated", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-123" } } });
  const { requireUserId } = await import("./require-user");
  await expect(requireUserId()).resolves.toBe("user-123");
  expect(redirect).not.toHaveBeenCalled();
});

test("redirects to /login when there is no user", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  const { requireUserId } = await import("./require-user");
  await expect(requireUserId()).rejects.toThrow("REDIRECT:/login");
  expect(redirect).toHaveBeenCalledWith("/login");
});
```

- [ ] **Step 2: Run the test (expected FAIL)**

Run: `npm test -- lib/auth/require-user.test.ts`
Expected: FAIL — `lib/auth/require-user.ts` does not exist.

- [ ] **Step 3: Write `lib/auth/require-user.ts`**

```ts
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Resolve the current authenticated earner's id, or redirect to /login.
 * Extracted from app/app/wallet/actions.ts so multiple Server Action files share one copy.
 */
export async function requireUserId(): Promise<string> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}
```

- [ ] **Step 4: Point `app/app/wallet/actions.ts` at the shared helper**

Delete the local `requireUserId` definition (lines defining `async function requireUserId(): Promise<string> { ... }`) and add the import near the other imports:

```ts
import { requireUserId } from "@/lib/auth/require-user";
```

Leave all four call sites (`importByUrl`/`importByFile`/`importManual`/`reverifyCredential`) unchanged — they already call `requireUserId()`.

- [ ] **Step 5: Run the helper test + the full suite for regressions (expected PASS)**

Run: `npm test -- lib/auth/require-user.test.ts && npx tsc --noEmit`
Expected: 2 passed; no type errors (wallet actions still compile against the shared helper).

- [ ] **Step 6: Commit**

```bash
git add lib/auth/require-user.ts lib/auth/require-user.test.ts app/app/wallet/actions.ts
git commit -m "refactor: extract requireUserId() into lib/auth for reuse across action files"
```

---

### Task 3: Publish toggle — action + card on the wallet home

> **Placement.** The toggle lives on the existing wallet home (`app/app/page.tsx`), not a new `/app/settings` route — Plan 4 is "the public profile only, keep it small." Handle editing is explicitly OUT of scope (open item for a future settings plan): the handle is shown read-only, since it is load-bearing for the `/u/[handle]` URL and editability introduces collision/redirect/uniqueness-race concerns. The write rides the pre-existing `earners_self_update` policy — no new RLS. Shipping only the toggle with the anon-read policy from Task 1 already in place is safe and immediately functional.
>
> **All-or-nothing invariant (informed consent).** There is NO per-credential visibility flag in Plan 4 — publishing exposes ALL of the earner's current and future credentials at the profile level. Per-credential control is a schema change (a `credentials.public boolean` or similar) that is OUT of Plan 4 scope and is a documented follow-up. The `PublishProfileCard` copy MUST make this explicit ("ALL of your credentials … all-or-nothing") so the earner gives informed consent before flipping the flag — do not use copy like "the credentials you chose" that implies a selection the product does not offer.

**Files:**
- Create: `app/app/actions.ts`, `components/publish-profile-card.tsx`, `components/copy-link-button.tsx`, `components/publish-profile-card.test.tsx`
- Modify: `app/app/page.tsx`

**Interfaces:**
- Consumes: `requireUserId` from `@/lib/auth/require-user`; `createServerClient` from `@/lib/supabase/server`; `revalidatePath` from `next/cache`; `Button` from `@/components/ui/button`.
- Produces:
  ```ts
  // app/app/actions.ts
  export async function updatePublicProfileEnabled(formData: FormData): Promise<void>;
  // components/publish-profile-card.tsx
  export function PublishProfileCard(props: { handle: string; publicProfileEnabled: boolean }): JSX.Element;
  // components/copy-link-button.tsx
  export function CopyLinkButton(props: { value: string }): JSX.Element; // "use client"
  ```

- [ ] **Step 1: Write `app/app/actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";

/**
 * Flip the signed-in earner's public_profile_enabled. RLS (earners_self_update, 0003) guarantees
 * an earner can only ever update their OWN row — even if requireUserId() were bypassed, the update
 * would fail closed. requireUserId() is still called for a clean /login redirect (defense in depth).
 * No redirect on success: we stay on /app and let revalidatePath re-render from fresh server data.
 */
export async function updatePublicProfileEnabled(formData: FormData): Promise<void> {
  const enabled = formData.get("enabled") === "true";
  const userId = await requireUserId();
  const supabase = await createServerClient();
  await supabase.from("earners").update({ public_profile_enabled: enabled }).eq("id", userId);
  revalidatePath("/app");
}
```

- [ ] **Step 2: Write `components/copy-link-button.tsx` (the one client island)**

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Small client island — clipboard access requires "use client". Keyboard-reachable, 44x44 via Button. */
export function CopyLinkButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied!" : "Copy link"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Profile link copied to clipboard" : ""}
      </span>
    </>
  );
}
```

- [ ] **Step 3: Write the failing component test `components/publish-profile-card.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub the server action import so the client-boundary form renders in jsdom.
vi.mock("@/app/app/actions", () => ({ updatePublicProfileEnabled: vi.fn() }));

import { PublishProfileCard } from "./publish-profile-card";

test("shows the public URL and a copy button when enabled", () => {
  render(<PublishProfileCard handle="janedoe" publicProfileEnabled={true} />);
  expect(screen.getByText("/u/janedoe")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
  // Current state is communicated as text, not color alone.
  expect(screen.getByText(/public/i)).toBeInTheDocument();
});

test("the toggle submits the OPPOSITE state (enabled=false when currently public)", () => {
  const { container } = render(
    <PublishProfileCard handle="janedoe" publicProfileEnabled={true} />
  );
  const hidden = container.querySelector('input[name="enabled"]') as HTMLInputElement;
  expect(hidden.value).toBe("false"); // currently public -> button makes it private
  expect(screen.getByRole("button", { name: /make private/i })).toBeInTheDocument();
});

test("when private, the toggle submits enabled=true and no URL/copy is shown", () => {
  const { container } = render(
    <PublishProfileCard handle="janedoe" publicProfileEnabled={false} />
  );
  const hidden = container.querySelector('input[name="enabled"]') as HTMLInputElement;
  expect(hidden.value).toBe("true"); // currently private -> button makes it public
  expect(screen.getByRole("button", { name: /publish|make public/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Run the test (expected FAIL)**

Run: `npm test -- components/publish-profile-card.test.tsx`
Expected: FAIL — `components/publish-profile-card.tsx` does not exist.

- [ ] **Step 5: Write `components/publish-profile-card.tsx`**

```tsx
import { updatePublicProfileEnabled } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/copy-link-button";

/**
 * Publish control for the wallet home. Read-only handle (editing is out of Plan 4 scope).
 * The toggle is a plain server-actioned <form> (no client JS state) mirroring ReverifyButton:
 * a single hidden `enabled` input carries the NEXT state, so one click flips the flag.
 */
export function PublishProfileCard({
  handle,
  publicProfileEnabled,
}: {
  handle: string;
  publicProfileEnabled: boolean;
}) {
  const nextState = publicProfileEnabled ? "false" : "true";
  const profilePath = `/u/${handle}`;

  return (
    <section
      aria-labelledby="publish-heading"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-foreground/10 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="publish-heading" className="font-heading text-lg font-semibold">
          Public profile
        </h2>
        <span className="text-sm font-medium text-foreground/70">
          {publicProfileEnabled ? "Public" : "Private"}
        </span>
      </div>

      <p className="text-sm text-foreground/70">
        {publicProfileEnabled
          ? "Anyone with your link can view ALL of your credentials — current and future — and re-verify them against the issuer. Publishing is all-or-nothing; there is no per-credential control yet."
          : "Your credentials are private. Publishing shares ALL of your credentials (current and future) as a verifiable profile at a public link — no account needed to view it. It is all-or-nothing; you cannot yet choose individual credentials."}
      </p>

      {publicProfileEnabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded bg-foreground/5 px-2 py-1 text-sm">{profilePath}</code>
          <CopyLinkButton value={profilePath} />
        </div>
      ) : null}

      <form action={updatePublicProfileEnabled} className="mt-1">
        <input type="hidden" name="enabled" value={nextState} />
        <Button type="submit" variant={publicProfileEnabled ? "secondary" : "primary"}>
          {publicProfileEnabled ? "Make private" : "Publish (make public)"}
        </Button>
      </form>
    </section>
  );
}
```

- [ ] **Step 6: Run the test (expected PASS)**

Run: `npm test -- components/publish-profile-card.test.tsx`
Expected: 3 passed.

- [ ] **Step 7: Wire the card into `app/app/page.tsx`**

Add a second query for the earner row and render the card above the grid/empty state. Replace the body of `WalletHome` so it reads:

```tsx
import { createServerClient } from "@/lib/supabase/server";
import { CredentialGrid, type WalletCredential } from "@/components/credential-grid";
import { EmptyWalletState } from "@/components/empty-wallet-state";
import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";
import { PublishProfileCard } from "@/components/publish-profile-card";

export default async function WalletHome() {
  const supabase = await createServerClient();
  // RLS (credentials_owner_all) scopes this to the signed-in earner — no manual filter needed.
  const { data } = await supabase
    .from("credentials")
    .select("id, title, issuer_name, issued_date, verification_status")
    .order("created_at", { ascending: false });
  const credentials = (data ?? []) as WalletCredential[];

  // RLS (earners_self_select) scopes this to the signed-in earner's own row.
  // .maybeSingle() (not .single()) matches the house pattern (lib/auth/provision-earner.ts):
  // a session can reach /app before provisionEarner has run, and .single() would log a spurious
  // PGRST116 error on zero rows; .maybeSingle() returns { data: null } cleanly.
  const { data: earner } = await supabase
    .from("earners")
    .select("handle, public_profile_enabled")
    .maybeSingle();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-bold">My Wallet</h1>
        {credentials.length > 0 ? <AddCredentialLauncher /> : null}
      </div>
      {earner ? (
        <PublishProfileCard
          handle={earner.handle}
          publicProfileEnabled={earner.public_profile_enabled}
        />
      ) : null}
      {credentials.length === 0 ? (
        <EmptyWalletState />
      ) : (
        <CredentialGrid credentials={credentials} />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add app/app/actions.ts components/publish-profile-card.tsx components/copy-link-button.tsx components/publish-profile-card.test.tsx app/app/page.tsx
git commit -m "feat: public-profile publish toggle + copy-link on the wallet home"
```

---

### Task 4: Public profile page `/u/[handle]` (reuses CredentialCard/CredentialGrid via an action slot)

> **Order dependency.** This task consumes `PublicVerifyButton` and `publicReverifyCredential` from **Task 5, which MUST be completed first** (Task 5 has no dependency on Task 4, so it can and should be done first). This removes the earlier ambiguity: there is one path — Task 5 → Task 4 — and Task 4's `tsc` is green on its own because Task 5's artifacts already exist.
>
> **Reuse, do not fork.** This task does NOT create `public-credential-card.tsx` / `public-credential-grid.tsx`. Instead it adds an optional action slot to the EXISTING `components/credential-card.tsx` and `components/credential-grid.tsx` (Plan 3) and reuses them, so `formatDate`/card markup lives in exactly one place and the wallet and public views cannot drift.
>
> **Missing == disabled.** The page resolves the earner via the anon-RLS path; a nonexistent handle and a `public_profile_enabled = false` earner both return zero rows and both call `notFound()`. This is the security invariant (no enumeration of opted-out earners), so do NOT branch on which case it is. The page is unauthenticated — it uses `createServerClient()` (anon-key + forwarded cookies, works with no session) and relies entirely on RLS.

**Files:**
- Modify: `components/credential-card.tsx`, `components/credential-grid.tsx`
- Create: `app/u/[handle]/page.tsx`, `app/u/[handle]/not-found.tsx`

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server`; `notFound` from `next/navigation`; the reused `CredentialGrid`/`WalletCredential` from `@/components/credential-grid`; `PublicVerifyButton` from `@/components/public-verify-button` (Task 5).
- Produces:
  ```ts
  // components/credential-card.tsx (MODIFIED — WalletCredential unchanged)
  export function CredentialCard(props: {
    credential: WalletCredential;
    action?: React.ReactNode; // when provided, replaces the default <ReverifyButton> in the footer
  }): JSX.Element;
  // components/credential-grid.tsx (MODIFIED)
  export function CredentialGrid(props: {
    credentials: WalletCredential[];
    renderAction?: (credential: WalletCredential) => React.ReactNode; // per-card action slot
  }): JSX.Element;
  // app/u/[handle]/page.tsx
  export default async function PublicProfilePage(props: { params: Promise<{ handle: string }> }): Promise<JSX.Element>;
  ```

- [ ] **Step 1: Add an optional `action` slot to `components/credential-card.tsx`**

Change ONLY the props and the footer; leave `formatDate`, `WalletCredential`, and all markup identical. The default (no `action` prop) renders the existing `<ReverifyButton>`, so the wallet call site is behavior-identical.

```tsx
import type { ReactNode } from "react";
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

export function CredentialCard({
  credential,
  action,
}: {
  credential: WalletCredential;
  action?: ReactNode;
}) {
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
        {/* Default = write-capable ReverifyButton (wallet). Public page injects a read-only action. */}
        {action ?? <ReverifyButton credentialId={credential.id} />}
      </div>
    </li>
  );
}
```

- [ ] **Step 2: Add an optional `renderAction` prop to `components/credential-grid.tsx`**

```tsx
import type { ReactNode } from "react";
import { CredentialCard, type WalletCredential } from "@/components/credential-card";

export type { WalletCredential };

export function CredentialGrid({
  credentials,
  renderAction,
}: {
  credentials: WalletCredential[];
  renderAction?: (credential: WalletCredential) => ReactNode;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {credentials.map((c) => (
        <CredentialCard key={c.id} credential={c} action={renderAction?.(c)} />
      ))}
    </ul>
  );
}
```

> **Regression guard.** The existing wallet home (`app/app/page.tsx`) and any existing `credential-card.test.tsx` / `credential-grid.test.tsx` call these WITHOUT the new props, so they must still pass unchanged — `action`/`renderAction` are optional and default to the current `ReverifyButton` behavior. Run `npm test -- components/credential-card.test.tsx components/credential-grid.test.tsx` after this step to confirm no regression before moving on.

- [ ] **Step 3: Write `app/u/[handle]/not-found.tsx`**

```tsx
export default function ProfileNotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-heading text-2xl font-bold">Profile not found</h1>
      <p className="text-foreground/70">
        This profile does not exist or has not been published.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Write `app/u/[handle]/page.tsx`**

This is the ONE and ONLY body to write — there is no placeholder-then-correct pattern. Note the two-step resolve: select the earner's `id` (so credentials can be filtered by the uuid `earner_id`, NOT by `handle`), then load card fields and reuse `CredentialGrid` with a `renderAction` that injects the read-only `PublicVerifyButton` (keyed by the viewed `handle` + credential id).

```tsx
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { CredentialGrid, type WalletCredential } from "@/components/credential-grid";
import { PublicVerifyButton } from "@/components/public-verify-button";

/**
 * Public, unauthenticated verifiable profile (spec §3, §5, §8 screen 3). Enforcement is RLS:
 * earners_public_select / credentials_public_select (0005) only return rows for earners with
 * public_profile_enabled = true. A missing handle and a private earner are indistinguishable —
 * both yield zero rows -> notFound() — which prevents enumerating opted-out earners.
 * The .eq("public_profile_enabled", true) below is defense-in-depth / short-circuit, NOT the boundary.
 */
export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const supabase = await createServerClient();

  // Select id so credentials can be keyed by the uuid earner_id column. A uuid is not sensitive.
  const { data: earner } = await supabase
    .from("earners")
    .select("id, handle, display_name")
    .eq("handle", handle)
    .eq("public_profile_enabled", true)
    .maybeSingle();

  if (!earner) notFound();

  // Card fields ONLY — raw_json is NOT selected here (read on-demand by the verify action).
  // storage_path is NOT selected (no anon storage-read policy exists; out of scope).
  const { data } = await supabase
    .from("credentials")
    .select("id, title, issuer_name, issued_date, verification_status")
    .eq("earner_id", earner.id)
    .order("created_at", { ascending: false });
  const credentials = (data ?? []) as WalletCredential[];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-foreground/10 px-4 py-3">
        <span className="font-heading text-xl font-bold">Trove</span>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-2 font-heading text-2xl font-bold">
          {earner.display_name || earner.handle}
        </h1>
        <p className="mb-6 text-sm text-foreground/60">Verified skills profile</p>
        {credentials.length === 0 ? (
          <p className="text-foreground/70">No credentials have been published yet.</p>
        ) : (
          <CredentialGrid
            credentials={credentials}
            renderAction={(c) => (
              <PublicVerifyButton
                handle={earner.handle}
                credentialId={c.id}
                initialStatus={c.verification_status}
              />
            )}
          />
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck (expected PASS — Task 5 is already done)**

Run: `npx tsc --noEmit`
Expected: no errors. `components/public-verify-button.tsx` and `app/u/[handle]/actions.ts` already exist from Task 5, so both the page and the reused card/grid compile.

- [ ] **Step 6: Commit**

```bash
git add app/u components/credential-card.tsx components/credential-grid.tsx
git commit -m "feat: public /u/[handle] profile page reusing CredentialGrid with a read-only verify slot (RLS-gated)"
```

---

### Task 5: Read-only live-verify affordance (Server Action + bounded fetch + client button)

> **Do this task BEFORE Task 4.** Task 4's page imports `PublicVerifyButton` and this action; Task 5 has no dependency on Task 4, so completing Task 5 first makes every task's `tsc` green on its own.
>
> **Display-only, honestly-bounded.** `publicReverifyCredential(handle, credentialId)` re-loads `raw_json` via the anon-RLS path (inheriting the `public_profile_enabled` gate automatically), **joined to the viewed `handle`** so a viewer on `/u/alice` can only ever re-verify credentials belonging to `alice` (defense-in-depth: it shrinks the SSRF trigger set to the profile on screen and matches user expectation, even though RLS already limits reads to published earners). It calls the unmodified `verifyCredential` with an injected `boundedFetch`, and RETURNS the `VerifyResult` for display — it NEVER calls `.update()`/`.upsert()`. `boundedFetch` enforces https-only + **a literal-private-IP/metadata-host block** + `redirect: "manual"` + a 5s `AbortSignal.timeout`. DNS-rebinding (hostname→private IP) and rate-limiting remain explicitly deferred (documented in code + Global Constraints). Contrast Plan 3's authenticated `reverifyCredential`, which writes status and uses plain fetch — that one is NOT reused here.

**Files:**
- Create: `app/u/[handle]/actions.ts`, `components/public-verify-button.tsx`, `app/u/[handle]/public-reverify.test.ts`, `components/public-verify-button.test.tsx`

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server`; `verifyCredential` from `@/lib/credentials/verify`; `VerifyResult`, `CredentialSource` from `@/lib/credentials/types`; `Button` from `@/components/ui/button`.
- Produces:
  ```ts
  // app/u/[handle]/actions.ts
  export async function publicReverifyCredential(handle: string, credentialId: string): Promise<VerifyResult | null>;
  export function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; // https-only, private-IP blocked, redirect:manual, 5s timeout
  // components/public-verify-button.tsx  ("use client")
  export function PublicVerifyButton(props: {
    handle: string;
    credentialId: string;
    initialStatus: "verified" | "unverified" | "failed";
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing unit test `app/u/[handle]/public-reverify.test.ts`**

```ts
import { afterEach, expect, test, vi } from "vitest";
import type { VerifyResult } from "@/lib/credentials/types";

// --- Mocks: an injectable Supabase stub and the pure verifier. ---
// The action joins credentials -> earners on the viewed handle, so the query chain is
// .from("credentials").select(...).eq("id", credentialId).eq("earners.handle", handle).maybeSingle().
// The stub returns `maybeSingle` at the end of a chain of .eq()s regardless of arity.
const maybeSingle = vi.fn();
const update = vi.fn(() => {
  throw new Error("publicReverifyCredential must NEVER write");
});
const eq = vi.fn(() => chain);
const chain: { eq: typeof eq; maybeSingle: typeof maybeSingle } = { eq, maybeSingle };
const from = vi.fn(() => ({
  select: () => chain,
  update, // wired to throw if the action ever calls it
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ from }),
}));

const verifyCredential = vi.fn<[], Promise<VerifyResult>>();
vi.mock("@/lib/credentials/verify", () => ({
  verifyCredential: (...args: unknown[]) => (verifyCredential as any)(...args),
}));

afterEach(() => {
  maybeSingle.mockReset();
  update.mockClear();
  eq.mockClear();
  verifyCredential.mockReset();
  from.mockClear();
});

test("returns null and never verifies when no row is visible (private/nonexistent/wrong handle)", async () => {
  maybeSingle.mockResolvedValue({ data: null });
  const { publicReverifyCredential } = await import("./actions");
  await expect(publicReverifyCredential("alice", "cred-1")).resolves.toBeNull();
  expect(verifyCredential).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("happy path returns the VerifyResult and never writes", async () => {
  maybeSingle.mockResolvedValue({
    data: { id: "cred-1", source: "ob_url", raw_json: { id: "https://x/a" } },
  });
  const expected: VerifyResult = { status: "verified", method: "ob2_hosted", detail: "ok" };
  verifyCredential.mockResolvedValue(expected);
  const { publicReverifyCredential } = await import("./actions");
  await expect(publicReverifyCredential("alice", "cred-1")).resolves.toEqual(expected);
  expect(verifyCredential).toHaveBeenCalledTimes(1);
  // The query is scoped to BOTH the credential id AND the viewed handle (defense-in-depth).
  expect(eq).toHaveBeenCalledWith("id", "cred-1");
  expect(eq).toHaveBeenCalledWith("earners.handle", "alice");
  // The bounded fetch must be injected as opts.fetchImpl.
  const opts = (verifyCredential.mock.calls[0] as unknown[])[1] as { fetchImpl?: unknown };
  expect(typeof opts.fetchImpl).toBe("function");
  expect(update).not.toHaveBeenCalled();
});

test("boundedFetch throws synchronously on a non-https URL before any network call", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./actions");
  await expect(boundedFetch("http://internal/metadata")).rejects.toThrow(/https/i);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("boundedFetch rejects literal private/loopback/link-local/metadata hosts before any network call", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./actions");
  for (const url of [
    "https://169.254.169.254/latest/meta-data/", // link-local / cloud metadata
    "https://[::1]/",                              // IPv6 loopback
    "https://127.0.0.1/",                          // IPv4 loopback
    "https://10.0.0.1/",                           // RFC1918
    "https://192.168.1.1/",                        // RFC1918
    "https://172.16.0.1/",                         // RFC1918
    "https://metadata.google.internal/",           // known metadata hostname
  ]) {
    await expect(boundedFetch(url)).rejects.toThrow(/private|blocked|refus|internal|metadata/i);
  }
  expect(spy).not.toHaveBeenCalled(); // NONE of them reached the network
  spy.mockRestore();
});

test("boundedFetch passes redirect:manual and an AbortSignal to the underlying fetch for a public https host", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const { boundedFetch } = await import("./actions");
  await boundedFetch("https://issuer.example/a", { headers: { Accept: "application/json" } });
  const init = spy.mock.calls[0][1] as RequestInit;
  expect(init.redirect).toBe("manual");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  spy.mockRestore();
});
```

- [ ] **Step 2: Run the test (expected FAIL)**

Run: `npm test -- app/u/[handle]/public-reverify.test.ts`
Expected: FAIL — `app/u/[handle]/actions.ts` does not exist.

- [ ] **Step 3: Write `app/u/[handle]/actions.ts`**

```ts
"use server";

import net from "node:net";
import { createServerClient } from "@/lib/supabase/server";
import { verifyCredential } from "@/lib/credentials/verify";
import type { VerifyResult, CredentialSource } from "@/lib/credentials/types";

/** Known cloud-metadata hostnames that must never be fetched, even though they are not literal IPs. */
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata"]);

/**
 * Reject a host that is a LITERAL IP address in a loopback / private / link-local / ULA range,
 * including IPv4-mapped IPv6 forms. Returns true when the host must be blocked. Hostnames that are
 * NOT literal IPs are NOT resolved here (see the DNS-rebinding deferral below) — they pass this
 * check and are handled only by the metadata-hostname denylist above.
 */
function isBlockedLiteralIp(host: string): boolean {
  // URL IPv6 hosts arrive bracketed (e.g. "[::1]"); strip brackets for net.isIP.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const fam = net.isIP(h);
  if (fam === 0) return false; // not a literal IP — a hostname

  if (fam === 4) {
    const [a, b] = h.split(".").map((n) => Number(n));
    if (a === 127) return true;                    // 127.0.0.0/8 loopback
    if (a === 10) return true;                     // 10.0.0.0/8
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true;       // 169.254.0.0/16 link-local (incl. cloud metadata)
    if (a === 0) return true;                       // 0.0.0.0/8
    return false;
  }

  // IPv6
  const lower = h.toLowerCase();
  if (lower === "::1" || lower === "::") return true;               // loopback / unspecified
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // fc00::/7 unique-local
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — re-check the embedded v4 literal.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isBlockedLiteralIp(mapped[1])) return true;
  return false;
}

/**
 * Bounded outbound fetch for the public verify path. The initial URL comes from earner-controlled
 * raw_json (detectHostedVerify()), so it is UNTRUSTED. Mitigations, applied in order BEFORE any
 * network call:
 *   - https-only: throws so an http/file/gopher URL can't be reached.
 *   - literal-private-IP / metadata-host block: parse the host and reject loopback / RFC1918 /
 *     link-local / ULA literal IPs (v4, v6, IPv4-mapped) and known metadata hostnames. This closes
 *     the direct SSRF class (e.g. https://169.254.169.254/, https://[::1]/, https://10.0.0.1/).
 *   - redirect: "manual": a redirect cannot transparently pivot into an internal address.
 *   - 5s AbortSignal.timeout: bounds a single request's duration.
 * DEFERRED (documented, NOT silently skipped): a HOSTNAME that legitimately resolves via DNS to a
 * private IP (DNS-rebinding / attacker resolver) is still reachable — Node fetch does not expose the
 * resolved IP and this path adds no pre-resolve dns.lookup guard. Follow-up: dns.lookup + block
 * private results, or an egress allowlist/proxy. Per-IP / per-handle rate limiting also does NOT
 * exist yet (candidate follow-up: token bucket keyed by handle+credentialId).
 */
export async function boundedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`refusing unparseable verify fetch URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing non-https verify fetch: ${raw}`);
  }
  const host = parsed.hostname; // no brackets for IPv6 in .hostname
  if (BLOCKED_HOSTS.has(host.toLowerCase()) || isBlockedLiteralIp(host)) {
    throw new Error(`refusing verify fetch to blocked/private host: ${host}`);
  }
  return fetch(raw, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
}

/**
 * READ-ONLY on-demand re-verify for anonymous public-profile viewers (spec §5). Re-loads raw_json
 * through the anon-RLS path (credentials_public_select, 0005 — inherits the public_profile_enabled
 * gate), JOINED to the viewed handle so a viewer can only re-verify credentials on the profile they
 * are on (defense-in-depth; shrinks the SSRF trigger set). Runs the unmodified verifyCredential with
 * the bounded fetch and RETURNS the transient result for display. It NEVER calls .update()/.upsert():
 * anon has no write policy, and persisting a viewer-triggered status would be wrong. Returns null
 * when no matching row is visible (private, nonexistent, or belongs to a different handle).
 */
export async function publicReverifyCredential(
  handle: string,
  credentialId: string
): Promise<VerifyResult | null> {
  const supabase = await createServerClient();
  // The embedded !inner join filters credentials to those whose parent earner has this handle;
  // combined with credentials_public_select (0005), only published credentials on THIS profile match.
  const { data: cred } = await supabase
    .from("credentials")
    .select("id, source, raw_json, earners!inner(handle)")
    .eq("id", credentialId)
    .eq("earners.handle", handle)
    .maybeSingle();
  if (!cred) return null;

  return verifyCredential(
    { source: cred.source as CredentialSource, raw_json: cred.raw_json ?? null },
    { fetchImpl: boundedFetch }
  );
}
```

- [ ] **Step 4: Run the unit test (expected PASS)**

Run: `npm test -- app/u/[handle]/public-reverify.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Write the failing component test `components/public-verify-button.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VerifyResult } from "@/lib/credentials/types";

const publicReverifyCredential = vi.fn<[], Promise<VerifyResult | null>>();
vi.mock("@/app/u/[handle]/actions", () => ({
  publicReverifyCredential: (...args: unknown[]) =>
    (publicReverifyCredential as any)(...args),
}));

import { PublicVerifyButton } from "./public-verify-button";

test("shows the seeded initialStatus before any click", () => {
  render(<PublicVerifyButton handle="alice" credentialId="cred-1" initialStatus="verified" />);
  // The status region reflects the last-known status on first paint (not blank).
  const status = screen.getByRole("status");
  expect(status.textContent ?? "").toMatch(/verified/i);
});

test("renders a Check now button and surfaces the live result in a status region", async () => {
  publicReverifyCredential.mockResolvedValue({
    status: "verified",
    method: "ob2_hosted",
    detail: "hosted assertion matches, not revoked",
  });
  render(<PublicVerifyButton handle="alice" credentialId="cred-1" initialStatus="unverified" />);

  const btn = screen.getByRole("button", { name: /check now/i });
  fireEvent.click(btn);

  // The action is invoked with BOTH the viewed handle and the credential id.
  await waitFor(() =>
    expect(publicReverifyCredential).toHaveBeenCalledWith("alice", "cred-1")
  );
  const status = await screen.findByRole("status");
  await waitFor(() => expect(status.textContent ?? "").toMatch(/verified/i));
});

test("shows a failed result honestly", async () => {
  publicReverifyCredential.mockResolvedValue({
    status: "failed",
    method: "ob2_hosted",
    detail: "hosted fetch 404",
  });
  render(<PublicVerifyButton handle="bob" credentialId="cred-2" initialStatus="verified" />);
  fireEvent.click(screen.getByRole("button", { name: /check now/i }));
  const status = await screen.findByRole("status");
  await waitFor(() => expect(status.textContent ?? "").toMatch(/failed/i));
});
```

- [ ] **Step 6: Run the test (expected FAIL)**

Run: `npm test -- components/public-verify-button.test.tsx`
Expected: FAIL — `components/public-verify-button.tsx` does not exist.

- [ ] **Step 7: Write `components/public-verify-button.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { publicReverifyCredential } from "@/app/u/[handle]/actions";
import { Button } from "@/components/ui/button";
import type { VerifyResult, VerificationStatus } from "@/lib/credentials/types";

const LABEL: Record<VerifyResult["status"], string> = {
  verified: "Verified against the issuer",
  unverified: "Could not be verified automatically",
  failed: "Verification failed",
};

/**
 * Public read-only verify affordance. Calls the display-only publicReverifyCredential action
 * (which never writes, and is scoped to this profile's handle) and shows the transient live result
 * in an aria-live status region. The region is SEEDED with the credential's last-known status
 * (initialStatus) so it is never blank before the visitor clicks "Check now".
 * This REPLACES the write-capable ReverifyButton on the public page.
 */
export function PublicVerifyButton({
  handle,
  credentialId,
  initialStatus,
}: {
  handle: string;
  credentialId: string;
  initialStatus: VerificationStatus;
}) {
  const [isPending, startTransition] = useTransition();
  // Seed with the last-known status so the region shows the current state before any click.
  const [result, setResult] = useState<VerifyResult | null>({
    status: initialStatus,
    method: "none",
    detail: "last known status",
  });

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const res = await publicReverifyCredential(handle, credentialId);
            setResult(res);
          })
        }
      >
        {isPending ? "Checking…" : "Check now"}
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-foreground/70">
        {isPending
          ? "Checking against the issuer…"
          : result
            ? LABEL[result.status]
            : ""}
      </p>
    </div>
  );
}
```

- [ ] **Step 8: Run both new tests + typecheck (expected PASS)**

Run: `npm test -- components/public-verify-button.test.tsx app/u/[handle]/public-reverify.test.ts && npx tsc --noEmit`
Expected: component test 3 passed, action test 5 passed, no type errors. (Task 4's page/card typecheck against this file once Task 4 is written — but note the recommended order is Task 5 THEN Task 4, so at the end of Task 5 `app/u/[handle]/page.tsx` may not exist yet; `tsc` still passes because nothing yet imports the page.)

- [ ] **Step 9: Commit**

```bash
git add "app/u/[handle]/actions.ts" components/public-verify-button.tsx "app/u/[handle]/public-reverify.test.ts" components/public-verify-button.test.tsx
git commit -m "feat: read-only public verify affordance (bounded fetch w/ private-IP block, handle-scoped, never writes status)"
```

---

### Task 6: Full-suite verification + manual smoke check

**Files:** none (verification task).

- [ ] **Step 1: Run the entire test suite serially (as configured)**

Run: `npm test`
Expected: all suites green, including the new `tests/db/public-profile-rls.test.ts` (hits the live DB; asserts the missing==disabled enumeration-parity invariant and robust anon-write denial), the extracted-helper test, the reused-card/grid tests (still passing with the new optional `action`/`renderAction` props omitted), both new component tests, and the action unit test. If the DB test fails with anon seeing private rows, migration 0005 was not applied — run `node scripts/apply-migration.mjs supabase/migrations/0005_public_profile_rls.sql`.

- [ ] **Step 2: Typecheck + lint the whole project**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke (documented, optional if no local runtime)**

Run: `npm run dev`, then:
1. Log in, go to `/app`, confirm the Public profile card shows "Private", copy that makes the all-or-nothing scope explicit ("ALL of your credentials … all-or-nothing"), a "Publish (make public)" button, and no URL.
2. Click Publish; confirm it flips to "Public", shows `/u/{yourhandle}` and a "Copy link" button.
3. Open `/u/{yourhandle}` in a private/incognito window (no session); confirm your display name + credentials render, each with a `VerificationBadge` (showing the last-known status, not blank) and a "Check now" button; click "Check now" and confirm the status region updates and no error appears in the console.
4. Open `/u/{a-nonexistent-handle}` and `/u/{a-private-earner-handle}`; confirm BOTH show the identical "Profile not found" page.
5. Back in `/app`, click "Make private"; reload the incognito `/u/{yourhandle}` and confirm it now shows "Profile not found".

- [ ] **Step 4: Commit any lint fixups (if needed)**

```bash
git add -A
git commit -m "chore: full-suite green for Trove public profile (Plan 4)"
```

---

## Self-Review

**Spec coverage (design §2/§3/§5/§8/§9):**
- §3 public `/u/[handle]`, no auth, cryptographic-not-DB-lookup verification: the page is unauthenticated (`createServerClient` with no session), and "Check now" re-runs `verifyCredential` (crypto/hosted re-fetch), not a DB status lookup. ✅ (Task 4, Task 5)
- §5 public profile shows each credential with its verification state + an on-demand "verify" that re-checks against the issuer: the reused `CredentialCard` renders `VerificationBadge` + an injected `PublicVerifyButton` (via the `action` slot); `publicReverifyCredential` re-checks live and returns a transient result. ✅ (Task 4, Task 5)
- §8 screen 3 (trustworthy, shareable, no account needed): read-only public page, copy-link affordance, WCAG-AA card/button reuse. ✅ (Task 3, Task 4)
- §9 Plan 4 = public profile with on-demand re-verification and `public_profile_enabled` gating: the toggle (Task 3) + RLS gate (Task 1) + re-verify (Task 5) are exactly this, and nothing more (no advisor, no sponsor console, no portfolio extras). ✅

**Security invariants encoded:**
- Anon can only SELECT gated on `public_profile_enabled = true` — additive `for select` policies, verified by the fail-closed integration test (private hidden, public visible, toggle-back hides again). ✅
- Anon exposure limited to page-needed columns — the PAGE query selects `handle, display_name` (+`id` to key credentials) and card fields ONLY (`raw_json` is NOT in the page SELECT; it is read on-demand by the verify action for a single credential); `storage_path` never selected; RLS is the boundary. The policy-level fact that the whole row (incl. `raw_json`) is anon-selectable is called out as an ACCEPTED, documented tradeoff (potential OB2 `recipient` PII), NOT asserted non-sensitive, with a pre-broad-rollout audit follow-up. ✅ (with documented deferral)
- Anon can NEVER write — migration adds only `for select`; `publicReverifyCredential` has no `.update()` (test wires `update` to throw); DB test asserts anon insert is rejected and anon update/delete are denied (error OR zero rows), then re-reads via the owner to prove the row is unchanged after BOTH the update and the delete. ✅
- Missing == disabled — both yield zero RLS rows → `notFound()`; page does not branch on which; `not-found.tsx` copy covers both; the DB test asserts a never-created handle and an existing-but-disabled handle return byte-identical zero-row results (enumeration-parity invariant is now tested, not just commented). ✅
- Verify is handle-scoped — `publicReverifyCredential(handle, credentialId)` joins credentials→earners on the viewed handle, so a viewer can only re-verify credentials on the profile they are on (shrinks the SSRF trigger set). ✅
- SSRF/abuse bounds stated honestly — `boundedFetch` (https-only + **literal-private-IP/metadata-host block** + redirect:manual + 5s timeout) closes the direct literal-private-IP class (tested: `169.254.169.254`, `[::1]`, `127.0.0.1`, `10.x`, `192.168.x`, `172.16.x`, `metadata.google.internal` all rejected before any network call). Hostname→private-IP DNS-rebinding and rate-limiting remain explicitly deferred (documented in code + Global Constraints), not silently skipped. ✅ (with documented deferral)

**All-or-nothing consent:** Plan 4 has no per-credential visibility flag; publishing exposes ALL current and future credentials. The Goal, the Task 3 scope note, and the `PublishProfileCard` copy all state this explicitly so the earner gives informed consent; per-credential control is a named out-of-scope follow-up (schema change). ✅

**Placeholder scan:** No `TODO`/`FIXME`/`...`/`your-value-here`/intentional-placeholder code anywhere. The previously-broken Task 4 Step 4 placeholder block (`"handle" in earner ? "earner_id" : "earner_id"`) has been DELETED; Task 4 Step 4 now contains exactly one correct, compiling page body (`.select("id, handle, display_name")` → `.eq("earner_id", earner.id)`). All commands are concrete and runnable.

**Type consistency (across tasks, single source of truth):**
- `VerifyResult` / `CredentialSource` / `VerificationStatus` are imported from `@/lib/credentials/types` everywhere (verify action, button) — never redefined. ✅
- No forked public card/grid: the existing `WalletCredential` (defined once in `components/credential-card.tsx`, re-exported via `credential-grid.tsx`) is reused for BOTH the wallet and the public page via optional `action`/`renderAction` props. No parallel `PublicCredential` type or duplicate `formatDate` exists. ✅
- `requireUserId(): Promise<string>` has one definition (`lib/auth/require-user.ts`) consumed by both `app/app/actions.ts` and `app/app/wallet/actions.ts`. ✅
- `publicReverifyCredential(handle: string, credentialId: string): Promise<VerifyResult | null>` and `updatePublicProfileEnabled(formData: FormData): Promise<void>` signatures match their call sites (page/button pass `(handle, id)`; card form submits FormData). ✅
- `verifyCredential(input, opts)` is consumed unmodified via its existing `opts.fetchImpl` seam — no change to `lib/credentials/verify.ts`. ✅

**Task ordering:** Task 5 (verify action + button) is authored and typechecked BEFORE Task 4 (page), which consumes it — every task's `tsc` is green on its own; no cross-task hedging remains. ✅
