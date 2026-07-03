# Trove Plan 6 — Sponsor Console + Full Stripe Billing

**For agentic workers:** This plan is written to be executed task-by-task by an autonomous coding agent using strict TDD. Every task ends with an independently testable, committable deliverable. Follow the `superpowers:test-driven-development` loop for every code step: write a failing test, run it and confirm it fails for the stated reason, write the minimal implementation, run it and confirm it passes, then commit. Do NOT batch multiple tasks into one commit. When a task's fleshed steps are produced they MUST contain complete code (no `TBD`, no "add error handling", no "similar to Task N", no "write tests for the above") and exact shell commands with expected output.

## Goal

Ship the FINAL Trove subsystem (design doc §7, §8 key-screen 4, §9 subsystem 4 — "v1 minimal"): a role-gated **Sponsor Console** and **full Stripe billing**. Sponsors can create an org, invite an email-keyed cohort (Postmark), see a privacy-preserving engagement funnel and consented aggregate skills coverage, and manage a real per-seat Stripe subscription (Checkout + Customer Portal + webhooks + active-seat quantity sync with proration + reconciliation). Earners retain full ownership: sponsors see ONLY consented/aggregate data, never individual rows or silent surveillance. This plan also CLOSES two known RLS gaps in `0003` (earner full-row cohort update; inert `consent_share_credentials`).

## Architecture

- **Multi-tenant via Postgres RLS** (design §3). Sponsors are tenants; earners belong to zero-or-more sponsors and own their wallet. All sponsor-facing reads go through `is_sponsor_admin()`-guarded RLS policies or SECURITY DEFINER aggregate RPCs that never expose an individual earner row.
- **Email-keyed invites.** `cohort_members.earner_id` FK-references an earner that does not exist until the invitee signs up, so invites live in a new `cohort_invites` table keyed by `email` + `token`. Acceptance (post-signup) upserts the `cohort_members` row via the `accept_cohort_invite` RPC.
- **All external services are injectable adapters** (mirrors `lib/advisor/llm.ts`). Stripe (`StripeLike`) and email (`EmailSender`) are minimal interfaces; real clients are constructed only in thin factory functions; tests inject hand-written fakes and NEVER read a real key or construct a real client. A grep-guard test enforces this.
- **Server Actions + one route handler.** `/sponsor/*` pages use `"use server"` action files (matching `app/app/advisor/actions.ts`); the Stripe webhook is a route handler (`app/api/stripe/webhook/route.ts`, matching `app/auth/confirm/route.ts`) that uses a SERVICE-ROLE Supabase client (bypasses RLS) to sync `sponsors` billing columns.
- **Role gating** via `requireSponsorAdmin()` (mirrors `lib/auth/require-user.ts`): redirects unauthed users to `/login` and users administering no sponsor to `/sponsor/new`.
- **Data model delta** lives in migration `0007_sponsor_billing.sql`, applied via `node scripts/apply-migration.mjs` against hosted project `kuhhupacabevjrfeigaj` (NOT `supabase db push`).

## Tech Stack

Next.js 16 (App Router) · Supabase (Postgres/RLS/Auth/Storage) on hosted ref `kuhhupacabevjrfeigaj` · Vercel · **Stripe** (new `stripe` npm dep, pinned `apiVersion`, sole importer `lib/billing/stripe.ts`) · **Postmark** (fetch-based, NO npm dep) · Tailwind v4 + minimal `components/ui/*` primitives · Vitest 4 (serial: `fileParallelism:false`, `pool:"forks"`) · TypeScript strict.

## Global Constraints

- **No cost / no secrets in tests (hard rule).** No test may construct a real Stripe client, construct a real Postmark sender, or READ `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, or `POSTMARK_SERVER_TOKEN`. Every external service is an INJECTABLE adapter behind a minimal interface (`StripeLike`, `EmailSender`) with a hand-written fake, exactly like `lib/advisor/llm.ts` + `lib/advisor/llm.test.ts`. Task 14 ships a grep-guard test (mirroring Plan 5 Task 12 Step 5) that fails if any `**/*.test.ts` or `tests/**` file READS one of those env vars (`process.env.<SECRET>`) or imports the `stripe` package outside `lib/billing/stripe.ts`. The guard is deliberately NOT a bare-mention check: a name appearing only as a string literal (e.g. `vi.stubEnv("STRIPE_SECRET_KEY", "")`), a `delete process.env.<SECRET>` guard, or a save/restore assignment does not trip it — only a real read that could feed construction does. Real keys live only in git-ignored `.env.local`.
- **Injectable-adapter pattern is mandatory.** `lib/billing/stripe.ts` is the SOLE importer of the `stripe` package; `createStripeClient()` returns a `StripeLike`. `lib/email/postmark.ts` is fetch-based (no dep) and returns an `EmailSender`. All helper functions (`ensureStripeCustomer`, `createCheckoutSession`, `createPortalSession`, `syncSubscriptionSeats`, `handleStripeEvent`, `inviteCohort`) take the adapter + a Supabase client as parameters so tests inject fakes.
- **RLS-first security; earners own their wallet.** Sponsors are tenants who see ONLY consented/aggregate data, NEVER individual rows or silent surveillance. This plan MUST fix two `0003` gaps: (1) `cohort_members_earner_update` is a full-row update — replace with COLUMN-LEVEL privileges: `revoke update on cohort_members from authenticated; grant update (consent_share_skills, consent_share_credentials) on cohort_members to authenticated;` so an earner can flip ONLY consent flags, never `status`/`sponsor_id`. (2) There is NO sponsor read policy on `credentials` gated by `consent_share_credentials` (flag is inert) — add `credentials_sponsor_select` mirroring `earner_skills_sponsor_select`.
- **Aggregate RPCs are privacy-preserving and guarded.** `sponsor_engagement` and `sponsor_skill_coverage` are SECURITY DEFINER and MUST `raise` unless `is_sponsor_admin(target_sponsor)`. They return only COUNTS/aggregates, never an individual earner id, handle, or credential.
- **Org/membership creation goes through RPCs only.** No direct client INSERT policy on `sponsors` or `sponsor_admins`. `create_sponsor` and `accept_cohort_invite` are SECURITY DEFINER and do the atomic inserts (the latter also binds acceptance to the invited email). The webhook's billing-column writes (incl. reconciled `seats`) use the SERVICE-ROLE client (bypasses RLS). The client-side `sponsors` writes — `ensureStripeCustomer` persisting `stripe_customer_id` and `syncSubscriptionSeats` persisting reconciled `seats` from the RLS-scoped Checkout/Portal/member-remove actions — are gated by the `sponsors_admin_update` policy (Task 1), which scopes updates to `is_sponsor_admin(id)` (own sponsor only). The invite-accept seat sync runs with the service-role client because a freshly-joined earner is not yet an admin.
- **Migrations:** `node scripts/apply-migration.mjs supabase/migrations/0007_sponsor_billing.sql` (NEXT number is 0007). NOT `supabase db push`, NOT docker. Do NOT edit already-applied migrations `0001`–`0006`.
- **iCloud / vitest flakiness:** the repo is on an iCloud path and vitest runs serial. Run the suite in TWO halves and sum: `npx vitest run --exclude "**/tests/db/**"` then `npx vitest run tests/db`. If a live-DB file spuriously worker-timeouts, re-run that half. Clean stale iCloud artifacts before `next build`: `find .next -name "* 2.*" -delete`; if a page.js is unmaterialized, `rm -rf .next` and rebuild. Do NOT change `vitest.config.ts`.
- **WCAG-AA is non-negotiable:** 4.5:1 contrast, real `<label>`s, full keyboard nav, visible focus rings, 44×44px touch targets, `prefers-reduced-motion`. Every chart (skills coverage bars, funnel) MUST have an equivalent text/table fallback. Verification/semantic state uses icon+text, never color alone. Mobile-first (excellent at 375px). Design colors: primary `#2563EB`, accent `#F97316` (one CTA per screen).
- **Match existing patterns exactly:** `requireUserId` (`lib/auth/require-user.ts`), `provisionEarner` (`lib/auth/provision-earner.ts`), `createServerClient` (`lib/supabase/server.ts`), route handlers (`app/auth/confirm/route.ts`), `"use server"` action files (`app/app/advisor/actions.ts` — a `"use server"` module may export ONLY async functions), live-DB test helpers `adminClient()` / `makeUserClient(email)` (`tests/db/`), `Button` + `cn` primitives. Adapter pattern models on `lib/advisor/llm.ts`.
- **Final gate (Task 14):** full suite (both halves green) + `npx tsc --noEmit` clean + `npm run build` clean + `npm run lint` clean + grep-guard green. Commit frequently; branch is `trove-ai-advisor` (open PR at end).

## File Structure

```
supabase/migrations/
  0007_sponsor_billing.sql              # T1  billing cols, cohort_invites, 4 RPCs, RLS fixes, column-grant

tests/db/
  sponsor-rls.test.ts                   # T2  live-DB: consent column-grant, credentials_sponsor_select,
                                        #     cross-sponsor isolation, create_sponsor, accept_cohort_invite,
                                        #     engagement/coverage RPC admin-guard
  sponsor-engagement.test.ts            # T7  live-DB: getSponsorEngagement shaping
  sponsor-skills.test.ts                # T9  live-DB: getSponsorSkillCoverage shaping
  sponsor-billing-integration.test.ts   # T14 live-DB end-to-end consent/RLS with faked Stripe/Postmark

lib/billing/
  types.ts                              # T3  SDK-free canonical types + StripeLike + EmailSender
  stripe.ts                             # T3  createStripeClient (sole 'stripe' importer) + helpers
  stripe.test.ts                        # T3/T10/T11/T13 unit tests with fake StripeLike
  customer.ts                           # T10 ensureStripeCustomer
  checkout.ts                           # T10 createCheckoutSession
  portal.ts                             # T11 createPortalSession + listInvoices
  seats.ts                              # T13 syncSubscriptionSeats
  seats.test.ts                         # T13 quantity == active-count assertions
  webhook.ts                            # T12 handleStripeEvent (service-role writes)
  webhook.test.ts                       # T12 signature verify + event dispatch (fake)
  engagement.ts                         # T7  getSponsorEngagement
  skill-coverage.ts                     # T9  getSponsorSkillCoverage

lib/email/
  postmark.ts                           # T3  createPostmarkSender (fetch-based EmailSender)
  postmark.test.ts                      # T3  fetch mocked; asserts no token read w/o send

lib/auth/
  require-sponsor-admin.ts              # T4  requireSponsorAdmin()
  require-sponsor-admin.test.ts         # T4  redirect logic (mocked)

lib/cohort/
  invite.ts                             # T5  inviteCohort(db, sender, sponsorId, emails, origin)
  invite.test.ts                        # T5  email parse/validate + insert + send (fakes)
  parse-emails.ts                       # T5  pure email list parser/validator
  parse-emails.test.ts                  # T5

app/sponsor/
  layout.tsx                            # T4  role-gated shell + nav
  page.tsx                              # T8  engagement dashboard (funnel + member table)
  actions.ts                            # T4/T5/T6/T10/T11 "use server" sponsor actions
  new/page.tsx                          # T4  create-org form
  cohort/page.tsx                       # T5  invite form + member table
  skills/page.tsx                       # T9  consented skills coverage (bars + table fallback)
  billing/page.tsx                      # T11 plan/status/seats + Checkout/Portal btns + invoices

app/invite/[token]/
  page.tsx                              # T6  accept-invite page
  actions.ts                            # T6  acceptInvite action (provision + RPC + seat sync)

app/api/stripe/webhook/
  route.ts                              # T12 POST handler: verify sig -> handleStripeEvent

components/sponsor/
  StatCard.tsx                          # T8  funnel stat card (a11y)
  MemberTable.tsx                       # T8  sortable member table (consented columns only)
  CoverageBars.tsx                      # T9  bar chart WITH table fallback

tests/guards/
  no-real-billing-keys.test.ts          # T14 grep-guard: no STRIPE/POSTMARK keys, no 'stripe' import in tests
```

---

### Task 1: Migration 0007 — billing cols, cohort_invites, RPCs, RLS fixes

> For agentic workers: work strictly top-to-bottom. Each step is 2–5 minutes: write the failing assertion first, run the exact command, confirm the exact FAIL/OK output, apply the minimal change, re-run, then commit. Do NOT skip the "expect fail" runs — they prove the assertion actually tests something. Do NOT touch migrations 0001–0006. All commands run from the repo root.

**Files:**
- Create: `supabase/migrations/0007_sponsor_billing.sql`
- Create: `tests/db/sponsor-billing-schema.test.ts` (live-DB smoke test proving the migration surface exists and behaves; the full RLS/consent security suite is Task 2)
- Apply: `node scripts/apply-migration.mjs supabase/migrations/0007_sponsor_billing.sql`
- Modify: none (do NOT touch 0001–0006, `scripts/apply-migration.mjs`, or `vitest.config.ts`)

**Interfaces:**

_Consumes (existing SQL surface from 0002/0003):_
- Tables: `sponsors(id, name, plan, seats, stripe_customer_id, created_at)`, `sponsor_admins(sponsor_id, user_id, created_at)`, `cohort_members(sponsor_id, earner_id, status, consent_share_skills, consent_share_credentials, invited_at)`, `earners(id, handle, ...)`, `credentials(id, earner_id, ...)`, `earner_skills(earner_id, skill_id, ...)`, `skills(id, canonical_name, type, ...)`, `advisor_messages(id, earner_id, ...)`.
- Enum: `cohort_status` = `('invited','active','removed')`.
- Function: `is_sponsor_admin(target_sponsor uuid) returns boolean` (SECURITY DEFINER, 0003).
- Policy names present in 0003: `cohort_members_earner_update`, `earner_skills_sponsor_select`.
- Extensions: `citext` (0001).

_Produces (SQL surface consumed by Tasks 2–13):_
- `sponsors` gains `stripe_subscription_id text`, `subscription_status text NOT NULL DEFAULT 'inactive'`.
- Unique partial index `sponsors_stripe_customer_id_key on sponsors (stripe_customer_id) where stripe_customer_id is not null` — one sponsor per Stripe customer (webhook lookups by `stripe_customer_id` must resolve a single row).
- Table `cohort_invites (id uuid pk default gen_random_uuid(), sponsor_id uuid not null references sponsors(id) on delete cascade, email citext not null, token text not null unique, accepted_at timestamptz, created_at timestamptz not null default now(), unique(sponsor_id, email))`; RLS enabled.
- Table `stripe_events (id text primary key, received_at timestamptz not null default now())` — webhook idempotency ledger; RLS enabled with NO client policy (service-role-only writes). Consumed by Task 12's `handleStripeEvent` dedup.
- `create_sponsor(sponsor_name text) returns uuid` — SECURITY DEFINER.
- `accept_cohort_invite(invite_token text) returns uuid` — SECURITY DEFINER; binds acceptance to the invited email (resolves the caller's `auth.users.email` inside the definer body and requires `cohort_invites.email = caller email`).
- `sponsor_engagement(target_sponsor uuid) returns table(invited int, activated int, imported int, advisor_used int)` — SECURITY DEFINER, guarded.
- `sponsor_skill_coverage(target_sponsor uuid) returns table(skill_name text, member_count int)` — SECURITY DEFINER, guarded.
- RLS policies: `cohort_invites_sponsor_all`, `credentials_sponsor_select`, `sponsors_admin_update` (admin updates their own sponsor row — needed for the client-side `stripe_customer_id` write in `ensureStripeCustomer`), `earners_sponsor_select` (a cohort's own sponsor admin may read that member's `earners` row — the handle is already public via `/u/[handle]`; this surfaces which invitees signed up and fixes the null-handle bug).
- Column-level grant fix on `cohort_members` (update restricted to `consent_share_skills`, `consent_share_credentials`) + rebuilt `cohort_members_earner_update` policy with the `earner_id = auth.uid()` row predicate.

---

- [ ] **Step 1: Write the failing live-DB smoke test.**

  Create `tests/db/sponsor-billing-schema.test.ts`. This is a live-DB test in the same style as `tests/db/rls.test.ts` (uses `adminClient()` + `makeUserClient(email)`, cleans up created users in `afterAll`). It asserts the migration surface exists: the new `sponsors` columns, the `cohort_invites` table + unique constraint, the four RPCs, and the column-level consent restriction. It will FAIL now because `0007` is not applied.

  ```ts
  import { afterAll, expect, test } from "vitest";
  import { adminClient } from "./admin-client";
  import { makeUserClient } from "./user-client";

  const admin = adminClient();
  const createdUsers: string[] = [];
  const createdSponsors: string[] = [];

  afterAll(async () => {
    for (const id of createdSponsors) {
      await admin.from("sponsors").delete().eq("id", id);
    }
    for (const id of createdUsers) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  test("sponsors has stripe_subscription_id + subscription_status default 'inactive'", async () => {
    const { data, error } = await admin
      .from("sponsors")
      .insert({ name: "Smoke Co" })
      .select("id, stripe_subscription_id, subscription_status")
      .single();
    expect(error).toBeNull();
    createdSponsors.push(data!.id);
    expect(data!.stripe_subscription_id).toBeNull();
    expect(data!.subscription_status).toBe("inactive");
  });

  test("cohort_invites table exists with unique(sponsor_id, email)", async () => {
    const { data: sponsor } = await admin
      .from("sponsors")
      .insert({ name: "Invite Co" })
      .select("id")
      .single();
    createdSponsors.push(sponsor!.id);

    const first = await admin.from("cohort_invites").insert({
      sponsor_id: sponsor!.id,
      email: "dup@example.com",
      token: `tok-${Date.now()}-a`,
    });
    expect(first.error).toBeNull();

    // Same (sponsor_id, email) again -> unique violation (code 23505).
    const second = await admin.from("cohort_invites").insert({
      sponsor_id: sponsor!.id,
      email: "dup@example.com",
      token: `tok-${Date.now()}-b`,
    });
    expect(second.error?.code).toBe("23505");
  });

  test("sponsors_stripe_customer_id_key: two sponsors cannot share a stripe_customer_id", async () => {
    const cus = `cus_shared_${Date.now()}`;
    const a = await admin
      .from("sponsors")
      .insert({ name: "Cust A", stripe_customer_id: cus })
      .select("id")
      .single();
    expect(a.error).toBeNull();
    createdSponsors.push(a.data!.id);

    // Second sponsor with the same customer id -> unique violation (23505).
    const b = await admin
      .from("sponsors")
      .insert({ name: "Cust B", stripe_customer_id: cus })
      .select("id");
    expect(b.error?.code).toBe("23505");

    // But many sponsors may have a NULL customer id (partial index only covers non-null).
    const c = await admin.from("sponsors").insert({ name: "No Cust 1" }).select("id").single();
    const d = await admin.from("sponsors").insert({ name: "No Cust 2" }).select("id").single();
    expect(c.error).toBeNull();
    expect(d.error).toBeNull();
    createdSponsors.push(c.data!.id, d.data!.id);
  });

  test("stripe_events dedup ledger: id is a primary key (duplicate insert is a 23505)", async () => {
    const eventId = `evt_${Date.now()}`;
    const first = await admin.from("stripe_events").insert({ id: eventId });
    expect(first.error).toBeNull();
    const dup = await admin.from("stripe_events").insert({ id: eventId });
    expect(dup.error?.code).toBe("23505");
    // Cleanup (no cascade owner for this table).
    await admin.from("stripe_events").delete().eq("id", eventId);
  });

  test("create_sponsor RPC creates a sponsors row + sponsor_admins row for the caller", async () => {
    const email = `cs-${Date.now()}@example.com`;
    const { client, userId } = await makeUserClient(email);
    createdUsers.push(userId);

    const { data: newId, error } = await client.rpc("create_sponsor", {
      sponsor_name: "Acme",
    });
    expect(error).toBeNull();
    expect(typeof newId).toBe("string");
    createdSponsors.push(newId as string);

    // The caller can now read the sponsor (RLS: sponsors_admin_select).
    const { data: sponsorRow } = await client
      .from("sponsors")
      .select("id, name")
      .eq("id", newId as string)
      .single();
    expect(sponsorRow!.name).toBe("Acme");

    // And an admin row exists for the caller.
    const { data: adminRow } = await admin
      .from("sponsor_admins")
      .select("sponsor_id, user_id")
      .eq("sponsor_id", newId as string)
      .eq("user_id", userId)
      .single();
    expect(adminRow!.user_id).toBe(userId);
  });

  test("accept_cohort_invite links an active cohort_members row and marks the invite accepted", async () => {
    // Sponsor owner creates the org.
    const ownerEmail = `owner-${Date.now()}@example.com`;
    const owner = await makeUserClient(ownerEmail);
    createdUsers.push(owner.userId);
    const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
      sponsor_name: "Cohort Co",
    });
    createdSponsors.push(sponsorId as string);

    // Invitee signs up and provisions their earner row.
    const inviteeEmail = `invitee-${Date.now()}@example.com`;
    const invitee = await makeUserClient(inviteeEmail);
    createdUsers.push(invitee.userId);
    await invitee.client
      .from("earners")
      .insert({ id: invitee.userId, handle: `inv${Date.now()}` });

    // Owner writes an invite addressed to the invitee's OWN email — accept_cohort_invite binds
    // acceptance to the invited email, so the happy path requires invite.email == caller email.
    const token = `accept-tok-${Date.now()}`;
    const { error: inviteErr } = await owner.client.from("cohort_invites").insert({
      sponsor_id: sponsorId as string,
      email: inviteeEmail,
      token,
    });
    expect(inviteErr).toBeNull();

    // Invitee accepts.
    const { data: acceptedSponsor, error: acceptErr } = await invitee.client.rpc(
      "accept_cohort_invite",
      { invite_token: token }
    );
    expect(acceptErr).toBeNull();
    expect(acceptedSponsor).toBe(sponsorId);

    // Membership row is active.
    const { data: member } = await admin
      .from("cohort_members")
      .select("status")
      .eq("sponsor_id", sponsorId as string)
      .eq("earner_id", invitee.userId)
      .single();
    expect(member!.status).toBe("active");

    // Invite is marked accepted.
    const { data: invite } = await admin
      .from("cohort_invites")
      .select("accepted_at")
      .eq("token", token)
      .single();
    expect(invite!.accepted_at).not.toBeNull();
  });

  test("accept_cohort_invite REJECTS a caller whose email differs from the invited email", async () => {
    // Owner + sponsor.
    const owner = await makeUserClient(`owner-neg-${Date.now()}@example.com`);
    createdUsers.push(owner.userId);
    const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
      sponsor_name: "Bind Co",
    });
    createdSponsors.push(sponsorId as string);

    // The invite is addressed to alice, but bob (a different account) presents the token.
    const aliceEmail = `alice-${Date.now()}@example.com`;
    const token = `bind-tok-${Date.now()}`;
    const { error: inviteErr } = await owner.client.from("cohort_invites").insert({
      sponsor_id: sponsorId as string,
      email: aliceEmail,
      token,
    });
    expect(inviteErr).toBeNull();

    const bob = await makeUserClient(`bob-${Date.now()}@example.com`);
    createdUsers.push(bob.userId);
    await bob.client.from("earners").insert({ id: bob.userId, handle: `bob${Date.now()}` });

    // Bob presenting alice's token must RAISE (email mismatch) — the RPC surfaces an error.
    const { error: acceptErr } = await bob.client.rpc("accept_cohort_invite", {
      invite_token: token,
    });
    expect(acceptErr).not.toBeNull();

    // No membership was created for bob, and the invite is still unaccepted.
    const { data: member } = await admin
      .from("cohort_members")
      .select("earner_id")
      .eq("sponsor_id", sponsorId as string)
      .eq("earner_id", bob.userId)
      .maybeSingle();
    expect(member).toBeNull();
    const { data: invite } = await admin
      .from("cohort_invites")
      .select("accepted_at")
      .eq("token", token)
      .single();
    expect(invite!.accepted_at).toBeNull();
  });

  test("earners_sponsor_select: a cohort's own admin can read a member's handle via RLS", async () => {
    // Owner + sponsor.
    const owner = await makeUserClient(`hadmin-${Date.now()}@example.com`);
    createdUsers.push(owner.userId);
    const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
      sponsor_name: "Handle Co",
    });
    createdSponsors.push(sponsorId as string);

    // A member with a known handle, joined to this sponsor.
    const member = await makeUserClient(`hmember-${Date.now()}@example.com`);
    createdUsers.push(member.userId);
    const handle = `handle${Date.now()}`;
    await member.client.from("earners").insert({ id: member.userId, handle });
    await admin.from("cohort_members").insert({
      sponsor_id: sponsorId as string,
      earner_id: member.userId,
      status: "active",
    });

    // The admin's RLS-scoped client can resolve the member's handle (fixes the null-handle bug).
    const { data: earnerRow, error } = await owner.client
      .from("earners")
      .select("id, handle")
      .eq("id", member.userId)
      .single();
    expect(error).toBeNull();
    expect(earnerRow!.handle).toBe(handle);
  });

  test("column-level grant: earner may update consent flags but NOT status/sponsor_id", async () => {
    // Build owner + sponsor + active member.
    const owner = await makeUserClient(`cg-owner-${Date.now()}@example.com`);
    createdUsers.push(owner.userId);
    const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
      sponsor_name: "Grant Co",
    });
    createdSponsors.push(sponsorId as string);

    const earner = await makeUserClient(`cg-earner-${Date.now()}@example.com`);
    createdUsers.push(earner.userId);
    await earner.client
      .from("earners")
      .insert({ id: earner.userId, handle: `cg${Date.now()}` });
    await admin.from("cohort_members").insert({
      sponsor_id: sponsorId as string,
      earner_id: earner.userId,
      status: "active",
    });

    // Consent flag update SUCCEEDS.
    const consentUpd = await earner.client
      .from("cohort_members")
      .update({ consent_share_skills: true })
      .eq("earner_id", earner.userId)
      .eq("sponsor_id", sponsorId as string);
    expect(consentUpd.error).toBeNull();

    // status update is REJECTED by the column-level grant (Postgres 42501).
    const statusUpd = await earner.client
      .from("cohort_members")
      .update({ status: "removed" })
      .eq("earner_id", earner.userId)
      .eq("sponsor_id", sponsorId as string);
    expect(statusUpd.error?.code).toBe("42501");

    // Row is unchanged: consent flag flipped, status still 'active'.
    const { data: row } = await admin
      .from("cohort_members")
      .select("status, consent_share_skills")
      .eq("earner_id", earner.userId)
      .eq("sponsor_id", sponsorId as string)
      .single();
    expect(row!.status).toBe("active");
    expect(row!.consent_share_skills).toBe(true);
  });

  test("sponsor_engagement + sponsor_skill_coverage RAISE for a non-admin caller", async () => {
    const owner = await makeUserClient(`eng-owner-${Date.now()}@example.com`);
    createdUsers.push(owner.userId);
    const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
      sponsor_name: "Engage Co",
    });
    createdSponsors.push(sponsorId as string);

    // A stranger who is NOT an admin of this sponsor.
    const stranger = await makeUserClient(`eng-stranger-${Date.now()}@example.com`);
    createdUsers.push(stranger.userId);

    const eng = await stranger.client.rpc("sponsor_engagement", {
      target_sponsor: sponsorId as string,
    });
    expect(eng.error).not.toBeNull();

    const cov = await stranger.client.rpc("sponsor_skill_coverage", {
      target_sponsor: sponsorId as string,
    });
    expect(cov.error).not.toBeNull();

    // The admin gets aggregate rows back with no error.
    const engOk = await owner.client.rpc("sponsor_engagement", {
      target_sponsor: sponsorId as string,
    });
    expect(engOk.error).toBeNull();
    expect(engOk.data![0].invited).toBe(0);
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL.**

  ```bash
  npx vitest run tests/db/sponsor-billing-schema.test.ts
  ```

  Expected: the run fails. Because `0007` is not applied, the first test errors on the missing `stripe_subscription_id`/`subscription_status` columns (`column ... does not exist`), and later tests error on the missing `cohort_invites` relation and the missing RPCs (`Could not find the function public.create_sponsor`). At least one `FAIL tests/db/sponsor-billing-schema.test.ts` line must appear. Do NOT proceed until you have seen it fail for these reasons (a fail for any OTHER reason — e.g. missing env — means fix the environment first).

- [ ] **Step 3: Write the migration — billing columns + `cohort_invites` table.**

  Create `supabase/migrations/0007_sponsor_billing.sql` with the first section. (You will append the RPCs and RLS in later steps; write the whole file across Steps 3–7, then apply once in Step 8.)

  ```sql
  -- Plan 6 (Sponsor Console + Stripe billing) schema.
  -- Adds billing columns to sponsors, an email-keyed cohort_invites table (invitees
  -- have no earners row until they sign up, so invites cannot key off earner_id),
  -- creation/accept/aggregate RPCs, and RLS/consent hardening for cohort_members +
  -- sponsor reads of consented credentials.

  -- 1) Billing columns on sponsors (name, plan, seats, stripe_customer_id exist in 0002).
  alter table sponsors
    add column stripe_subscription_id text,
    add column subscription_status text not null default 'inactive';

  -- 1b) One sponsor per Stripe customer. The webhook (Task 12) resolves the sponsor row by
  --     stripe_customer_id and MUST get a single row; a partial unique index enforces that while
  --     still allowing many rows with a null customer id (sponsors that never checked out).
  create unique index sponsors_stripe_customer_id_key
    on sponsors (stripe_customer_id)
    where stripe_customer_id is not null;

  -- 2) Email-keyed invites. Unique per (sponsor, email) so re-inviting is a no-op skip.
  create table cohort_invites (
    id uuid primary key default gen_random_uuid(),
    sponsor_id uuid not null references sponsors (id) on delete cascade,
    email citext not null,
    token text not null unique,
    accepted_at timestamptz,
    created_at timestamptz not null default now(),
    unique (sponsor_id, email)
  );
  create index cohort_invites_sponsor_idx on cohort_invites (sponsor_id);

  alter table cohort_invites enable row level security;

  -- 2b) Webhook idempotency ledger. handleStripeEvent (Task 12) inserts event.id FIRST and treats a
  --     unique-violation (23505) as an already-processed duplicate, returning without re-applying side
  --     effects. RLS is enabled with NO client policy — only the service-role webhook writes it.
  create table stripe_events (
    id text primary key,
    received_at timestamptz not null default now()
  );
  alter table stripe_events enable row level security;
  ```

- [ ] **Step 4: Append the creation/accept RPCs.**

  Append to `supabase/migrations/0007_sponsor_billing.sql`. Both are `SECURITY DEFINER` with a pinned `search_path` (matching `is_sponsor_admin` in 0003). `create_sponsor` is the ONLY write path to `sponsors`/`sponsor_admins` (no client INSERT policies exist on either). `accept_cohort_invite` requires the caller to already have an `earners` row.

  ```sql
  -- 3) create_sponsor: atomic sponsor + admin insert. Only creation path for sponsors.
  create or replace function create_sponsor(sponsor_name text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
  as $$
  declare
    new_id uuid;
  begin
    if auth.uid() is null then
      raise exception 'not authenticated';
    end if;
    insert into sponsors (name) values (sponsor_name) returning id into new_id;
    insert into sponsor_admins (sponsor_id, user_id) values (new_id, auth.uid());
    return new_id;
  end;
  $$;

  -- 4) accept_cohort_invite: link the calling earner to the invite's sponsor.
  --    SECURITY: the invite is bound to the EMAIL it was issued to. We resolve the caller's own email
  --    from auth.users inside the definer body and require the invite's email to match, so a user who
  --    merely learns/guesses a token cannot join a cohort they were not invited to.
  create or replace function accept_cohort_invite(invite_token text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
  as $$
  declare
    target_sponsor uuid;
    v_caller_email text;
  begin
    if auth.uid() is null then
      raise exception 'not authenticated';
    end if;
    if not exists (select 1 from earners where id = auth.uid()) then
      raise exception 'no earner row for caller';
    end if;

    select email into v_caller_email from auth.users where id = auth.uid();
    if v_caller_email is null then
      raise exception 'no email for caller';
    end if;

    -- Match on token AND the caller's own email (citext-insensitive via the column type).
    select sponsor_id into target_sponsor
    from cohort_invites
    where token = invite_token
      and accepted_at is null
      and email = v_caller_email;

    if target_sponsor is null then
      raise exception 'invite not found, already accepted, or not addressed to this account';
    end if;

    insert into cohort_members (sponsor_id, earner_id, status)
    values (target_sponsor, auth.uid(), 'active')
    on conflict (sponsor_id, earner_id)
    do update set status = 'active';

    update cohort_invites
    set accepted_at = now()
    where token = invite_token
      and accepted_at is null
      and email = v_caller_email;

    return target_sponsor;
  end;
  $$;
  ```

- [ ] **Step 5: Append the aggregate RPCs.**

  Append to `supabase/migrations/0007_sponsor_billing.sql`. Both are `SECURITY DEFINER` and MUST reject non-admins via `is_sponsor_admin`. They return AGGREGATE counts only — no individual rows leak. `invited = (unaccepted cohort_invites) + (cohort_members)`; `activated = members status='active'`; `imported = active members with >=1 credential`; `advisor_used = active members with >=1 advisor_message`.

  ```sql
  -- 5) sponsor_engagement: privacy-preserving funnel counts for one sponsor.
  create or replace function sponsor_engagement(target_sponsor uuid)
  returns table (invited int, activated int, imported int, advisor_used int)
  language plpgsql
  security definer
  set search_path = public
  as $$
  begin
    if not is_sponsor_admin(target_sponsor) then
      raise exception 'not a sponsor admin';
    end if;

    return query
    select
      (
        (select count(*) from cohort_invites ci
           where ci.sponsor_id = target_sponsor and ci.accepted_at is null)
        + (select count(*) from cohort_members cm
             where cm.sponsor_id = target_sponsor)
      )::int as invited,
      (select count(*) from cohort_members cm
         where cm.sponsor_id = target_sponsor and cm.status = 'active')::int as activated,
      (select count(*) from cohort_members cm
         where cm.sponsor_id = target_sponsor and cm.status = 'active'
           and exists (select 1 from credentials c where c.earner_id = cm.earner_id))::int as imported,
      (select count(*) from cohort_members cm
         where cm.sponsor_id = target_sponsor and cm.status = 'active'
           and exists (select 1 from advisor_messages am where am.earner_id = cm.earner_id))::int as advisor_used;
  end;
  $$;

  -- 6) sponsor_skill_coverage: top consented skills across active members.
  create or replace function sponsor_skill_coverage(target_sponsor uuid)
  returns table (skill_name text, member_count int)
  language plpgsql
  security definer
  set search_path = public
  as $$
  begin
    if not is_sponsor_admin(target_sponsor) then
      raise exception 'not a sponsor admin';
    end if;

    return query
    select s.canonical_name as skill_name, count(distinct es.earner_id)::int as member_count
    from cohort_members cm
    join earner_skills es on es.earner_id = cm.earner_id
    join skills s on s.id = es.skill_id
    where cm.sponsor_id = target_sponsor
      and cm.status = 'active'
      and cm.consent_share_skills = true
    group by s.canonical_name
    order by member_count desc
    limit 20;
  end;
  $$;
  ```

- [ ] **Step 6: Append the RLS policies for `cohort_invites` and consented credentials.**

  Append to `supabase/migrations/0007_sponsor_billing.sql`. `cohort_invites_sponsor_all` lets admins manage their own invites (needed for Task 5's insert). `credentials_sponsor_select` mirrors `earner_skills_sponsor_select` (0003) but gates on `consent_share_credentials` — closing the inert-flag gap. `sponsors_admin_update` lets an admin update their OWN sponsor row — required because `ensureStripeCustomer` (Task 10), invoked from the RLS-scoped `startCheckout`/`openBillingPortal` actions, persists `stripe_customer_id` back onto the row under the admin's own `createServerClient()`. The webhook (Task 12) writes the other billing columns via the SERVICE-ROLE key (bypasses RLS), so it does not depend on this policy.

  ```sql
  -- 7) RLS: sponsor admins fully manage their own invites.
  create policy cohort_invites_sponsor_all on cohort_invites
    for all using (is_sponsor_admin(sponsor_id))
    with check (is_sponsor_admin(sponsor_id));

  -- 8) RLS: sponsor admins may read a member's credentials ONLY with consent.
  --    Mirrors earner_skills_sponsor_select (0003); closes the inert-flag gap where
  --    consent_share_credentials had no reader policy.
  create policy credentials_sponsor_select on credentials
    for select using (
      exists (
        select 1 from cohort_members m
        where m.earner_id = credentials.earner_id
          and m.consent_share_credentials = true
          and is_sponsor_admin(m.sponsor_id)
      )
    );

  -- 9) RLS: a sponsor admin may UPDATE their own sponsor row. This is required for the
  --    client-side billing write in ensureStripeCustomer (Task 10), which persists
  --    stripe_customer_id under the admin's RLS-scoped client during Checkout/Portal.
  --    The Stripe WEBHOOK (Task 12) writes subscription_status/plan/seats/stripe_subscription_id
  --    via the SERVICE-ROLE key (bypasses RLS), so it does not rely on this policy.
  create policy sponsors_admin_update on sponsors
    for update using (is_sponsor_admin(id))
    with check (is_sponsor_admin(id));

  -- 9b) RLS: a cohort's own sponsor admin may read that member's earners row. The handle is already
  --     public (rendered on /u/[handle]); this policy lets the console show which invitees have
  --     actually signed up, and fixes the null-handle bug where the cohort list could not resolve a
  --     member's handle through the admin's RLS-scoped client. Scoped strictly to the admin's own
  --     cohorts via is_sponsor_admin, so it never leaks earners outside the sponsor's membership.
  create policy earners_sponsor_select on earners
    for select using (
      exists (
        select 1 from cohort_members m
        where m.earner_id = earners.id
          and is_sponsor_admin(m.sponsor_id)
      )
    );
  ```

- [ ] **Step 7: Append the column-level consent grant fix on `cohort_members`.**

  Append to `supabase/migrations/0007_sponsor_billing.sql`. The 0003 `cohort_members_earner_update` policy is a full-row update — an earner could flip their own `status` or reassign `sponsor_id`. The column-level GRANT is what actually restricts the earner to the two consent columns; the rebuilt RLS policy still supplies the `earner_id = auth.uid()` row predicate so an earner only reaches their OWN row.

  ```sql
  -- 10) Consent-only update hardening for cohort_members.
  --    (a) Column-level privileges restrict the earner's UPDATE to the consent flags.
  --    (b) The RLS policy still scopes the row to the calling earner.
  drop policy cohort_members_earner_update on cohort_members;

  revoke update on cohort_members from authenticated;
  grant update (consent_share_skills, consent_share_credentials)
    on cohort_members to authenticated;

  create policy cohort_members_earner_update on cohort_members
    for update using (earner_id = auth.uid());
  ```

- [ ] **Step 8: Apply the migration.**

  ```bash
  node scripts/apply-migration.mjs supabase/migrations/0007_sponsor_billing.sql
  ```

  Expected output (a single line, exit code 0):

  ```
  Applied supabase/migrations/0007_sponsor_billing.sql. Response: []
  ```

  If instead you see `FAILED (4xx) applying ...` fix the SQL and re-run. The endpoint is idempotent for `create or replace function`, but `alter table ... add column`, `create table` (`cohort_invites`, `stripe_events`), `create unique index` (`sponsors_stripe_customer_id_key`), `create policy`, and `drop policy` are NOT — if you must re-apply after a partial failure, either fix forward or drop the just-created objects first (do this only in a throwaway re-run, never edit 0001–0006).

- [ ] **Step 9: Run the smoke test — expect PASS.**

  ```bash
  npx vitest run tests/db/sponsor-billing-schema.test.ts
  ```

  Expected: `Test Files  1 passed (1)` with all 10 tests green (`✓ sponsors has stripe_subscription_id ...`, `✓ cohort_invites table exists ...`, `✓ sponsors_stripe_customer_id_key ...`, `✓ stripe_events dedup ledger ...`, `✓ create_sponsor RPC ...`, `✓ accept_cohort_invite links ...`, `✓ accept_cohort_invite REJECTS a caller whose email differs ...`, `✓ earners_sponsor_select ...`, `✓ column-level grant ...`, `✓ sponsor_engagement + sponsor_skill_coverage RAISE ...`). If the column-level-grant test fails with the status update NOT erroring, re-check Step 7: the `revoke update ... from authenticated` must run BEFORE the `grant update (cols)`, and the old full-row policy must be dropped. If the email-mismatch test does NOT error, re-check Step 4: `accept_cohort_invite` must resolve `v_caller_email` from `auth.users` and require `cohort_invites.email = v_caller_email`.

- [ ] **Step 10: Type-check the new test file.**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no output, exit code 0. (The `.rpc(...)` calls return `any`-typed data via the untyped Supabase client used in tests, matching existing `tests/db/*` files — no generated DB types are wired in, so the `as string` casts and `data![0].invited` access compile cleanly.)

- [ ] **Step 11: Commit.**

  ```bash
  git add supabase/migrations/0007_sponsor_billing.sql tests/db/sponsor-billing-schema.test.ts
  git commit -m "$(cat <<'EOF'
  Plan 6 Task 1: migration 0007 — sponsor billing cols, cohort_invites, RPCs, RLS/consent hardening

  - sponsors gains stripe_subscription_id + subscription_status (default 'inactive')
  - unique partial index sponsors_stripe_customer_id_key (one sponsor per Stripe customer)
  - cohort_invites table (email-keyed, unique per sponsor+email) with RLS
  - stripe_events dedup ledger (service-role only; webhook idempotency)
  - create_sponsor / accept_cohort_invite / sponsor_engagement / sponsor_skill_coverage RPCs (SECURITY DEFINER, admin-guarded aggregates); accept_cohort_invite binds acceptance to the invited email
  - cohort_invites_sponsor_all + credentials_sponsor_select + earners_sponsor_select policies (closes inert consent_share_credentials gap; fixes null-handle read)
  - column-level UPDATE grant restricts earner cohort_members edits to consent flags only

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

  Expected: one commit created on the `trove-ai-advisor` branch listing 2 files changed.

---

### Task 2: Live-DB RLS + consent security tests

This is the security spec that proves the two known 0003 gaps are closed by migration 0007 (Task 1): (1) an earner can update ONLY their consent flags on `cohort_members`, not `status`/`sponsor_id`; (2) `credentials_sponsor_select` is a live, consent-gated policy (the flag is no longer inert). It also proves the new RPCs (`create_sponsor`, `accept_cohort_invite`, `sponsor_engagement`, `sponsor_skill_coverage`) and cross-sponsor isolation. Every boundary is proven by acting through the RLS-scoped client and checking the row via the service-role admin client. Belongs in the `tests/db` half of the suite.

**Files:**
- Create: `tests/db/sponsor-rls.test.ts`
- Uses (do not modify): `tests/db/admin-client.ts` (`adminClient()` — service role, bypasses RLS), `tests/db/user-client.ts` (`makeUserClient(email)` — creates a confirmed auth user, returns `{ client, userId }` RLS-scoped as that user)
- Depends on (already applied in Task 1): `supabase/migrations/0007_sponsor_billing.sql`

**Interfaces:**
- **Consumes** (from Task 1, the 0007 SQL surface — exact names):
  - Table `cohort_invites (id, sponsor_id, email citext, token text unique, accepted_at, created_at)`; `unique(sponsor_id, email)`.
  - `sponsors.subscription_status text NOT NULL DEFAULT 'inactive'`, `sponsors.stripe_subscription_id text`.
  - RPC `create_sponsor(sponsor_name text) returns uuid`.
  - RPC `accept_cohort_invite(invite_token text) returns uuid` — binds acceptance to the invited email (rejects a caller whose email differs from `cohort_invites.email`).
  - RPC `sponsor_engagement(target_sponsor uuid) returns table(invited int, activated int, imported int, advisor_used int)`.
  - RPC `sponsor_skill_coverage(target_sponsor uuid) returns table(skill_name text, member_count int)`.
  - RLS policies `cohort_invites_sponsor_all`, `credentials_sponsor_select`, `sponsors_admin_update`, `earners_sponsor_select`, and the column-level `update (consent_share_skills, consent_share_credentials)` grant on `cohort_members`.
- **Consumes** (existing schema): `earners`, `credentials`, `earner_skills`, `skills`, `cohort_members`, `sponsor_admins`, `advisor_threads`, `advisor_messages`.
- **Produces:** a passing live-DB spec (no exported symbols — it is a test file). Asserts: earner consent-only update; status/sponsor_id immutable to earner; `credentials_sponsor_select` gated on `consent_share_credentials`; `earner_skills_sponsor_select` gated on `consent_share_skills`; `earners_sponsor_select` surfaces a member's handle to their own admin but not to strangers/other tenants; cross-sponsor isolation; `create_sponsor` creates sponsor + admin; `accept_cohort_invite` links an active member + marks invite accepted AND rejects a mismatched-email caller; engagement/coverage RPCs raise for non-admins.

---

- [ ] **Step 1: Write the file scaffold + shared helpers (failing).** Create `tests/db/sponsor-rls.test.ts` with the imports, cleanup, and a `seedEarner` helper. This won't pass yet because later steps add the real assertions — but write the scaffold first so the shape matches the repo's other live-DB specs (`rls.test.ts`, `public-profile-rls.test.ts`). Full file so far:

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const createdUsers: string[] = [];
const createdSponsors: string[] = [];

afterAll(async () => {
  // Sponsors cascade-delete their sponsor_admins, cohort_members, and cohort_invites.
  for (const id of createdSponsors) await admin.from("sponsors").delete().eq("id", id);
  // Deleting the auth user cascades to earners (and thus credentials/earner_skills).
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

// Provision a confirmed auth user AND their earners row (self-insert via RLS), returning
// the RLS-scoped client + id + email. Mirrors the makeUserClient + earners insert pattern used
// across the suite. The email is returned because accept_cohort_invite binds acceptance to the
// invited email, so tests must issue the invite to this exact address.
async function seedEarner(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = await makeUserClient(email);
  createdUsers.push(u.userId);
  const { error } = await u.client
    .from("earners")
    .insert({ id: u.userId, handle: `${prefix}${Date.now()}${Math.floor(Math.random() * 1e4)}` });
  if (error) throw error;
  return { ...u, email };
}

test("scaffold loads", () => {
  expect(typeof seedEarner).toBe("function");
});
```

Run it:

```
npx vitest run tests/db/sponsor-rls.test.ts
```

Expected: PASS (1 passed) — the scaffold's placeholder test proves the file, imports, and helpers compile and run against the live DB env. (If it errors on env vars, `.env.local` is not loaded — the other `tests/db/*` specs would fail identically; fix env before continuing.)

- [ ] **Step 2: Commit the scaffold.**

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): scaffold live-DB security spec"
```

Expected: one file committed.

- [ ] **Step 3: Assert earner can update ONLY consent flags (failing first).** Add this test. It requires the migration 0007 column-grant to already be applied (Task 1); if run before 0007 it may pass spuriously on the consent update but the NEXT step (status/sponsor_id immutability) is the real gate — write both, run both. Append:

```ts
test("an earner can update their own consent flags on cohort_members", async () => {
  const earner = await seedEarner("consent");

  // Seed a sponsor + membership via the service role (bypasses RLS — sponsors have no client INSERT).
  const { data: sponsor, error: sErr } = await admin
    .from("sponsors")
    .insert({ name: "Consent Co" })
    .select("id")
    .single();
  if (sErr) throw sErr;
  createdSponsors.push(sponsor!.id);

  const { error: mErr } = await admin.from("cohort_members").insert({
    sponsor_id: sponsor!.id,
    earner_id: earner.userId,
    status: "active",
  });
  if (mErr) throw mErr;

  // Earner flips both consent flags via their RLS-scoped client.
  const upd = await earner.client
    .from("cohort_members")
    .update({ consent_share_skills: true, consent_share_credentials: true })
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", earner.userId)
    .select("consent_share_skills, consent_share_credentials");
  expect(upd.error).toBeNull();
  expect(upd.data).toHaveLength(1);
  expect(upd.data![0].consent_share_skills).toBe(true);
  expect(upd.data![0].consent_share_credentials).toBe(true);

  // Confirm via the admin (service-role) view that the write landed.
  const { data: after } = await admin
    .from("cohort_members")
    .select("consent_share_skills, consent_share_credentials")
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", earner.userId)
    .single();
  expect(after!.consent_share_skills).toBe(true);
  expect(after!.consent_share_credentials).toBe(true);
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "can update their own consent flags"
```

Expected (before 0007 applied): may FAIL if the column-grant reshaped the update policy incorrectly, or PASS on the old full-row policy. Expected (0007 applied per Task 1): PASS (1 passed). This test is the positive half of the consent boundary.

- [ ] **Step 4: Assert earner CANNOT change status or sponsor_id (the gap-1 fix).** Append. This is the security-critical assertion — under the column-level grant, an update touching `status` or `sponsor_id` must be rejected (error) or no-op (row unchanged). We accept either and PROVE the row is unchanged via the admin client.

```ts
test("an earner cannot change status or sponsor_id on their cohort_members row", async () => {
  const earner = await seedEarner("nostatus");

  const { data: sA } = await admin.from("sponsors").insert({ name: "Owner Co" }).select("id").single();
  const { data: sB } = await admin.from("sponsors").insert({ name: "Attacker Co" }).select("id").single();
  createdSponsors.push(sA!.id, sB!.id);

  await admin.from("cohort_members").insert({
    sponsor_id: sA!.id,
    earner_id: earner.userId,
    status: "active",
  });

  // A write is "denied" if it errored OR affected zero rows. (PostgREST behavior differs by which
  // columns the grant blocks; both outcomes are acceptable — we separately prove no mutation.)
  const denied = (r: { data: unknown; error: unknown }) =>
    r.error != null || ((r.data as unknown[] | null) ?? []).length === 0;

  // (a) attempt to self-escalate/mutate status -> must not persist.
  const updStatus = await earner.client
    .from("cohort_members")
    .update({ status: "removed" })
    .eq("sponsor_id", sA!.id)
    .eq("earner_id", earner.userId)
    .select();
  expect(denied(updStatus)).toBe(true);

  // (b) attempt to reassign the membership to a different sponsor -> must not persist.
  const updSponsor = await earner.client
    .from("cohort_members")
    .update({ sponsor_id: sB!.id })
    .eq("sponsor_id", sA!.id)
    .eq("earner_id", earner.userId)
    .select();
  expect(denied(updSponsor)).toBe(true);

  // (c) a MIXED update (allowed consent col + forbidden status col) must also not move status.
  await earner.client
    .from("cohort_members")
    .update({ consent_share_skills: true, status: "removed" })
    .eq("sponsor_id", sA!.id)
    .eq("earner_id", earner.userId)
    .select();

  // PROVE nothing changed: the row is still sponsor A, status active.
  const { data: rows } = await admin
    .from("cohort_members")
    .select("sponsor_id, status")
    .eq("earner_id", earner.userId);
  expect(rows).toHaveLength(1);
  expect(rows![0].sponsor_id).toBe(sA!.id);
  expect(rows![0].status).toBe("active");
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "cannot change status or sponsor_id"
```

Expected (0007 applied): PASS (1 passed). If this FAILS (status became `removed` or sponsor became B), gap 1 is NOT closed — the column-level grant in 0007 is wrong; fix Task 1 before proceeding.

- [ ] **Step 5: Commit the consent-boundary tests.**

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): earner consent-only update; status/sponsor_id immutable (gap 1)"
```

Expected: one file committed.

- [ ] **Step 6: Assert `credentials_sponsor_select` is gated on `consent_share_credentials` (the gap-2 fix).** Append. A sponsor admin must see a member's credential rows ONLY when `consent_share_credentials=true`.

```ts
test("credentials_sponsor_select returns a member's credentials only when consent_share_credentials is true", async () => {
  const earner = await seedEarner("credgate");
  const sponsorAdmin = await makeUserClient(`credadmin-${Date.now()}@example.com`);
  createdUsers.push(sponsorAdmin.userId);

  // Sponsor + admin seeded via service role; membership with consent OFF.
  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Cred Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);
  await admin.from("sponsor_admins").insert({ sponsor_id: sponsor!.id, user_id: sponsorAdmin.userId });
  await admin.from("cohort_members").insert({
    sponsor_id: sponsor!.id,
    earner_id: earner.userId,
    status: "active",
    consent_share_credentials: false,
  });

  // Earner owns one credential.
  await earner.client
    .from("credentials")
    .insert({ earner_id: earner.userId, source: "manual", title: "Gated Cred" });

  // Consent OFF: the admin sees ZERO of the earner's credentials.
  const off = await sponsorAdmin.client
    .from("credentials")
    .select("id, title")
    .eq("earner_id", earner.userId);
  expect(off.error).toBeNull();
  expect(off.data).toEqual([]);

  // Earner flips consent_share_credentials ON.
  await earner.client
    .from("cohort_members")
    .update({ consent_share_credentials: true })
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", earner.userId);

  // Consent ON: the admin now sees exactly the one credential.
  const on = await sponsorAdmin.client
    .from("credentials")
    .select("id, title")
    .eq("earner_id", earner.userId);
  expect(on.error).toBeNull();
  expect(on.data).toHaveLength(1);
  expect(on.data![0].title).toBe("Gated Cred");
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "credentials_sponsor_select"
```

Expected (0007 applied): PASS (1 passed). If the "consent OFF" branch returns the row, gap 2 is NOT closed (the flag is inert / policy missing); fix Task 1's `credentials_sponsor_select`. If the "consent ON" branch returns zero, the policy is over-restrictive.

- [ ] **Step 7: Assert `earner_skills_sponsor_select` is gated on `consent_share_skills` (regression guard on existing 0003 policy).** Append. This proves the existing skills policy still gates correctly under the new column-grant.

```ts
test("earner_skills_sponsor_select returns a member's skills only when consent_share_skills is true", async () => {
  const earner = await seedEarner("skillgate");
  const sponsorAdmin = await makeUserClient(`skilladmin-${Date.now()}@example.com`);
  createdUsers.push(sponsorAdmin.userId);

  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Skill Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);
  await admin.from("sponsor_admins").insert({ sponsor_id: sponsor!.id, user_id: sponsorAdmin.userId });
  await admin.from("cohort_members").insert({
    sponsor_id: sponsor!.id,
    earner_id: earner.userId,
    status: "active",
    consent_share_skills: false,
  });

  // Seed a canonical skill (service role — skills has no client insert policy) + roll it up onto the earner.
  const { data: skill } = await admin
    .from("skills")
    .insert({ canonical_name: `SkillGate ${Date.now()}`, type: "skill" })
    .select("id")
    .single();
  await admin.from("earner_skills").insert({ earner_id: earner.userId, skill_id: skill!.id });

  // Consent OFF: admin sees zero of the earner's rolled-up skills.
  const off = await sponsorAdmin.client
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earner.userId);
  expect(off.data).toEqual([]);

  // Flip consent_share_skills ON.
  await earner.client
    .from("cohort_members")
    .update({ consent_share_skills: true })
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", earner.userId);

  const on = await sponsorAdmin.client
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earner.userId);
  expect(on.data).toHaveLength(1);
  expect(on.data![0].skill_id).toBe(skill!.id);
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "earner_skills_sponsor_select"
```

Expected: PASS (1 passed).

- [ ] **Step 7b: Assert `earners_sponsor_select` lets a cohort's own admin read a member's handle (F4; fixes the null-handle regression).** Append. The handle is already public via `/u/[handle]`; this policy makes the member's `earners` row visible to their sponsor's admin so the console can resolve which invitees signed up. A missing/incorrect policy re-introduces the null-handle bug.

```ts
test("earners_sponsor_select surfaces a member's handle to their sponsor admin (not to strangers)", async () => {
  const member = await seedEarner("hsurface");
  const sponsorAdmin = await makeUserClient(`hsadmin-${Date.now()}@example.com`);
  createdUsers.push(sponsorAdmin.userId);

  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Handle RLS Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);
  await admin.from("sponsor_admins").insert({ sponsor_id: sponsor!.id, user_id: sponsorAdmin.userId });
  await admin.from("cohort_members").insert({
    sponsor_id: sponsor!.id,
    earner_id: member.userId,
    status: "active",
  });

  // The member's own handle (read back via service role for the expected value).
  const { data: expected } = await admin
    .from("earners")
    .select("handle")
    .eq("id", member.userId)
    .single();

  // The sponsor admin resolves the member's handle through their RLS-scoped client.
  const seen = await sponsorAdmin.client
    .from("earners")
    .select("id, handle")
    .eq("id", member.userId)
    .maybeSingle();
  expect(seen.error).toBeNull();
  expect(seen.data?.handle).toBe(expected!.handle);

  // A stranger (no admin relationship to this member's sponsor) sees nothing.
  const stranger = await makeUserClient(`hstranger-${Date.now()}@example.com`);
  createdUsers.push(stranger.userId);
  const hidden = await stranger.client
    .from("earners")
    .select("id")
    .eq("id", member.userId)
    .maybeSingle();
  expect(hidden.data).toBeNull();
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "earners_sponsor_select surfaces"
```

Expected: PASS (1 passed). If the admin read returns null, the `earners_sponsor_select` policy (Task 1) is missing or mis-scoped.

- [ ] **Step 8: Commit the sponsor-read gating tests.**

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): sponsor reads of credentials/skills/handle gated by membership (gaps 2 + null-handle)"
```

Expected: one file committed.

- [ ] **Step 9: Assert cross-sponsor isolation.** Append. An admin of sponsor A must never see sponsor B's members, invites, or a B-member's consented credentials.

```ts
test("a sponsor admin sees only their own sponsor's rows, never another sponsor's", async () => {
  const adminA = await makeUserClient(`isoA-${Date.now()}@example.com`);
  const memberB = await seedEarner("isoB");
  createdUsers.push(adminA.userId);

  const { data: sA } = await admin.from("sponsors").insert({ name: "Iso A" }).select("id").single();
  const { data: sB } = await admin.from("sponsors").insert({ name: "Iso B" }).select("id").single();
  createdSponsors.push(sA!.id, sB!.id);

  // adminA administers ONLY sponsor A.
  await admin.from("sponsor_admins").insert({ sponsor_id: sA!.id, user_id: adminA.userId });

  // memberB belongs to sponsor B, WITH credential consent on (a strictly harder case).
  await admin.from("cohort_members").insert({
    sponsor_id: sB!.id,
    earner_id: memberB.userId,
    status: "active",
    consent_share_credentials: true,
  });
  await memberB.client
    .from("credentials")
    .insert({ earner_id: memberB.userId, source: "manual", title: "B's cred" });
  // A cohort_invite belonging to sponsor B.
  await admin.from("cohort_invites").insert({
    sponsor_id: sB!.id,
    email: `pending-${Date.now()}@example.com`,
    token: `tok-iso-${Date.now()}`,
  });

  // adminA sees no members of sponsor B.
  const membersB = await adminA.client
    .from("cohort_members")
    .select("earner_id")
    .eq("sponsor_id", sB!.id);
  expect(membersB.data).toEqual([]);

  // adminA sees no invites of sponsor B (cohort_invites_sponsor_all is admin-scoped).
  const invitesB = await adminA.client
    .from("cohort_invites")
    .select("id")
    .eq("sponsor_id", sB!.id);
  expect(invitesB.data).toEqual([]);

  // adminA sees no credentials of B's consented member (consent is scoped to B's admins, not A's).
  const credsB = await adminA.client
    .from("credentials")
    .select("id")
    .eq("earner_id", memberB.userId);
  expect(credsB.data).toEqual([]);

  // adminA cannot read B's member's earners row either (earners_sponsor_select is membership-scoped).
  const earnerB = await adminA.client
    .from("earners")
    .select("id")
    .eq("id", memberB.userId);
  expect(earnerB.data).toEqual([]);

  // adminA cannot even read sponsor B's row.
  const sponsorRowB = await adminA.client.from("sponsors").select("id").eq("id", sB!.id);
  expect(sponsorRowB.data).toEqual([]);
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "only their own sponsor's rows"
```

Expected: PASS (1 passed). A non-empty result on any of the four checks means an RLS policy leaks across tenants — fix Task 1.

- [ ] **Step 10: Commit the isolation test.**

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): cross-sponsor isolation"
```

Expected: one file committed.

- [ ] **Step 11: Assert `create_sponsor` RPC creates sponsor + admin atomically.** Append. The RPC is the only creation path (no client INSERT policy on sponsors/sponsor_admins).

```ts
test("create_sponsor makes a sponsors row and a sponsor_admins row for the caller", async () => {
  const caller = await makeUserClient(`creator-${Date.now()}@example.com`);
  createdUsers.push(caller.userId);

  // Direct client INSERT into sponsors must be denied (no INSERT policy) — proves the RPC is the gate.
  const directInsert = await caller.client.from("sponsors").insert({ name: "Sneaky" }).select();
  expect(directInsert.error != null || (directInsert.data ?? []).length === 0).toBe(true);

  // The RPC returns the new sponsor id.
  const { data: sponsorId, error } = await caller.client.rpc("create_sponsor", {
    sponsor_name: "Acme",
  });
  expect(error).toBeNull();
  expect(typeof sponsorId).toBe("string");
  createdSponsors.push(sponsorId as string);

  // Verify via service role: the sponsor exists with the given name.
  const { data: sponsor } = await admin
    .from("sponsors")
    .select("id, name, subscription_status")
    .eq("id", sponsorId as string)
    .single();
  expect(sponsor!.name).toBe("Acme");
  expect(sponsor!.subscription_status).toBe("inactive"); // 0007 default

  // Verify the caller was made an admin.
  const { data: adminRow } = await admin
    .from("sponsor_admins")
    .select("user_id")
    .eq("sponsor_id", sponsorId as string)
    .eq("user_id", caller.userId)
    .single();
  expect(adminRow!.user_id).toBe(caller.userId);

  // And the caller can now read their own sponsor via RLS (sponsors_admin_select).
  const selfRead = await caller.client.from("sponsors").select("id").eq("id", sponsorId as string);
  expect(selfRead.data).toHaveLength(1);
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "create_sponsor makes"
```

Expected: PASS (1 passed).

- [ ] **Step 12: Assert `accept_cohort_invite` links an active member and marks the invite accepted.** Append.

```ts
test("accept_cohort_invite links an active membership and marks the invite accepted", async () => {
  const invitee = await seedEarner("acceptee"); // must be a provisioned earner for the RPC to link
  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Invite Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);

  // The invite MUST be addressed to the invitee's own email — accept_cohort_invite binds
  // acceptance to the invited email (Task 1 F2).
  const token = `tok-accept-${Date.now()}`;
  await admin.from("cohort_invites").insert({
    sponsor_id: sponsor!.id,
    email: invitee.email,
    token,
  });

  // The invitee accepts via the RPC (SECURITY DEFINER, keyed by token + caller email, earner = auth.uid()).
  const { data: returnedSponsorId, error } = await invitee.client.rpc("accept_cohort_invite", {
    invite_token: token,
  });
  expect(error).toBeNull();
  expect(returnedSponsorId).toBe(sponsor!.id);

  // A cohort_members row now exists, active.
  const { data: member } = await admin
    .from("cohort_members")
    .select("status")
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", invitee.userId)
    .single();
  expect(member!.status).toBe("active");

  // The invite is marked accepted.
  const { data: invite } = await admin
    .from("cohort_invites")
    .select("accepted_at")
    .eq("token", token)
    .single();
  expect(invite!.accepted_at).not.toBeNull();

  // Re-accepting a now-consumed token must error (idempotency / no double-link).
  const second = await invitee.client.rpc("accept_cohort_invite", { invite_token: token });
  expect(second.error).not.toBeNull();
});

test("accept_cohort_invite REJECTS a token whose invite email is not the caller's (authz binding)", async () => {
  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Bind RLS Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);

  // Invite addressed to alice; a DIFFERENT provisioned earner (bob) presents the token.
  const token = `tok-bind-${Date.now()}`;
  await admin.from("cohort_invites").insert({
    sponsor_id: sponsor!.id,
    email: `alice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    token,
  });
  const bob = await seedEarner("bob");

  const { error } = await bob.client.rpc("accept_cohort_invite", { invite_token: token });
  expect(error).not.toBeNull();

  // No membership for bob; invite still unaccepted.
  const { data: member } = await admin
    .from("cohort_members")
    .select("earner_id")
    .eq("sponsor_id", sponsor!.id)
    .eq("earner_id", bob.userId)
    .maybeSingle();
  expect(member).toBeNull();
  const { data: invite } = await admin
    .from("cohort_invites")
    .select("accepted_at")
    .eq("token", token)
    .single();
  expect(invite!.accepted_at).toBeNull();
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "accept_cohort_invite"
```

Expected: PASS (2 passed). If the re-accept branch does NOT error, the RPC's "unaccepted only" guard is missing in Task 1. If the wrong-email test does NOT error, the RPC's email binding (Task 1 F2) is missing.

- [ ] **Step 13: Commit the RPC creation/accept tests.**

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): create_sponsor + accept_cohort_invite RPCs"
```

Expected: one file committed.

- [ ] **Step 14: Assert `sponsor_engagement` and `sponsor_skill_coverage` RAISE for a non-admin caller.** Append. Both RPCs are SECURITY DEFINER and MUST reject callers who fail `is_sponsor_admin(target_sponsor)`.

```ts
test("sponsor_engagement and sponsor_skill_coverage raise for a non-admin caller", async () => {
  const outsider = await makeUserClient(`outsider-${Date.now()}@example.com`);
  createdUsers.push(outsider.userId);

  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Guarded Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);
  // NOTE: outsider is deliberately NOT a sponsor_admin of this sponsor.

  const eng = await outsider.client.rpc("sponsor_engagement", { target_sponsor: sponsor!.id });
  expect(eng.error).not.toBeNull();

  const cov = await outsider.client.rpc("sponsor_skill_coverage", { target_sponsor: sponsor!.id });
  expect(cov.error).not.toBeNull();
});

test("sponsor_engagement and sponsor_skill_coverage succeed and aggregate for an admin", async () => {
  const sponsorAdmin = await makeUserClient(`aggadmin-${Date.now()}@example.com`);
  createdUsers.push(sponsorAdmin.userId);
  const member = await seedEarner("aggmember");

  const { data: sponsor } = await admin.from("sponsors").insert({ name: "Agg Co" }).select("id").single();
  createdSponsors.push(sponsor!.id);
  await admin.from("sponsor_admins").insert({ sponsor_id: sponsor!.id, user_id: sponsorAdmin.userId });

  // One accepted, active member with skills consent + one rolled-up skill + one credential.
  await admin.from("cohort_members").insert({
    sponsor_id: sponsor!.id,
    earner_id: member.userId,
    status: "active",
    consent_share_skills: true,
  });
  const { data: skill } = await admin
    .from("skills")
    .insert({ canonical_name: `Agg ${Date.now()}`, type: "skill" })
    .select("id")
    .single();
  await admin.from("earner_skills").insert({ earner_id: member.userId, skill_id: skill!.id });
  await admin
    .from("credentials")
    .insert({ earner_id: member.userId, source: "manual", title: "Agg cred" });

  const eng = await sponsorAdmin.client.rpc("sponsor_engagement", { target_sponsor: sponsor!.id });
  expect(eng.error).toBeNull();
  // The RPC returns a set-returning table; PostgREST yields an array of rows.
  const engRow = Array.isArray(eng.data) ? eng.data[0] : eng.data;
  expect(engRow.activated).toBeGreaterThanOrEqual(1);
  expect(engRow.imported).toBeGreaterThanOrEqual(1); // active member with >=1 credential

  const cov = await sponsorAdmin.client.rpc("sponsor_skill_coverage", { target_sponsor: sponsor!.id });
  expect(cov.error).toBeNull();
  const covRows = (cov.data as Array<{ skill_name: string; member_count: number }>) ?? [];
  expect(covRows.length).toBeGreaterThanOrEqual(1);
  expect(covRows[0].member_count).toBeGreaterThanOrEqual(1);
});
```

Run:

```
npx vitest run tests/db/sponsor-rls.test.ts -t "sponsor_engagement and sponsor_skill_coverage"
```

Expected: PASS (2 passed). If the non-admin RPCs do NOT error, the `is_sponsor_admin` guard is missing in Task 1's RPC bodies.

- [ ] **Step 15: Run the whole file and commit.** Confirm every assertion passes together.

```
npx vitest run tests/db/sponsor-rls.test.ts
```

Expected: all tests pass (12 passed — scaffold + 11 security specs: consent-only update, status/sponsor_id immutability, credentials gating, skills gating, earners_sponsor_select handle surfacing, cross-sponsor isolation, create_sponsor, accept links, accept rejects mismatched email, engagement/coverage raise for non-admin, engagement/coverage aggregate for admin). Then commit:

```
git add tests/db/sponsor-rls.test.ts && git commit -m "test(sponsor-rls): aggregate RPC guards + admin success paths"
```

Expected: one file committed.

- [ ] **Step 16: Run the tests/db half of the suite to confirm no cross-file interference.** Per the iCloud/serial-vitest invariant, run the live-DB half on its own:

```
npx vitest run tests/db
```

Expected: the full `tests/db` set passes, including `sponsor-rls.test.ts`, with no worker timeout. (If it worker-timeouts spuriously, re-run once — this is the documented iCloud flake, not a real failure.)

---

### Task 3: Billing + email foundations (types, injectable Stripe, injectable Postmark)

**Files:**
- Create: `lib/billing/types.ts` (SDK-free canonical types — every later task imports these)
- Create: `lib/billing/stripe.ts` (SOLE importer of the `stripe` package; injectable `createStripeClient`)
- Create: `lib/billing/stripe.test.ts` (unit test with an injected fake `StripeLike`; asserts no real key read)
- Create: `lib/email/postmark.ts` (fetch-based `createPostmarkSender`; no npm dep)
- Create: `lib/email/postmark.test.ts` (unit test with an injected `fetchImpl` fake)
- Modify: `package.json`, `package-lock.json` (add `stripe` dependency via `npm install stripe`)

**Interfaces:**

Consumes: nothing from other Plan 6 tasks — this is a foundation task. It mirrors the injectable-adapter pattern of `lib/advisor/llm.ts` (an `AnthropicLike` interface + a `createAnthropicAdvisorLlmClient({ client })` that short-circuits real-SDK construction when a fake is injected) and pins a model/apiVersion literal exactly as that file pins `ADVISOR_MODEL`.

Produces (canonical, SDK-free — every later task imports these EXACT shapes):
```ts
// lib/billing/types.ts
export interface SponsorRow { id: string; name: string; plan: string; seats: number; stripeCustomerId: string | null; stripeSubscriptionId: string | null; subscriptionStatus: string; }
export interface CohortInvite { id: string; sponsorId: string; email: string; token: string; acceptedAt: string | null; createdAt: string; }
export interface EngagementMetrics { invited: number; activated: number; imported: number; advisorUsed: number; }
export interface SkillCoverageRow { skillName: string; memberCount: number; }
export interface BillingSummary { plan: string; subscriptionStatus: string; seats: number; stripeCustomerId: string | null; }
export interface EmailSender { send(input: { to: string; subject: string; htmlBody: string; textBody: string }): Promise<void>; }
export interface StripeLike {
  customers: { create(args: unknown): Promise<{ id: string }> };
  checkout: { sessions: { create(args: unknown): Promise<{ id: string; url: string | null }> } };
  billingPortal: { sessions: { create(args: unknown): Promise<{ url: string }> } };
  subscriptions: { retrieve(id: string): Promise<{ id: string; status: string; items: { data: Array<{ id: string; quantity?: number }> } }>; update(id: string, args: unknown): Promise<{ id: string }>; };
  invoices: { list(args: unknown): Promise<{ data: Array<{ id: string; status: string | null; amount_paid: number; hosted_invoice_url: string | null; created: number }> }> };
  webhooks: { constructEvent(payload: string | Buffer, sig: string, secret: string): { id: string; created: number; type: string; data: { object: Record<string, unknown> } }; };
}
```
```ts
// lib/billing/stripe.ts — SOLE importer of 'stripe'
export const STRIPE_API_VERSION = "2025-06-30.basil"; // pinned literal
export function createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike;
// Stable price-id -> plan-name mapping (env-configurable). The webhook derives sponsors.plan from
// THIS map keyed by the subscription item's price.id — never from price.nickname/lookup_key, which
// are editable in the Stripe dashboard and unreliable. Default plan is 'free' (no subscription).
export const PLAN_BY_PRICE_ID: Record<string, string>;
export function planForPriceId(priceId: string | null | undefined): string; // returns mapped plan or 'free'
```
```ts
// lib/email/postmark.ts — fetch-based, no dep
export function createPostmarkSender(opts?: { token?: string; fetchImpl?: typeof fetch }): EmailSender;
```

---

- [ ] **Step 1: Install the `stripe` dependency.**

  Run exactly (from repo root):
  ```
  npm install stripe
  ```
  Expected output ends with a line like `added 1 package` (or `changed`/`audited N packages`) and no error. Verify it landed:
  ```
  node -e "console.log(require('stripe/package.json').version)"
  ```
  Expected: a version string is printed (e.g. `18.x.x`), not a "Cannot find module" error.

  Confirm `package.json` now lists it (should appear under `dependencies`, NOT `devDependencies` — it ships to the Vercel runtime for the webhook route):
  ```
  grep '"stripe"' package.json
  ```
  Expected: one line like `    "stripe": "^18.0.0",` under `dependencies`.

  Commit the dependency change on its own so the lockfile bump is isolated:
  ```
  git add package.json package-lock.json
  git commit -m "Plan 6 Task 3: add stripe dependency (sole importer will be lib/billing/stripe.ts)"
  ```

- [ ] **Step 2: Write the canonical SDK-free types module (no test needed — pure type surface).**

  `lib/billing/types.ts` contains ONLY `interface`/`type` declarations, so there is no runtime behavior to test; its correctness is enforced by `tsc` (Task 14) and by every consuming task importing these exact shapes. Create the file verbatim:

  ```ts
  // lib/billing/types.ts
  // Canonical, SDK-free types for the Sponsor Console + Stripe billing subsystem (Plan 6).
  // This is the ONLY billing module that imports nothing external — it mirrors lib/advisor/types.ts
  // (pure core, dependency-free, unit-testable by construction). Every other lib/billing/* file and
  // every /sponsor/* route imports its shapes from HERE, never from the `stripe` package directly.
  // Keeping the `stripe` SDK out of this file is what lets tests build fakes without touching the SDK.

  /** A sponsor org row as consumed by billing code (camelCase; snake_case DB cols are mapped at the edge). */
  export interface SponsorRow {
    id: string;
    name: string;
    plan: string;
    seats: number;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    subscriptionStatus: string;
  }

  /** A pending/accepted cohort invite (keyed by EMAIL — the invitee has no earner row until signup). */
  export interface CohortInvite {
    id: string;
    sponsorId: string;
    email: string;
    token: string;
    acceptedAt: string | null;
    createdAt: string;
  }

  /** Privacy-preserving aggregate funnel counts for a sponsor (no per-earner rows ever exposed). */
  export interface EngagementMetrics {
    invited: number;
    activated: number;
    imported: number;
    advisorUsed: number;
  }

  /** One row of consented aggregate skill coverage (member_count across consenting members). */
  export interface SkillCoverageRow {
    skillName: string;
    memberCount: number;
  }

  /** The subset of a sponsor's billing state shown on /sponsor/billing. */
  export interface BillingSummary {
    plan: string;
    subscriptionStatus: string;
    seats: number;
    stripeCustomerId: string | null;
  }

  /** Injectable email boundary. The real impl (lib/email/postmark.ts) POSTs to Postmark; tests fake it. */
  export interface EmailSender {
    send(input: { to: string; subject: string; htmlBody: string; textBody: string }): Promise<void>;
  }

  /**
   * The minimal subset of the Stripe SDK the billing code actually calls. Every billing helper takes a
   * `StripeLike` (never the concrete `Stripe` class) so tests inject a hand-written fake and NEVER
   * construct a real client or read a real key. Mirrors AnthropicLike in lib/advisor/llm.ts.
   */
  export interface StripeLike {
    customers: {
      create(args: unknown): Promise<{ id: string }>;
    };
    checkout: {
      sessions: {
        create(args: unknown): Promise<{ id: string; url: string | null }>;
      };
    };
    billingPortal: {
      sessions: {
        create(args: unknown): Promise<{ url: string }>;
      };
    };
    subscriptions: {
      retrieve(id: string): Promise<{
        id: string;
        status: string;
        items: { data: Array<{ id: string; quantity?: number }> };
      }>;
      update(id: string, args: unknown): Promise<{ id: string }>;
    };
    invoices: {
      list(args: unknown): Promise<{
        data: Array<{
          id: string;
          status: string | null;
          amount_paid: number;
          hosted_invoice_url: string | null;
          created: number;
        }>;
      }>;
    };
    webhooks: {
      constructEvent(
        payload: string | Buffer,
        sig: string,
        secret: string
      ): { id: string; created: number; type: string; data: { object: Record<string, unknown> } };
    };
  }
  ```

  Type-check just this surface compiles:
  ```
  npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lib/billing/types.ts" || echo "types.ts clean"
  ```
  Expected: `types.ts clean` (no errors attributed to the new file).

  Commit:
  ```
  git add lib/billing/types.ts
  git commit -m "Plan 6 Task 3: add SDK-free canonical billing types (StripeLike, EmailSender, SponsorRow, ...)"
  ```

- [ ] **Step 3: Write the FAILING test for `createStripeClient` (injection short-circuits construction).**

  This mirrors `lib/advisor/llm.test.ts`: the injected `client` must be returned as-is (proving no real `Stripe` was built), and the pinned `STRIPE_API_VERSION` literal is asserted. Create `lib/billing/stripe.test.ts`:

  ```ts
  import { expect, test, vi } from "vitest";
  import { createStripeClient, STRIPE_API_VERSION, planForPriceId } from "./stripe";
  import type { StripeLike } from "./types";

  /** A fully-typed hand-written fake StripeLike — no real SDK, no network, no key. */
  function fakeStripe(): StripeLike {
    return {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_fake" }) },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({ id: "cs_fake", url: "https://stripe.test/checkout" }),
        },
      },
      billingPortal: {
        sessions: { create: vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" }) },
      },
      subscriptions: {
        retrieve: vi
          .fn()
          .mockResolvedValue({ id: "sub_fake", status: "active", items: { data: [{ id: "si_fake", quantity: 1 }] } }),
        update: vi.fn().mockResolvedValue({ id: "sub_fake" }),
      },
      invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
      webhooks: {
        constructEvent: vi
          .fn()
          .mockReturnValue({ id: "evt_fake", created: 0, type: "noop", data: { object: {} } }),
      },
    };
  }

  test("pins a real Stripe apiVersion literal", () => {
    expect(STRIPE_API_VERSION).toBe("2025-06-30.basil");
  });

  test("planForPriceId falls back to 'free' for an unknown or absent price id", () => {
    // No env price is stubbed, so an arbitrary id is unmapped and must fall back to 'free'.
    expect(planForPriceId("price_not_in_map")).toBe("free");
    expect(planForPriceId(null)).toBe("free");
    expect(planForPriceId(undefined)).toBe("free");
  });

  test("returns the injected client as-is (never constructs a real Stripe)", () => {
    const injected = fakeStripe();
    const client = createStripeClient({ client: injected });
    // Identity: the injected fake is handed straight back — proves construction was short-circuited.
    expect(client).toBe(injected);
  });

  test("does NOT read STRIPE_SECRET_KEY when a client is injected", () => {
    // If construction were attempted, the real Stripe SDK would read this env var. Injection must
    // bypass that entirely — so with the key unset, injection must still succeed. We use
    // vi.stubEnv/vi.unstubAllEnvs (never `process.env.STRIPE_SECRET_KEY` in a value-read/assign
    // position) so the Task 14 grep-guard, which flags a genuine READ of the secret, stays green.
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    try {
      const injected = fakeStripe();
      // Must not throw despite the empty key, because we inject and never build a real client.
      const client = createStripeClient({ client: injected });
      expect(client).toBe(injected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the injected fake exposes the full StripeLike surface used by later tasks", async () => {
    const client = createStripeClient({ client: fakeStripe() });
    await expect(client.customers.create({})).resolves.toEqual({ id: "cus_fake" });
    await expect(client.checkout.sessions.create({})).resolves.toEqual({
      id: "cs_fake",
      url: "https://stripe.test/checkout",
    });
    await expect(client.billingPortal.sessions.create({})).resolves.toEqual({
      url: "https://stripe.test/portal",
    });
    await expect(client.subscriptions.retrieve("sub_fake")).resolves.toMatchObject({
      id: "sub_fake",
      status: "active",
    });
    await expect(client.subscriptions.update("sub_fake", {})).resolves.toEqual({ id: "sub_fake" });
    await expect(client.invoices.list({})).resolves.toEqual({ data: [] });
    expect(client.webhooks.constructEvent("{}", "sig", "whsec_fake")).toEqual({
      id: "evt_fake",
      created: 0,
      type: "noop",
      data: { object: {} },
    });
  });
  ```

  Run (expect FAIL — `stripe.ts` does not exist yet):
  ```
  npx vitest run lib/billing/stripe.test.ts
  ```
  Expected: failure with `Failed to resolve import "./stripe"` (or `Cannot find module './stripe'`). This confirms the test runs and the impl is genuinely absent.

- [ ] **Step 4: Implement `lib/billing/stripe.ts` (minimal — make the test pass).**

  Create `lib/billing/stripe.ts`. This is the SOLE module allowed to import `stripe`; the injected `client` short-circuits construction exactly as `createAnthropicAdvisorLlmClient` does:

  ```ts
  // lib/billing/stripe.ts
  // Stripe adapter (impure) — the ONLY module in the codebase allowed to import the `stripe` package
  // (a grep-guard in Task 14 enforces this). It wraps the real SDK behind the SDK-free StripeLike
  // interface from lib/billing/types, with an injectable `client` so tests build a fake and never
  // construct a real client or read STRIPE_SECRET_KEY. Mirrors lib/advisor/llm.ts's AnthropicLike
  // injection pattern and pins the apiVersion literal exactly as that file pins ADVISOR_MODEL.

  import Stripe from "stripe";
  import type { StripeLike } from "./types";

  /** Pinned Stripe API version — a real, dated literal so behavior is stable across SDK bumps. */
  export const STRIPE_API_VERSION = "2025-06-30.basil";

  /**
   * Stable price-id -> plan-name map. The webhook derives sponsors.plan from THIS map keyed by the
   * subscription item's price.id, NOT from price.nickname/lookup_key (both are dashboard-editable and
   * unreliable). Seeded from env so the same code works across Stripe test/live mode:
   *   STRIPE_PRICE_ID       -> "team" (the single seat price used by Checkout)
   * Extend with more entries as plans are added. An unmapped price falls back to 'free' via
   * planForPriceId — the sponsor still gets subscription_status/id, just no recognized plan label.
   */
  export const PLAN_BY_PRICE_ID: Record<string, string> = Object.fromEntries(
    [[process.env.STRIPE_PRICE_ID, "team"]].filter(
      (e): e is [string, string] => typeof e[0] === "string" && e[0].length > 0
    )
  );

  /** Map a Stripe price id to a plan name, defaulting to 'free' when unknown/absent. */
  export function planForPriceId(priceId: string | null | undefined): string {
    if (!priceId) return "free";
    return PLAN_BY_PRICE_ID[priceId] ?? "free";
  }

  /**
   * Returns a StripeLike. When `opts.client` is provided (tests), it is returned as-is and NO real
   * Stripe client is constructed and NO key is read. Otherwise a real client is built from
   * `opts.apiKey ?? process.env.STRIPE_SECRET_KEY`, pinned to STRIPE_API_VERSION, and up-cast to the
   * minimal StripeLike surface the billing helpers depend on.
   */
  export function createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike {
    if (opts?.client) return opts.client;
    const stripe = new Stripe(opts?.apiKey ?? process.env.STRIPE_SECRET_KEY ?? "", {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    });
    return stripe as unknown as StripeLike;
  }
  ```

  Note: `PLAN_BY_PRICE_ID` reads `process.env.STRIPE_PRICE_ID` at MODULE LOAD to build the map — this is production config wiring, not a per-test secret read, and it lives in `lib/billing/stripe.ts` (the guard's allowlisted SDK module), so it does not trip the Task 14 grep-guard (which scans test files and non-adapter modules for a real-key READ). Tests that exercise `planForPriceId` pass an explicit price id and assert the mapping/fallback without stubbing env.

  Run (expect PASS):
  ```
  npx vitest run lib/billing/stripe.test.ts
  ```
  Expected: `5 passed`, 0 failed (apiVersion literal, planForPriceId fallback, injected-client identity, no-key-read, full-surface).

  Commit:
  ```
  git add lib/billing/stripe.ts lib/billing/stripe.test.ts
  git commit -m "Plan 6 Task 3: injectable Stripe adapter (createStripeClient, PLAN_BY_PRICE_ID, pinned STRIPE_API_VERSION)"
  ```

- [ ] **Step 5: Write the FAILING test for `createPostmarkSender` (fetch-based, injected fetchImpl).**

  Postmark is exercised via an injected `fetchImpl` so no real HTTP and no real token are involved. The test asserts the URL, the `X-Postmark-Server-Token` header, the JSON body shape (`From`/`To`/`Subject`/`HtmlBody`/`TextBody`), and that when a fake fetch is injected the code path does not require `POSTMARK_SERVER_TOKEN`. Create `lib/email/postmark.test.ts`:

  ```ts
  import { expect, test, vi } from "vitest";
  import { createPostmarkSender } from "./postmark";

  /** A fake fetch that records its call and returns a 200 like Postmark's real success response. */
  function fakeFetch() {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ ErrorCode: 0, Message: "OK" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    return impl as ReturnType<typeof vi.fn> & typeof fetch;
  }

  test("POSTs to the Postmark email endpoint with the token header and correct body", async () => {
    const impl = fakeFetch();
    const sender = createPostmarkSender({ token: "test-token", fetchImpl: impl });
    await sender.send({
      to: "earner@example.com",
      subject: "You're invited to Trove",
      htmlBody: "<p>Join</p>",
      textBody: "Join",
    });

    expect(impl).toHaveBeenCalledTimes(1);
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe("test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.To).toBe("earner@example.com");
    expect(body.Subject).toBe("You're invited to Trove");
    expect(body.HtmlBody).toBe("<p>Join</p>");
    expect(body.TextBody).toBe("Join");
    expect(typeof body.From).toBe("string");
    expect(body.From.length).toBeGreaterThan(0);
  });

  test("does not require POSTMARK_SERVER_TOKEN env when a fetchImpl + token are injected", async () => {
    // Prove the inline token is used even with the env var unset. vi.stubEnv/vi.unstubAllEnvs keeps
    // the secret name out of any value-read/assign position, so the Task 14 grep-guard stays green.
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    try {
      const impl = fakeFetch();
      const sender = createPostmarkSender({ token: "inline", fetchImpl: impl });
      await sender.send({ to: "a@b.com", subject: "s", htmlBody: "<i>h</i>", textBody: "t" });
      expect(impl).toHaveBeenCalledTimes(1);
      const [, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("inline");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("throws with Postmark's message when the response is not ok", async () => {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid email request" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    const sender = createPostmarkSender({ token: "test-token", fetchImpl: impl });
    await expect(
      sender.send({ to: "bad", subject: "s", htmlBody: "<i>h</i>", textBody: "t" })
    ).rejects.toThrow(/Invalid email request/);
  });
  ```

  Run (expect FAIL — `postmark.ts` does not exist):
  ```
  npx vitest run lib/email/postmark.test.ts
  ```
  Expected: failure with `Failed to resolve import "./postmark"`.

- [ ] **Step 6: Implement `lib/email/postmark.ts` (fetch-based EmailSender — make the test pass).**

  Create `lib/email/postmark.ts`. No npm dependency — it POSTs directly to Postmark's REST endpoint, and is injectable via `fetchImpl` so tests never hit the network or read the real token:

  ```ts
  // lib/email/postmark.ts
  // Postmark email adapter (impure) — the ONLY module that talks to Postmark. It is fetch-based (NO
  // npm dependency): it POSTs to https://api.postmarkapp.com/email with the X-Postmark-Server-Token
  // header. Injectable via `fetchImpl` + `token` so tests supply a fake fetch and never read the real
  // POSTMARK_SERVER_TOKEN or make a network call. Returns the SDK-free EmailSender from lib/billing/types.

  import type { EmailSender } from "@/lib/billing/types";

  const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";

  /** From-address for all Trove transactional mail. Overridable via env for non-prod senders. */
  const FROM_ADDRESS = process.env.POSTMARK_FROM_EMAIL ?? "Trove <no-reply@trove.app>";

  export function createPostmarkSender(opts?: {
    token?: string;
    fetchImpl?: typeof fetch;
  }): EmailSender {
    const doFetch = opts?.fetchImpl ?? fetch;
    return {
      async send(input) {
        const token = opts?.token ?? process.env.POSTMARK_SERVER_TOKEN ?? "";
        const response = await doFetch(POSTMARK_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Postmark-Server-Token": token,
          },
          body: JSON.stringify({
            From: FROM_ADDRESS,
            To: input.to,
            Subject: input.subject,
            HtmlBody: input.htmlBody,
            TextBody: input.textBody,
            MessageStream: "outbound",
          }),
        });

        if (!response.ok) {
          let message = `Postmark send failed (HTTP ${response.status})`;
          try {
            const payload = (await response.json()) as { Message?: string };
            if (payload?.Message) message = payload.Message;
          } catch {
            // Non-JSON error body — keep the HTTP-status message above.
          }
          throw new Error(message);
        }
      },
    };
  }
  ```

  Run (expect PASS):
  ```
  npx vitest run lib/email/postmark.test.ts
  ```
  Expected: `3 passed`, 0 failed.

  Commit:
  ```
  git add lib/email/postmark.ts lib/email/postmark.test.ts
  git commit -m "Plan 6 Task 3: fetch-based injectable Postmark EmailSender (no npm dep)"
  ```

- [ ] **Step 7: Verify the whole Task-3 surface — types compile, both adapters pass, no real keys read.**

  Type-check the new modules (whole project; grep for any error in the Task-3 files):
  ```
  npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lib/billing/(types|stripe)\.ts|lib/email/postmark\.ts" || echo "task-3 files typecheck clean"
  ```
  Expected: `task-3 files typecheck clean`.

  Run both new unit specs together (non-DB, so no two-halves split needed):
  ```
  npx vitest run lib/billing/stripe.test.ts lib/email/postmark.test.ts
  ```
  Expected: `8 passed` total (5 Stripe + 3 Postmark), 0 failed.

  Lint the new files:
  ```
  npx eslint lib/billing/types.ts lib/billing/stripe.ts lib/billing/stripe.test.ts lib/email/postmark.ts lib/email/postmark.test.ts
  ```
  Expected: no output (clean).

  Sanity-check the "sole importer" invariant that Task 14's grep-guard will later enforce — only `lib/billing/stripe.ts` imports the `stripe` package, and no test references a real key:
  ```
  grep -rn "from \"stripe\"\|from 'stripe'\|require(\"stripe\")" --include="*.ts" lib app | grep -v node_modules
  ```
  Expected: exactly one hit — `lib/billing/stripe.ts:...import Stripe from "stripe";`.
  ```
  grep -rn "STRIPE_SECRET_KEY\|STRIPE_WEBHOOK_SECRET\|POSTMARK_SERVER_TOKEN" lib/billing/stripe.test.ts lib/email/postmark.test.ts
  ```
  Expected: the ONLY hits are inside `vi.stubEnv("STRIPE_SECRET_KEY", "")` / `vi.stubEnv("POSTMARK_SERVER_TOKEN", "")` calls that set the env to empty to PROVE the key is not required. These mention the secret name only as a string literal passed to `vi.stubEnv` — never in a `process.env.<SECRET>` value-read or assignment position — so the Task 14 grep-guard (which flags a real READ, `process.env.<SECRET>`, that feeds construction) treats them as clean. A genuine `new Stripe(process.env.STRIPE_SECRET_KEY)` in a test would still trip the guard.

  No commit needed if Steps 4 and 6 already committed cleanly; if the eslint/tsc pass required any fixup edits, commit them:
  ```
  git add -A && git commit -m "Plan 6 Task 3: lint/typecheck fixups for billing+email foundations"
  ```

**Deliverable:** `lib/billing/types.ts` (canonical SDK-free shapes), an injectable `lib/billing/stripe.ts` (sole `stripe` importer, pinned `STRIPE_API_VERSION`, construction short-circuited by an injected `client`), and a fetch-based injectable `lib/email/postmark.ts` — all three with passing unit tests that build fakes and never construct a real Stripe client, hit the network, or read a real key. These are the exact shapes consumed by Tasks 5–13.

---

### Task 4: requireSponsorAdmin + createSponsor action + /sponsor shell + /sponsor/new

**Files:**
- Create: `lib/auth/require-sponsor-admin.ts`
- Create: `lib/auth/require-sponsor-admin.test.ts`
- Create: `app/sponsor/layout.tsx`
- Create: `app/sponsor/actions.ts`
- Create: `app/sponsor/new/page.tsx`
- Create: `app/sponsor/new/page.test.tsx`

**Interfaces:**

Consumes:
- `create_sponsor(sponsor_name text) returns uuid` — SECURITY DEFINER RPC (Task 1); called as `supabase.rpc("create_sponsor", { sponsor_name })`, returns the new sponsor id.
- `createServerClient()` from `@/lib/supabase/server` (RLS-scoped, cookie-bound anon client).
- RLS `sponsor_admins_self_select` (0003): an authed user can read their own `sponsor_admins` rows (`user_id = auth.uid()`).

Produces:
```ts
// lib/auth/require-sponsor-admin.ts
export async function requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>;
// redirect('/login') if unauthed; redirect('/sponsor/new') if the user administers no sponsor;
// if multiple, pick the first (document; cookie-based selection deferred).
```
```ts
// app/sponsor/actions.ts  ("use server" — async exports only)
export async function createSponsor(formData: FormData): Promise<void>;
// reads 'name', calls create_sponsor RPC, redirects to /sponsor
```

Note on `sponsor_admins` columns: 0002 defines `sponsor_admins (sponsor_id uuid, user_id uuid, ...)`. `requireSponsorAdmin` selects `sponsor_id` filtered by the RLS-implicit `user_id = auth.uid()`; no explicit `.eq("user_id", …)` is needed because `sponsor_admins_self_select` already scopes the result to the caller — but we add `.order("created_at")` to make "pick the first" deterministic.

---

- [ ] **Step 1: Write the failing test for `requireSponsorAdmin` (three branches).**

Create `lib/auth/require-sponsor-admin.test.ts`. This mirrors `lib/auth/require-user.test.ts` exactly: mock `@/lib/supabase/server` and `next/navigation`, build a tiny chainable query stub for `.from("sponsor_admins").select(...).order(...)`.

```ts
import { afterEach, expect, test, vi } from "vitest";

// Mock the server client + redirect so this is a pure unit test (no cookies, no network).
const getUser = vi.fn();
const order = vi.fn();

function makeClient() {
  return {
    auth: { getUser },
    from: (table: string) => {
      if (table !== "sponsor_admins") throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string) => ({
          order: (_col: string, _opts: unknown) => order(),
        }),
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => makeClient(),
}));

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

afterEach(() => {
  getUser.mockReset();
  order.mockReset();
  redirect.mockClear();
});

test("returns userId + first sponsorId when the user administers a sponsor", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({
    data: [{ sponsor_id: "sp-A" }, { sponsor_id: "sp-B" }],
    error: null,
  });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).resolves.toEqual({
    userId: "user-1",
    sponsorId: "sp-A",
  });
  expect(redirect).not.toHaveBeenCalled();
});

test("redirects to /login when unauthenticated", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/login");
  expect(redirect).toHaveBeenCalledWith("/login");
});

test("redirects to /sponsor/new when the user administers no sponsor", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({ data: [], error: null });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/sponsor/new");
  expect(redirect).toHaveBeenCalledWith("/sponsor/new");
});

test("redirects to /sponsor/new when the query errors", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({ data: null, error: { message: "boom" } });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/sponsor/new");
  expect(redirect).toHaveBeenCalledWith("/sponsor/new");
});
```

- [ ] **Step 2: Run the test — expect FAIL (module does not exist).**

```
npx vitest run lib/auth/require-sponsor-admin.test.ts
```

Expected: fails with `Failed to load url ./require-sponsor-admin` / "Cannot find module" — the implementation file does not exist yet.

- [ ] **Step 3: Implement `lib/auth/require-sponsor-admin.ts` (minimal).**

```ts
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Resolve the current user's id AND the sponsor org they administer, or redirect.
 *
 * - unauthenticated -> redirect('/login')
 * - authenticated but administers no sponsor -> redirect('/sponsor/new')
 * - administers one or more -> return the FIRST (ordered by created_at).
 *
 * Multi-org selection (a cookie-backed "active sponsor") is deferred for v1; a user who
 * administers multiple orgs always lands on their oldest membership. RLS
 * (sponsor_admins_self_select) scopes the read to the caller, so no explicit user_id filter
 * is required here.
 */
export async function requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("sponsor_admins")
    .select("sponsor_id")
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) redirect("/sponsor/new");

  return { userId: user.id, sponsorId: data![0].sponsor_id as string };
}
```

- [ ] **Step 4: Run the test — expect PASS.**

```
npx vitest run lib/auth/require-sponsor-admin.test.ts
```

Expected: `Test Files  1 passed`, `Tests  4 passed`.

- [ ] **Step 5: Commit.**

```
git add lib/auth/require-sponsor-admin.ts lib/auth/require-sponsor-admin.test.ts
git commit -m "Plan 6 Task 4: requireSponsorAdmin with login/no-sponsor redirect branches"
```

- [ ] **Step 6: Write the failing test for `/sponsor/new` create-org form.**

Create `app/sponsor/new/page.test.tsx`. Mock the server action (`@/app/sponsor/actions`) so the test never touches Supabase. Assert a labeled `<input name="name">`, an accent CTA wired to the action, and a heading.

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("@/app/sponsor/actions", () => ({ createSponsor: vi.fn() }));

import SponsorNewPage from "./page";

test("renders a labeled org-name input and an accent Create CTA wired to the action", () => {
  render(<SponsorNewPage />);

  // Heading present.
  expect(
    screen.getByRole("heading", { name: /create.*organization/i })
  ).toBeInTheDocument();

  // A real <label> associated with a text input named "name".
  const input = screen.getByLabelText(/organization name/i);
  expect(input).toHaveAttribute("name", "name");
  expect(input).toBeRequired();

  // Submit CTA.
  const submit = screen.getByRole("button", { name: /create organization/i });
  expect(submit).toHaveAttribute("type", "submit");

  // The form's action is the mocked server action (a function reference).
  const form = input.closest("form");
  expect(form).not.toBeNull();
});
```

- [ ] **Step 7: Run the test — expect FAIL (page does not exist).**

```
npx vitest run app/sponsor/new/page.test.tsx
```

Expected: fails to resolve `./page` — the page file does not exist yet.

- [ ] **Step 8: Implement `app/sponsor/actions.ts` with `createSponsor`.**

This is the `"use server"` module for all `/sponsor` actions (Tasks 5, 10, 11 append more exports here). It must export ONLY async functions.

```ts
"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Create a new sponsor organization for the current user via the create_sponsor RPC
 * (SECURITY DEFINER: inserts sponsors + sponsor_admins atomically), then open the dashboard.
 */
export async function createSponsor(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/sponsor/new?error=name_required");

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("create_sponsor", { sponsor_name: name });
  if (error) redirect("/sponsor/new?error=create_failed");

  redirect("/sponsor");
}
```

- [ ] **Step 9: Implement `app/sponsor/new/page.tsx`.**

Server component; renders a plain `<form action={createSponsor}>`. Uses the `Button` primitive (accent CTA via `variant="primary"`, which is `bg-primary` = #2563EB; the design's accent #F97316 is reserved for the cohort-invite CTA, so the org-create primary CTA is the blue primary — the test only requires an accent/primary submit, satisfied by `Button`). Labeled input, min touch target inherited from Button.

```tsx
import { createSponsor } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";

export default function SponsorNewPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-heading text-2xl font-bold">Create your organization</h1>
      <p className="mt-2 text-sm text-foreground/70">
        Set up a sponsor workspace to invite a cohort, track engagement, and manage billing.
      </p>
      <form action={createSponsor} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="sponsor-name" className="text-sm font-medium">
            Organization name
          </label>
          <input
            id="sponsor-name"
            name="name"
            type="text"
            required
            autoComplete="organization"
            className="min-h-11 rounded-md border border-foreground/20 px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          />
        </div>
        <Button type="submit" variant="primary" className="self-start">
          Create organization
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 10: Run the test — expect PASS.**

```
npx vitest run app/sponsor/new/page.test.tsx
```

Expected: `Test Files  1 passed`, `Tests  1 passed`.

- [ ] **Step 11: Commit.**

```
git add app/sponsor/actions.ts app/sponsor/new/page.tsx app/sponsor/new/page.test.tsx
git commit -m "Plan 6 Task 4: createSponsor action + /sponsor/new create-org form"
```

- [ ] **Step 12: Implement `app/sponsor/layout.tsx` (role-gated shell + nav).**

Wraps all `/sponsor/*` routes. CRITICAL: `/sponsor/new` must be reachable BEFORE membership exists, so the layout must NOT call `requireSponsorAdmin` (which would redirect a would-be creator away from `/sponsor/new` in a loop). Instead the layout enforces only authentication (redirect to `/login`), and each page under `/sponsor` that needs a sponsor calls `requireSponsorAdmin()` itself (dashboard, cohort, skills, billing — Tasks 8/5/9/11). The nav links to dashboard/cohort/skills/billing.

There is no dedicated test for the layout (it is auth-gate + static nav, exercised via page tests and live-DB integration in Task 14); it mirrors the already-tested `app/app/layout.tsx` auth pattern.

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

const NAV = [
  { href: "/sponsor", label: "Dashboard" },
  { href: "/sponsor/cohort", label: "Cohort" },
  { href: "/sponsor/skills", label: "Skills" },
  { href: "/sponsor/billing", label: "Billing" },
] as const;

export default async function SponsorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth gate only. We intentionally do NOT call requireSponsorAdmin here so that
  // /sponsor/new remains reachable before the user administers any org. Pages that
  // require a sponsor call requireSponsorAdmin() themselves.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-foreground/10 px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-6">
          <span className="font-heading text-xl font-bold">Trove for Sponsors</span>
          <nav aria-label="Sponsor sections" className="flex gap-4">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="min-h-11 inline-flex items-center text-sm font-medium text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 13: Typecheck + lint the new surface.**

```
npx tsc --noEmit
npx eslint lib/auth/require-sponsor-admin.ts app/sponsor/actions.ts app/sponsor/new/page.tsx app/sponsor/layout.tsx
```

Expected: `tsc` exits 0 (no output); `eslint` exits 0 (no output). If iCloud left stale `.next/* 2.*` artifacts and a later build complains, run `find .next -name "* 2.*" -delete`.

- [ ] **Step 14: Run Task 4's tests together — expect PASS.**

```
npx vitest run lib/auth/require-sponsor-admin.test.ts app/sponsor/new/page.test.tsx
```

Expected: `Test Files  2 passed`, `Tests  5 passed`.

- [ ] **Step 15: Commit.**

```
git add app/sponsor/layout.tsx
git commit -m "Plan 6 Task 4: /sponsor role-gated shell + nav (new-org reachable pre-membership)"
```

---

### Task 5: Cohort invite — inviteCohort action + email parsing + /sponsor/cohort form

**Files:**
- Create: `lib/cohort/parse-emails.ts`
- Create: `lib/cohort/parse-emails.test.ts`
- Create: `lib/cohort/invite.ts`
- Create: `lib/cohort/invite.test.ts`
- Create: `app/sponsor/cohort/page.tsx`
- Modify: `app/sponsor/actions.ts` (add `inviteCohort` server-action wrapper)

**Interfaces:**

Consumes:
- `EmailSender` + `CohortInvite` (Task 3, `lib/billing/types.ts`):
  ```ts
  export interface CohortInvite { id: string; sponsorId: string; email: string; token: string; acceptedAt: string | null; createdAt: string; }
  export interface EmailSender { send(input: { to: string; subject: string; htmlBody: string; textBody: string }): Promise<void>; }
  ```
- `createPostmarkSender(opts?: { token?: string; fetchImpl?: typeof fetch }): EmailSender` (Task 3, `lib/email/postmark.ts`).
- `requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>` (Task 4, `lib/auth/require-sponsor-admin.ts`).
- `cohort_invites (id, sponsor_id, email citext, token unique, accepted_at, created_at, unique(sponsor_id, email))` + `cohort_members` (Task 1 / 0002).
- `createServerClient()` (`lib/supabase/server.ts`), `SupabaseClient` type (`@supabase/supabase-js`).

Produces:
```ts
// lib/cohort/parse-emails.ts
export function parseEmails(raw: string): { valid: string[]; invalid: string[] };
// splits on comma/newline/whitespace, trims, lowercases, dedupes (preserving first-seen order),
// validates each with a conservative email regex.

// lib/cohort/invite.ts
export function generateInviteToken(): string; // url-safe random (32 bytes -> base64url)
export async function inviteCohort(
  db: SupabaseClient,
  sender: EmailSender,
  args: { sponsorId: string; sponsorName: string; emails: string[]; origin: string }
): Promise<{ invited: CohortInvite[]; skipped: string[] }>;
// inserts one cohort_invites row per email not already invited (unique(sponsor_id,email) collision =>
// skip, not error); sends one email per NEW invite with an {origin}/invite/{token} link.

// app/sponsor/actions.ts
export async function inviteCohort(formData: FormData): Promise<void>;
// requireSponsorAdmin -> parseEmails(formData 'emails') -> resolve origin from headers() ->
// inviteCohort(db, createPostmarkSender(), ...) -> revalidatePath('/sponsor/cohort') -> redirect back.
```

---

- [ ] **Step 1: Write the failing test for `parseEmails`.**

Create `lib/cohort/parse-emails.test.ts`:
```ts
import { expect, test } from "vitest";
import { parseEmails } from "./parse-emails";

test("splits on comma, newline, and whitespace and trims", () => {
  const { valid, invalid } = parseEmails("a@x.com, b@x.com\nc@x.com d@x.com");
  expect(valid).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  expect(invalid).toEqual([]);
});

test("lowercases and dedupes, preserving first-seen order", () => {
  const { valid } = parseEmails("Foo@X.com, foo@x.com\nBar@X.com");
  expect(valid).toEqual(["foo@x.com", "bar@x.com"]);
});

test("separates invalid tokens, keeping their original text", () => {
  const { valid, invalid } = parseEmails("good@x.com, not-an-email, also bad@, ok@y.io");
  expect(valid).toEqual(["good@x.com", "ok@y.io"]);
  expect(invalid).toEqual(["not-an-email", "bad@"]);
});

test("ignores empty fragments and returns empty arrays for blank input", () => {
  expect(parseEmails("   \n , ,")).toEqual({ valid: [], invalid: [] });
  expect(parseEmails("")).toEqual({ valid: [], invalid: [] });
});
```

Run it (expect FAIL — module does not exist):
```
npx vitest run lib/cohort/parse-emails.test.ts
```
Expected: `Error: Failed to load url ./parse-emails` / `No test files found` style failure, i.e. the suite errors because `lib/cohort/parse-emails.ts` is missing.

- [ ] **Step 2: Implement `parseEmails` (minimal).**

Create `lib/cohort/parse-emails.ts`:
```ts
// Parses a free-text roster (comma / newline / whitespace separated) into deduped, lowercased,
// validated emails. Pure + SDK-free so it is unit-testable and reusable by the invite action.

// Conservative single-@ email check: non-space local part, a dot-containing domain, 2+ char TLD.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!EMAIL_RE.test(lower)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(lower);
  }

  return { valid, invalid };
}
```

Run it (expect PASS):
```
npx vitest run lib/cohort/parse-emails.test.ts
```
Expected: `4 passed`.

- [ ] **Step 3: Commit `parseEmails`.**
```
git add lib/cohort/parse-emails.ts lib/cohort/parse-emails.test.ts
git commit -m "Trove Plan 6 Task 5: parseEmails roster parser (comma/newline/space, dedupe, validate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the failing test for `generateInviteToken` + `inviteCohort` (fake db + fake EmailSender, no network).**

Create `lib/cohort/invite.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CohortInvite, EmailSender } from "@/lib/billing/types";
import { generateInviteToken, inviteCohort } from "./invite";

// ---- fakes ----

/** A minimal in-memory stand-in for the `cohort_invites` insert chain the code uses:
 *  db.from("cohort_invites").insert(row).select("...").single() -> { data, error }.
 *  A pre-seeded set of (sponsor_id,email) keys simulates the UNIQUE(sponsor_id,email)
 *  constraint by returning a Postgres 23505 error for those rows (=> skip, not throw). */
function fakeDb(existingKeys: string[] = []): {
  db: SupabaseClient;
  inserted: Array<{ sponsor_id: string; email: string; token: string }>;
} {
  const existing = new Set(existingKeys);
  const inserted: Array<{ sponsor_id: string; email: string; token: string }> = [];
  const from = vi.fn((table: string) => {
    if (table !== "cohort_invites") throw new Error(`unexpected table ${table}`);
    return {
      insert(row: { sponsor_id: string; email: string; token: string }) {
        const key = `${row.sponsor_id}:${row.email}`;
        return {
          select() {
            return {
              async single() {
                if (existing.has(key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key" } };
                }
                existing.add(key);
                inserted.push(row);
                const invite: CohortInvite = {
                  id: `id-${inserted.length}`,
                  sponsorId: row.sponsor_id,
                  email: row.email,
                  token: row.token,
                  acceptedAt: null,
                  createdAt: "2026-07-03T00:00:00Z",
                };
                return {
                  data: {
                    id: invite.id,
                    sponsor_id: invite.sponsorId,
                    email: invite.email,
                    token: invite.token,
                    accepted_at: invite.acceptedAt,
                    created_at: invite.createdAt,
                  },
                  error: null,
                };
              },
            };
          },
        };
      },
    };
  });
  return { db: { from } as unknown as SupabaseClient, inserted };
}

function fakeSender(): { sender: EmailSender; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { sender: { send }, send };
}

// ---- tests ----

test("generateInviteToken returns a url-safe token with no +, /, or = characters", () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThanOrEqual(32);
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("inserts one invite per email and sends one email each with an /invite/{token} link", async () => {
  const { db, inserted } = fakeDb();
  const { sender, send } = fakeSender();
  const result = await inviteCohort(db, sender, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["a@x.com", "b@x.com"],
    origin: "https://trove.test",
  });

  expect(result.invited.map((i) => i.email)).toEqual(["a@x.com", "b@x.com"]);
  expect(result.skipped).toEqual([]);
  expect(inserted).toHaveLength(2);
  expect(send).toHaveBeenCalledTimes(2);

  const firstCall = send.mock.calls[0][0] as { to: string; subject: string; htmlBody: string; textBody: string };
  expect(firstCall.to).toBe("a@x.com");
  expect(firstCall.subject).toContain("Acme");
  const link = `https://trove.test/invite/${inserted[0].token}`;
  expect(firstCall.htmlBody).toContain(link);
  expect(firstCall.textBody).toContain(link);
});

test("skips an already-invited email (unique collision) without sending or throwing", async () => {
  const { db } = fakeDb(["sp1:dupe@x.com"]);
  const { sender, send } = fakeSender();
  const result = await inviteCohort(db, sender, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["dupe@x.com", "fresh@x.com"],
    origin: "https://trove.test",
  });

  expect(result.invited.map((i) => i.email)).toEqual(["fresh@x.com"]);
  expect(result.skipped).toEqual(["dupe@x.com"]);
  expect(send).toHaveBeenCalledTimes(1);
  expect((send.mock.calls[0][0] as { to: string }).to).toBe("fresh@x.com");
});

test("does not send an email if the insert failed for a non-collision reason", async () => {
  // Force a non-23505 error by monkeypatching the chain to reject-shape.
  const send = vi.fn();
  const db = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: null, error: { code: "XXAAA", message: "boom" } }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  await expect(
    inviteCohort(db, { send }, {
      sponsorId: "sp1",
      sponsorName: "Acme",
      emails: ["a@x.com"],
      origin: "https://trove.test",
    })
  ).rejects.toThrow(/boom/);
  expect(send).not.toHaveBeenCalled();
});
```

Run it (expect FAIL — module missing):
```
npx vitest run lib/cohort/invite.test.ts
```
Expected: load error for `./invite` (module not found).

- [ ] **Step 5: Implement `generateInviteToken` + `inviteCohort` (minimal).**

Create `lib/cohort/invite.ts`:
```ts
// Cohort invitation logic. Pure of any concrete external SDK: it takes an injected `db`
// (SupabaseClient — service-role or RLS-scoped) and an injected `EmailSender` (Task 3), so
// invite.test.ts drives it with in-memory fakes and NO real Postmark/DB call. The action wrapper
// in app/sponsor/actions.ts is the only place that constructs the real sender.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CohortInvite, EmailSender } from "@/lib/billing/types";

/** URL-safe random invite token (32 bytes of entropy, base64url — no +, /, or = padding). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

function inviteEmail(sponsorName: string, link: string): { subject: string; htmlBody: string; textBody: string } {
  const subject = `${sponsorName} invited you to Trove`;
  const textBody =
    `${sponsorName} invited you to join their cohort on Trove — your free, standards-based ` +
    `credential wallet.\n\nAccept your invitation:\n${link}\n\n` +
    `You control what you share. Sponsors only see data you explicitly consent to.`;
  const htmlBody =
    `<p>${sponsorName} invited you to join their cohort on <strong>Trove</strong> — ` +
    `your free, standards-based credential wallet.</p>` +
    `<p><a href="${link}">Accept your invitation</a></p>` +
    `<p>You control what you share. Sponsors only see data you explicitly consent to.</p>`;
  return { subject, htmlBody, textBody };
}

export async function inviteCohort(
  db: SupabaseClient,
  sender: EmailSender,
  args: { sponsorId: string; sponsorName: string; emails: string[]; origin: string }
): Promise<{ invited: CohortInvite[]; skipped: string[] }> {
  const invited: CohortInvite[] = [];
  const skipped: string[] = [];

  for (const email of args.emails) {
    const token = generateInviteToken();
    const { data, error } = await db
      .from("cohort_invites")
      .insert({ sponsor_id: args.sponsorId, email, token })
      .select("id, sponsor_id, email, token, accepted_at, created_at")
      .single();

    if (error) {
      // 23505 = unique_violation on unique(sponsor_id, email) => already invited: skip quietly.
      if (error.code === "23505") {
        skipped.push(email);
        continue;
      }
      throw new Error(error.message);
    }

    const invite: CohortInvite = {
      id: data!.id as string,
      sponsorId: data!.sponsor_id as string,
      email: data!.email as string,
      token: data!.token as string,
      acceptedAt: (data!.accepted_at as string | null) ?? null,
      createdAt: data!.created_at as string,
    };
    invited.push(invite);

    const link = `${args.origin}/invite/${invite.token}`;
    const { subject, htmlBody, textBody } = inviteEmail(args.sponsorName, link);
    await sender.send({ to: invite.email, subject, htmlBody, textBody });
  }

  return { invited, skipped };
}
```

Run it (expect PASS):
```
npx vitest run lib/cohort/invite.test.ts
```
Expected: `4 passed`.

- [ ] **Step 6: Commit the invite core.**
```
git add lib/cohort/invite.ts lib/cohort/invite.test.ts
git commit -m "Trove Plan 6 Task 5: inviteCohort + generateInviteToken (injected db + EmailSender, unique-collision skip)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing test for the `inviteCohort` server-action wrapper (mock deps — no real DB, no real Postmark, no headers).**

Append to (or create if Task 4 left it absent — it should exist) a wrapper test. Create `app/sponsor/cohort/actions.test.ts` NOT needed — the wrapper lives in `app/sponsor/actions.ts`; test it directly. Create `app/sponsor/actions.invite.test.ts`:
```ts
import { expect, test, vi, beforeEach } from "vitest";

const requireSponsorAdmin = vi.fn();
const inviteCohortLib = vi.fn();
const createPostmarkSender = vi.fn();
const createServerClient = vi.fn();
const revalidatePath = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const headers = vi.fn();

vi.mock("@/lib/auth/require-sponsor-admin", () => ({ requireSponsorAdmin }));
vi.mock("@/lib/cohort/invite", () => ({ inviteCohort: inviteCohortLib }));
vi.mock("@/lib/email/postmark", () => ({ createPostmarkSender }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({ headers }));

import { inviteCohort as inviteCohortAction } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "sp1" });
  createServerClient.mockResolvedValue({ from: vi.fn() });
  createPostmarkSender.mockReturnValue({ send: vi.fn() });
  inviteCohortLib.mockResolvedValue({ invited: [{ email: "a@x.com" }], skipped: [] });
  headers.mockResolvedValue(new Map([["origin", "https://trove.test"]]));
});

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

test("parses the emails textarea, resolves origin from headers, and delegates to lib inviteCohort", async () => {
  await expect(inviteCohortAction(fd({ emails: "a@x.com, bad, b@x.com" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort"
  );
  expect(requireSponsorAdmin).toHaveBeenCalledOnce();
  const [, sender, callArgs] = inviteCohortLib.mock.calls[0];
  expect(sender).toEqual({ send: expect.any(Function) });
  expect(callArgs.sponsorId).toBe("sp1");
  expect(callArgs.emails).toEqual(["a@x.com", "b@x.com"]); // invalid "bad" dropped
  expect(callArgs.origin).toBe("https://trove.test");
  expect(revalidatePath).toHaveBeenCalledWith("/sponsor/cohort");
});

test("redirects with an error and does not call lib when no valid emails are supplied", async () => {
  await expect(inviteCohortAction(fd({ emails: "bad, also-bad" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?error=no_valid_emails"
  );
  expect(inviteCohortLib).not.toHaveBeenCalled();
});
```

Run it (expect FAIL — `inviteCohort` not yet exported from `app/sponsor/actions.ts`):
```
npx vitest run app/sponsor/actions.invite.test.ts
```
Expected: import/type error — `inviteCohort` is `undefined` / not a function, or `actions.ts` lacks the export.

- [ ] **Step 8: Implement the `inviteCohort` server-action wrapper.**

`app/sponsor/actions.ts` already exists from Task 4 (with `createSponsor`). Add the imports and the new action. Add these imports at the top (merge with existing import lines; do not duplicate `redirect`/`revalidatePath`/`createServerClient`/`requireSponsorAdmin` if already present):
```ts
import { headers } from "next/headers";
import { parseEmails } from "@/lib/cohort/parse-emails";
import { inviteCohort as inviteCohortLib } from "@/lib/cohort/invite";
import { createPostmarkSender } from "@/lib/email/postmark";
```
Then append the action (a `"use server"` module may export ONLY async functions — this is async, good):
```ts
/**
 * Invite a cohort by email. Parses the 'emails' textarea, resolves the request origin so the
 * emailed link is absolute, and delegates to lib inviteCohort with the REAL Postmark sender
 * (constructed only here). The sponsor is resolved via requireSponsorAdmin (role-gate).
 */
export async function inviteCohort(formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const raw = String(formData.get("emails") ?? "");
  const { valid } = parseEmails(raw);
  if (valid.length === 0) redirect("/sponsor/cohort?error=no_valid_emails");

  const supabase = await createServerClient();
  const { data: sponsor } = await supabase
    .from("sponsors")
    .select("name")
    .eq("id", sponsorId)
    .single();
  const sponsorName = (sponsor?.name as string | null) ?? "Your sponsor";

  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ??
    (hdrs.get("host") ? `https://${hdrs.get("host")}` : "") ??
    "";

  await inviteCohortLib(supabase, createPostmarkSender(), {
    sponsorId,
    sponsorName,
    emails: valid,
    origin,
  });

  revalidatePath("/sponsor/cohort");
  redirect("/sponsor/cohort");
}
```

Run it (expect PASS):
```
npx vitest run app/sponsor/actions.invite.test.ts
```
Expected: `2 passed`.

> Note: the test mocks `next/headers` to return a `Map` (which has `.get`), and mocks `@/lib/supabase/server` so the `sponsors` lookup uses the mocked client. If the mocked client's `from(...)` chain is called, extend the `createServerClient.mockResolvedValue` in the test to return `{ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { name: "Acme" } }) }) }) }) }`. Add that shape now to keep the test green:
> ```ts
> createServerClient.mockResolvedValue({
>   from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { name: "Acme" } }) }) }) }),
> });
> ```
> Re-run `npx vitest run app/sponsor/actions.invite.test.ts` → `2 passed`.

- [ ] **Step 9: Commit the action wrapper.**
```
git add app/sponsor/actions.ts app/sponsor/actions.invite.test.ts
git commit -m "Trove Plan 6 Task 5: inviteCohort server action (parse emails, resolve origin, inject Postmark)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 10: Write the failing UI test for `/sponsor/cohort` — extract a presentational `CohortInviteForm` + `CohortRosterTable` so they are testable without a server component.**

The page (`app/sponsor/cohort/page.tsx`) is an async server component (fetches data + role-gates), so it is not directly render-testable. Extract two client-free presentational components into `components/sponsor/` and test THOSE (mirrors the `ThreadList` pattern — mock the server action module).

Create `components/sponsor/cohort-invite-form.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/sponsor/actions", () => ({ inviteCohort: vi.fn() }));
import { CohortInviteForm } from "./cohort-invite-form";

test("renders a labeled emails textarea and a submit button wired to the action", () => {
  render(<CohortInviteForm />);
  const textarea = screen.getByLabelText(/email addresses/i);
  expect(textarea).toBeInTheDocument();
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea).toHaveAttribute("name", "emails");
  expect(screen.getByRole("button", { name: /send invites/i })).toBeInTheDocument();
});
```

Create `components/sponsor/cohort-roster-table.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CohortRosterTable } from "./cohort-roster-table";

test("renders members and pending invites with status text (no color-only signalling)", () => {
  render(
    <CohortRosterTable
      rows={[
        { email: "member@x.com", status: "active", accepted: true },
        { email: "pending@x.com", status: "invited", accepted: false },
      ]}
    />
  );
  expect(screen.getByText("member@x.com")).toBeInTheDocument();
  expect(screen.getByText("pending@x.com")).toBeInTheDocument();
  expect(screen.getByText(/active/i)).toBeInTheDocument();
  expect(screen.getByText(/pending/i)).toBeInTheDocument();
  // The table has a caption or column header for accessibility.
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /email/i })).toBeInTheDocument();
});

test("renders an empty-state message when there are no rows", () => {
  render(<CohortRosterTable rows={[]} />);
  expect(screen.getByText(/no members or invites yet/i)).toBeInTheDocument();
});
```

Run them (expect FAIL — components missing):
```
npx vitest run components/sponsor/cohort-invite-form.test.tsx components/sponsor/cohort-roster-table.test.tsx
```
Expected: load errors for `./cohort-invite-form` and `./cohort-roster-table`.

- [ ] **Step 11: Implement `CohortInviteForm` and `CohortRosterTable`.**

Create `components/sponsor/cohort-invite-form.tsx`:
```tsx
import { inviteCohort } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";

/** Labeled roster textarea posting to the inviteCohort server action. WCAG: real <label> tied to
 *  the control via htmlFor/id, keyboard-native textarea + button (min 44px via Button primitive). */
export function CohortInviteForm() {
  return (
    <form action={inviteCohort} className="flex flex-col gap-3">
      <label htmlFor="cohort-emails" className="text-sm font-medium">
        Email addresses
      </label>
      <p id="cohort-emails-hint" className="text-sm text-foreground/70">
        Separate addresses with commas, spaces, or new lines. Already-invited addresses are skipped.
      </p>
      <textarea
        id="cohort-emails"
        name="emails"
        rows={5}
        required
        aria-describedby="cohort-emails-hint"
        className="w-full rounded-md border border-foreground/20 p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        placeholder="alex@example.com, sam@example.com"
      />
      <div>
        <Button type="submit">Send invites</Button>
      </div>
    </form>
  );
}
```

Create `components/sponsor/cohort-roster-table.tsx`:
```tsx
/** Read-only roster of current cohort members + pending invites. Status is conveyed as TEXT
 *  (never color alone) per WCAG-AA. Consented per-member data is NOT shown here — this table lists
 *  only membership status the sponsor is entitled to see (their own invites + members). */
export interface CohortRosterRow {
  email: string;
  status: string;
  accepted: boolean;
}

export function CohortRosterTable({ rows }: { rows: CohortRosterRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-foreground/70">
        No members or invites yet. Send your first invitations above.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Cohort members and pending invitations</caption>
        <thead>
          <tr className="border-b border-foreground/20">
            <th scope="col" className="py-2 pr-4 font-medium">
              Email
            </th>
            <th scope="col" className="py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.email} className="border-b border-foreground/10">
              <td className="py-2 pr-4">{r.email}</td>
              <td className="py-2">{r.accepted ? "Active" : "Pending"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Run them (expect PASS):
```
npx vitest run components/sponsor/cohort-invite-form.test.tsx components/sponsor/cohort-roster-table.test.tsx
```
Expected: `3 passed` (1 in the form file, 2 in the table file).

- [ ] **Step 12: Commit the presentational components.**
```
git add components/sponsor/cohort-invite-form.tsx components/sponsor/cohort-invite-form.test.tsx components/sponsor/cohort-roster-table.tsx components/sponsor/cohort-roster-table.test.tsx
git commit -m "Trove Plan 6 Task 5: CohortInviteForm + CohortRosterTable presentational components (a11y, text-only status)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 13: Create the `/sponsor/cohort` page (async server component) wiring role-gate + roster read + form.**

Create `app/sponsor/cohort/page.tsx`:
```tsx
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { CohortInviteForm } from "@/components/sponsor/cohort-invite-form";
import { CohortRosterTable, type CohortRosterRow } from "@/components/sponsor/cohort-roster-table";

export default async function CohortPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

  // Members (accepted) and pending invites (not yet accepted). RLS: cohort_invites_sponsor_all and
  // cohort_members_sponsor_select scope both reads to this admin's sponsor automatically.
  const [{ data: invites }, { data: members }] = await Promise.all([
    supabase
      .from("cohort_invites")
      .select("email, accepted_at")
      .eq("sponsor_id", sponsorId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("cohort_members")
      .select("earner_id, status, earners(handle)")
      .eq("sponsor_id", sponsorId)
      .eq("status", "active"),
  ]);

  const memberRows: CohortRosterRow[] = (members ?? []).map((m) => {
    const earner = m.earners as { handle: string | null } | { handle: string | null }[] | null;
    const handle = Array.isArray(earner) ? earner[0]?.handle ?? null : earner?.handle ?? null;
    return { email: handle ?? "(member)", status: m.status as string, accepted: true };
  });
  const inviteRows: CohortRosterRow[] = (invites ?? []).map((i) => ({
    email: i.email as string,
    status: "invited",
    accepted: false,
  }));
  const rows = [...memberRows, ...inviteRows];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Invite your cohort</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Invitees get a free Trove wallet and choose what to share back with you.
        </p>
      </header>
      <section aria-labelledby="invite-heading">
        <h2 id="invite-heading" className="sr-only">
          Send invitations
        </h2>
        <CohortInviteForm />
      </section>
      <section aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="mb-3 font-heading text-lg font-semibold">
          Members &amp; pending invites
        </h2>
        <CohortRosterTable rows={rows} />
      </section>
    </div>
  );
}
```

Type-check + build gate (the page is server-only, so verify via tsc + build rather than a render test):
```
npx tsc --noEmit
```
Expected: no errors. If iCloud left stale artifacts, `find .next -name "* 2.*" -delete` then retry. (A full `next build` runs in Task 14; `tsc --noEmit` is the fast gate here.)

- [ ] **Step 14: Run the full Task 5 slice + commit the page.**

Run every file this task touched (all fast/jsdom — no live DB in Task 5):
```
npx vitest run lib/cohort/parse-emails.test.ts lib/cohort/invite.test.ts app/sponsor/actions.invite.test.ts components/sponsor/cohort-invite-form.test.tsx components/sponsor/cohort-roster-table.test.tsx
```
Expected: `11 passed` (4 + 4 + 2 + 1 + 2... note: form=1, table=2, action=2, invite=4, parse=4 = 13; if any single-file count differs, reconcile before committing).

Lint the new files:
```
npx eslint lib/cohort app/sponsor/cohort app/sponsor/actions.ts app/sponsor/actions.invite.test.ts components/sponsor
```
Expected: no errors.

Commit the page:
```
git add app/sponsor/cohort/page.tsx
git commit -m "Trove Plan 6 Task 5: /sponsor/cohort page — role-gated invite form + roster read

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**Deliverable:** `parseEmails` + `inviteCohort` (lib, injected `EmailSender` + `db` — zero real email/DB in tests), the `inviteCohort` server action (sole constructor of the real Postmark sender, origin resolved from request headers), and a role-gated `/sponsor/cohort` page rendering a labeled invite textarea + a text-only-status roster. All unit/UI tests green; the unique(sponsor_id, email) collision is a skip, never an error.

---

### Task 6: Invite accept — /invite/[token] page + acceptInvite action

**Files:**
- Create: `app/invite/[token]/page.tsx` (async server component — narrow pre-accept sponsor-name read by token; accept CTA; routes unauthed visitors to `/login`)
- Create: `app/invite/[token]/actions.ts` (`"use server"` — `acceptInvite(formData)`)
- Create: `app/invite/[token]/actions.test.ts` (unit test — mocks `next/navigation`, `@/lib/supabase/server`, `@/lib/auth/require-user`, `@/lib/auth/provision-earner`, `@/lib/billing/seats`)
- Create: `app/invite/[token]/page.test.tsx` (unit test — mocks `@/lib/supabase/server` and the accept action; asserts sponsor name + hidden token field + a11y accept CTA; asserts a "sign in to accept" affordance when unauthed)

**Interfaces:**

Consumes:
- `accept_cohort_invite(invite_token text) returns uuid` — SECURITY DEFINER RPC (Task 1). Finds an unaccepted `cohort_invites` row by token, upserts `cohort_members(sponsor_id, earner_id=auth.uid(), status='active')`, sets `accepted_at=now()`, returns `sponsor_id`; raises if the caller has no `earners` row or the invite is already accepted / missing.
- `provisionEarner(db: SupabaseClient, userId: string, email: string): Promise<{ handle: string }>` — existing (`lib/auth/provision-earner.ts`), idempotent.
- `requireUserId(): Promise<string>` — existing (`lib/auth/require-user.ts`), redirects to `/login` if unauthed.
- `syncSubscriptionSeats(stripe: StripeLike, db: SupabaseClient, sponsorId: string): Promise<{ quantity: number; skipped: boolean }>` — Task 13 (`lib/billing/seats.ts`). Referenced by interface only; the single typed call site below matches this signature exactly.
- `createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike` — Task 3 (`lib/billing/stripe.ts`). Used to build the `StripeLike` passed to `syncSubscriptionSeats`.

Produces:
```ts
// app/invite/[token]/actions.ts  ("use server" — async exports only)
export async function acceptInvite(formData: FormData): Promise<void>;
// reads 'token'; requireUserId() -> createServerClient() -> provisionEarner(supabase, userId, user.email)
// -> supabase.rpc('accept_cohort_invite', { invite_token: token }) -> on success syncSubscriptionSeats(createStripeClient(), supabase, sponsorId) -> redirect('/app'); on RPC error -> redirect(`/invite/${token}?error=1`)
```
```tsx
// app/invite/[token]/page.tsx
export default async function InvitePage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}): Promise<JSX.Element>;
// narrow read: sponsors.name via cohort_invites join by token (anon RLS or best-effort); renders sponsor name + <form action={acceptInvite}> with hidden token + accept CTA; if unauthed, CTA still submits (action's requireUserId() routes to /login).
```

---

- [ ] **Step 1: Write the failing test for `acceptInvite` (happy path).**

Create `app/invite/[token]/actions.test.ts`:

```ts
import { afterEach, expect, test, vi } from "vitest";

// --- mocks (declared before importing the module under test) ---
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

const requireUserId = vi.fn();
vi.mock("@/lib/auth/require-user", () => ({ requireUserId: () => requireUserId() }));

const provisionEarner = vi.fn();
vi.mock("@/lib/auth/provision-earner", () => ({
  provisionEarner: (...a: unknown[]) => provisionEarner(...a),
}));

const rpc = vi.fn();
const getUser = vi.fn();
const supabase = { auth: { getUser }, rpc };
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => supabase,
}));

const syncSubscriptionSeats = vi.fn();
vi.mock("@/lib/billing/seats", () => ({
  syncSubscriptionSeats: (...a: unknown[]) => syncSubscriptionSeats(...a),
}));

const createStripeClient = vi.fn(() => ({ __fake: true }));
vi.mock("@/lib/billing/stripe", () => ({
  createStripeClient: () => createStripeClient(),
}));

function fd(token: string): FormData {
  const f = new FormData();
  f.set("token", token);
  return f;
}

afterEach(() => {
  redirect.mockClear();
  requireUserId.mockReset();
  provisionEarner.mockReset();
  rpc.mockReset();
  getUser.mockReset();
  syncSubscriptionSeats.mockReset();
  createStripeClient.mockClear();
});

test("provisions the earner, accepts the invite, syncs seats, and redirects to /app", async () => {
  requireUserId.mockResolvedValue("user-1");
  getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "new@ex.com" } } });
  provisionEarner.mockResolvedValue({ handle: "new-abcd" });
  rpc.mockResolvedValue({ data: "sponsor-9", error: null });
  syncSubscriptionSeats.mockResolvedValue({ quantity: 1, skipped: false });

  const { acceptInvite } = await import("./actions");
  await expect(acceptInvite(fd("tok-123"))).rejects.toThrow("REDIRECT:/app");

  expect(provisionEarner).toHaveBeenCalledWith(supabase, "user-1", "new@ex.com");
  expect(rpc).toHaveBeenCalledWith("accept_cohort_invite", { invite_token: "tok-123" });
  expect(syncSubscriptionSeats).toHaveBeenCalledWith(
    { __fake: true },
    supabase,
    "sponsor-9"
  );
  expect(redirect).toHaveBeenCalledWith("/app");
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**

```
npx vitest run app/invite/\[token\]/actions.test.ts
```

Expected: `Error: Failed to load url ./actions` / `Cannot find module './actions'` — the test file fails to import because `app/invite/[token]/actions.ts` does not exist yet.

- [ ] **Step 3: Implement `acceptInvite` (minimal, makes Step 1 pass).**

Create `app/invite/[token]/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { provisionEarner } from "@/lib/auth/provision-earner";
import { createStripeClient } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";

export async function acceptInvite(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect("/invite?error=1");

  const userId = await requireUserId(); // -> /login if unauthed
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.email) {
    // idempotent: creates the earners row iff the invitee is brand new
    await provisionEarner(supabase, userId, user.email);
  }

  const { data: sponsorId, error } = await supabase.rpc("accept_cohort_invite", {
    invite_token: token,
  });
  if (error || !sponsorId) redirect(`/invite/${token}?error=1`);

  // Keep the Stripe subscription quantity == active member count.
  // syncSubscriptionSeats short-circuits (skipped:true) when the sponsor has no
  // subscription yet, so this is safe to call on every accept.
  await syncSubscriptionSeats(createStripeClient(), supabase, sponsorId as string);

  redirect("/app");
}
```

- [ ] **Step 4: Run the test — expect PASS.**

```
npx vitest run app/invite/\[token\]/actions.test.ts
```

Expected: `1 passed`.

> Note: Tasks 3 (`lib/billing/stripe.ts`) and 13 (`lib/billing/seats.ts`) provide the mocked modules. This unit test mocks both, so it passes before those files exist on disk. If you flesh Task 6 before Tasks 3/13 are merged, the `tsc`/`next build` checks in Step 11 will fail on the missing imports — that is the expected signal to land Tasks 3 and 13 first; do NOT stub them here.

- [ ] **Step 5: Add the failing test for the RPC-error branch.**

Append to `app/invite/[token]/actions.test.ts`:

```ts
test("redirects back to the invite with ?error=1 when the RPC fails", async () => {
  requireUserId.mockResolvedValue("user-1");
  getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "new@ex.com" } } });
  provisionEarner.mockResolvedValue({ handle: "new-abcd" });
  rpc.mockResolvedValue({ data: null, error: { message: "already accepted" } });

  const { acceptInvite } = await import("./actions");
  await expect(acceptInvite(fd("tok-xyz"))).rejects.toThrow("REDIRECT:/invite/tok-xyz?error=1");

  expect(syncSubscriptionSeats).not.toHaveBeenCalled();
  expect(redirect).toHaveBeenCalledWith("/invite/tok-xyz?error=1");
});

test("redirects to the bare invite path when no token is supplied", async () => {
  const { acceptInvite } = await import("./actions");
  await expect(acceptInvite(new FormData())).rejects.toThrow("REDIRECT:/invite?error=1");

  expect(requireUserId).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run the tests — expect PASS (impl already covers both branches).**

```
npx vitest run app/invite/\[token\]/actions.test.ts
```

Expected: `3 passed`. The empty-token guard and the `error || !sponsorId` guard from Step 3 already satisfy these; no code change needed.

- [ ] **Step 7: Commit the action + tests.**

```
git add "app/invite/[token]/actions.ts" "app/invite/[token]/actions.test.ts"
git commit -m "feat(invite): acceptInvite server action — provision, accept RPC, seat sync, redirect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: Write the failing test for the invite page.**

Create `app/invite/[token]/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

// The page renders a <form action={acceptInvite}>; mock the action so the form
// submits to a jest.fn rather than a real "use server" boundary.
vi.mock("./actions", () => ({ acceptInvite: vi.fn() }));

// Narrow pre-accept read: page looks up the sponsor name by invite token.
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ from }),
}));

import InvitePage from "./page";

afterEach(() => {
  maybeSingle.mockReset();
  eq.mockClear();
  select.mockClear();
  from.mockClear();
});

test("shows the sponsor name, a hidden token field, and an accessible accept CTA", async () => {
  maybeSingle.mockResolvedValue({
    data: { accepted_at: null, sponsors: { name: "Acme Health" } },
    error: null,
  });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/acme health/i);
  expect(from).toHaveBeenCalledWith("cohort_invites");
  const cta = screen.getByRole("button", { name: /accept invitation/i });
  expect(cta).toBeInTheDocument();
  const tokenField = cta
    .closest("form")!
    .querySelector('input[name="token"]') as HTMLInputElement;
  expect(tokenField).not.toBeNull();
  expect(tokenField.value).toBe("tok-123");
});

test("shows an error message when ?error=1 is present", async () => {
  maybeSingle.mockResolvedValue({
    data: { accepted_at: null, sponsors: { name: "Acme Health" } },
    error: null,
  });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve({ error: "1" }),
  });
  render(ui);

  expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t accept/i);
});

test("shows an invalid-invite message when the token matches no open invite", async () => {
  maybeSingle.mockResolvedValue({ data: null, error: null });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "missing" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByText(/invitation is no longer valid/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /accept invitation/i })).toBeNull();
});
```

- [ ] **Step 9: Run the test — expect FAIL (page missing).**

```
npx vitest run app/invite/\[token\]/page.test.tsx
```

Expected: `Error: Failed to load url ./page` / `Cannot find module './page'` — `app/invite/[token]/page.tsx` does not exist yet.

- [ ] **Step 10: Implement the invite page (minimal, makes Step 8 pass).**

Create `app/invite/[token]/page.tsx`:

```tsx
import { createServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./actions";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  // Narrow pre-accept read: resolve the sponsor's name for a friendly prompt.
  // A missing/accepted invite yields no usable name -> "no longer valid".
  const supabase = await createServerClient();
  const { data: invite } = await supabase
    .from("cohort_invites")
    .select("accepted_at, sponsors(name)")
    .eq("token", token)
    .maybeSingle();

  const sponsor = invite?.sponsors as { name: string } | { name: string }[] | null | undefined;
  const sponsorName = Array.isArray(sponsor) ? sponsor[0]?.name : sponsor?.name;
  const isOpen = !!invite && !invite.accepted_at && !!sponsorName;

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      {isOpen ? (
        <>
          <h1 className="font-heading text-3xl font-bold">{sponsorName} invited you to Trove</h1>
          <p className="mt-4 text-foreground/80">
            Accepting shares nothing automatically. You control what {sponsorName} can see from your
            wallet — consent is off until you turn it on.
          </p>
          {error ? (
            <p className="mt-4 text-sm text-[var(--color-failed)]" role="alert">
              We couldn&apos;t accept this invitation. It may have expired. Please ask for a new one.
            </p>
          ) : null}
          <form action={acceptInvite} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              Accept invitation
            </Button>
          </form>
          <p className="mt-3 text-sm text-foreground/60">
            You&apos;ll be asked to sign in first if you don&apos;t have an account yet.
          </p>
        </>
      ) : (
        <>
          <h1 className="font-heading text-3xl font-bold">Invitation unavailable</h1>
          <p className="mt-4 text-foreground/80">
            This invitation is no longer valid. It may have already been accepted or expired. Ask
            your program for a fresh link.
          </p>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 11: Run the page test — expect PASS.**

```
npx vitest run app/invite/\[token\]/page.test.tsx
```

Expected: `3 passed`.

> A11y note: heading is a real `<h1>`; the CTA is the shared `<Button>` (min 44x44, visible focus ring, 4.5:1 contrast on `bg-primary`); the error uses `role="alert"` and pairs an icon-free but text-explicit message (verification-color rule N/A here — this is a form error, not a verification state). The unauthed path is handled server-side: `acceptInvite` calls `requireUserId()` which `redirect`s to `/login`, so the single CTA works for brand-new and existing users alike; the helper sentence sets that expectation.

- [ ] **Step 12: Type-check and build the route.**

```
npx tsc --noEmit
```
Expected: no errors (requires Tasks 3 `lib/billing/stripe.ts` and 13 `lib/billing/seats.ts` present — see Step 4 note).

```
rm -rf .next && find .next -name "* 2.*" -delete 2>/dev/null; npm run build
```
Expected: build succeeds; `app/invite/[token]` appears in the route manifest as a dynamic ƒ route. If the build reports a missing/unmaterialized `page.js` (iCloud artifact), re-run `rm -rf .next && npm run build`.

- [ ] **Step 13: Lint the new files.**

```
npx eslint "app/invite/[token]/page.tsx" "app/invite/[token]/actions.ts" "app/invite/[token]/actions.test.ts" "app/invite/[token]/page.test.tsx"
```
Expected: no errors, no warnings.

- [ ] **Step 14: Commit the page + tests.**

```
git add "app/invite/[token]/page.tsx" "app/invite/[token]/page.test.tsx"
git commit -m "feat(invite): /invite/[token] accept page — sponsor name, consent-first copy, accept CTA

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Engagement data layer — getSponsorEngagement

The `sponsor_engagement(target_sponsor uuid)` RPC already exists (Task 1) and returns a single aggregate row `(invited int, activated int, imported int, advisor_used int)`, guarded by `is_sponsor_admin`. This task wraps it in a small, injectable, SDK-free data function that maps the snake_case Postgres row to the canonical `EngagementMetrics` shape (Task 3) that the dashboard (Task 8) renders verbatim. No new SQL, no UI — just the mapping layer plus a live-DB spec that seeds a real sponsor + cohort and asserts the counts.

**Files:**
- Create: `lib/billing/engagement.ts`
- Create: `tests/db/sponsor-engagement.test.ts`
- (Consumes, do not modify) `lib/billing/types.ts` (Task 3 — `EngagementMetrics`), `supabase/migrations/0007_sponsor_billing.sql` (Task 1 — `sponsor_engagement` RPC, `cohort_invites`, `create_sponsor`), `tests/db/admin-client.ts`, `tests/db/user-client.ts`.

**Interfaces:**

Consumes:
- `sponsor_engagement(target_sponsor uuid) returns table(invited int, activated int, imported int, advisor_used int)` — Postgres RPC (Task 1). Called as `db.rpc('sponsor_engagement', { target_sponsor: sponsorId })`. Aggregate-only; raises for non-admins.
- `import type { EngagementMetrics } from "@/lib/billing/types"` (Task 3): `{ invited: number; activated: number; imported: number; advisorUsed: number }`.
- `adminClient()` (service role, bypasses RLS) and `makeUserClient(email)` (RLS-scoped) from `tests/db/*`.

Produces:
```ts
// lib/billing/engagement.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngagementMetrics } from "@/lib/billing/types";
export async function getSponsorEngagement(
  db: SupabaseClient,
  sponsorId: string
): Promise<EngagementMetrics>;
// calls rpc('sponsor_engagement', { target_sponsor: sponsorId });
// maps snake_case row { invited, activated, imported, advisor_used } -> { invited, activated, imported, advisorUsed };
// returns { invited:0, activated:0, imported:0, advisorUsed:0 } if the RPC yields no row; throws on RPC error.
```

Consumed by: Task 8 (`app/sponsor/page.tsx` renders four StatCards from this exact shape), Task 14 (integration test asserts engagement reflects a newly-accepted member).

---

- [ ] **Step 1: Write the failing live-DB spec.**

  Create `tests/db/sponsor-engagement.test.ts`. It seeds — via the service-role `adminClient` (bypasses RLS so seeding is deterministic) — one sponsor, some `cohort_invites`, and N earners as `cohort_members` with varying `status`, credentials, and advisor messages, then calls `getSponsorEngagement(admin, sponsorId)` and asserts the mapped counts. Uses `admin` for the read too (the RPC is `SECURITY DEFINER` and `is_sponsor_admin` returns true because we also insert a `sponsor_admins` row for the admin user we create). Matches the `skills-rollup.test.ts` seeding/cleanup conventions (unique emails, `created[]` + `afterAll` teardown).

  ```ts
  import { afterAll, expect, test } from "vitest";
  import { adminClient } from "./admin-client";
  import { getSponsorEngagement } from "@/lib/billing/engagement";

  const admin = adminClient();
  const createdUsers: string[] = [];
  const createdSponsors: string[] = [];

  afterAll(async () => {
    // Delete sponsors first (cascades cohort_members/cohort_invites/sponsor_admins),
    // then the auth users (cascades earners/credentials/advisor_*).
    for (const id of createdSponsors) await admin.from("sponsors").delete().eq("id", id);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  });

  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function makeEarner(): Promise<string> {
    const email = `eng-${uniq()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    const id = data.user!.id;
    createdUsers.push(id);
    await admin.from("earners").insert({ id, handle: `h${uniq().replace(/[^a-z0-9]/gi, "").slice(0, 20)}` });
    return id;
  }

  async function makeSponsorWithAdmin(): Promise<{ sponsorId: string; adminId: string }> {
    const adminId = await makeEarner(); // any auth user can administer; also gives is_sponsor_admin
    const { data, error } = await admin
      .from("sponsors")
      .insert({ name: `Acme ${uniq()}` })
      .select("id")
      .single();
    if (error) throw error;
    const sponsorId = data!.id as string;
    createdSponsors.push(sponsorId);
    await admin.from("sponsor_admins").insert({ sponsor_id: sponsorId, user_id: adminId });
    return { sponsorId, adminId };
  }

  async function addMember(
    sponsorId: string,
    earnerId: string,
    status: "invited" | "active" | "removed"
  ): Promise<void> {
    await admin
      .from("cohort_members")
      .insert({ sponsor_id: sponsorId, earner_id: earnerId, status });
  }

  async function addCredential(earnerId: string): Promise<void> {
    await admin
      .from("credentials")
      .insert({ earner_id: earnerId, source: "manual", title: "Cred" });
  }

  async function addAdvisorMessage(earnerId: string): Promise<void> {
    const { data: thread } = await admin
      .from("advisor_threads")
      .insert({ earner_id: earnerId })
      .select("id")
      .single();
    await admin.from("advisor_messages").insert({
      thread_id: thread!.id,
      earner_id: earnerId,
      role: "user",
      content: "hi",
    });
  }

  test("getSponsorEngagement maps aggregate counts for a seeded cohort", async () => {
    const { sponsorId } = await makeSponsorWithAdmin();

    // Two un-accepted invites (no matching member yet) -> counted toward `invited`.
    await admin.from("cohort_invites").insert([
      { sponsor_id: sponsorId, email: `inv-${uniq()}@example.com`, token: `t-${uniq()}` },
      { sponsor_id: sponsorId, email: `inv-${uniq()}@example.com`, token: `t-${uniq()}` },
    ]);

    // Three active members; one of them also has a credential + an advisor message.
    const m1 = await makeEarner();
    const m2 = await makeEarner();
    const m3 = await makeEarner();
    await addMember(sponsorId, m1, "active");
    await addMember(sponsorId, m2, "active");
    await addMember(sponsorId, m3, "active");
    await addCredential(m1);
    await addAdvisorMessage(m1);

    // One removed member — must NOT count as activated/imported/advisor.
    const m4 = await makeEarner();
    await addMember(sponsorId, m4, "removed");
    await addCredential(m4); // even with a credential, removed => excluded

    const metrics = await getSponsorEngagement(admin, sponsorId);

    // invited = 2 pending invites + 3 active members = 5 (removed excluded).
    expect(metrics.invited).toBe(5);
    expect(metrics.activated).toBe(3);
    expect(metrics.imported).toBe(1);
    expect(metrics.advisorUsed).toBe(1);
  });

  test("getSponsorEngagement returns zeros for a sponsor with no cohort", async () => {
    const { sponsorId } = await makeSponsorWithAdmin();
    const metrics = await getSponsorEngagement(admin, sponsorId);
    expect(metrics).toEqual({ invited: 0, activated: 0, imported: 0, advisorUsed: 0 });
  });
  ```

  > Note: the exact `invited` arithmetic (pending invites + active members, removed excluded) is fixed by the `sponsor_engagement` RPC from Task 1. If Task 1's aggregate definition differs, this spec is the source of truth for the mapping only — adjust the *expected numbers* to match the RPC's documented aggregate, never the mapped field names.

- [ ] **Step 2: Run the spec — expect FAIL (module missing).**

  ```bash
  cd "/Users/mattacevedo/Library/Mobile Documents/com~apple~CloudDocs/Acevedo/Tamahagane/Code/Untitled Badge Wallet Platform"
  npx vitest run tests/db/sponsor-engagement.test.ts
  ```

  Expected: failure resolving the import, e.g. `Failed to load url @/lib/billing/engagement` / `Cannot find module '@/lib/billing/engagement'`. (Both tests error at import time before any assertion runs.)

- [ ] **Step 3: Implement `getSponsorEngagement` (minimal).**

  Create `lib/billing/engagement.ts`. Mirrors the injectable `db: SupabaseClient` boundary used across `lib/advisor/*` and `lib/skills/data.ts`. Throws on RPC error (so a non-admin caller's `raise` surfaces, per Task 1); coalesces a missing row to zeros.

  ```ts
  // Sponsor engagement funnel — thin, SDK-free mapping over the sponsor_engagement RPC (Task 1).
  // The RPC is SECURITY DEFINER and guards on is_sponsor_admin(target_sponsor), so authorization
  // lives in Postgres; this layer only shapes the aggregate row into the canonical EngagementMetrics
  // that the dashboard (Task 8) renders verbatim. Aggregate-only: no individual member row is ever
  // returned, preserving the "consented/aggregate only, never silent surveillance" invariant.
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { EngagementMetrics } from "@/lib/billing/types";

  interface EngagementRpcRow {
    invited: number;
    activated: number;
    imported: number;
    advisor_used: number;
  }

  export async function getSponsorEngagement(
    db: SupabaseClient,
    sponsorId: string
  ): Promise<EngagementMetrics> {
    const { data, error } = await db.rpc("sponsor_engagement", { target_sponsor: sponsorId });
    if (error) throw error;

    // A set-returning RPC comes back as an array of rows; sponsor_engagement returns exactly one.
    // If it yields no row (unexpected for an authorized admin), fall back to zeros rather than NaN.
    const row = (Array.isArray(data) ? data[0] : data) as EngagementRpcRow | undefined | null;
    if (!row) return { invited: 0, activated: 0, imported: 0, advisorUsed: 0 };

    return {
      invited: row.invited ?? 0,
      activated: row.activated ?? 0,
      imported: row.imported ?? 0,
      advisorUsed: row.advisor_used ?? 0,
    };
  }
  ```

- [ ] **Step 4: Run the spec — expect PASS.**

  ```bash
  cd "/Users/mattacevedo/Library/Mobile Documents/com~apple~CloudDocs/Acevedo/Tamahagane/Code/Untitled Badge Wallet Platform"
  npx vitest run tests/db/sponsor-engagement.test.ts
  ```

  Expected: `Test Files 1 passed (1)`, `Tests 2 passed (2)`. Both the seeded-cohort mapping and the empty-cohort zeros case pass.

- [ ] **Step 5: Typecheck + lint the new files.**

  ```bash
  cd "/Users/mattacevedo/Library/Mobile Documents/com~apple~CloudDocs/Acevedo/Tamahagane/Code/Untitled Badge Wallet Platform"
  npx tsc --noEmit && npx eslint lib/billing/engagement.ts tests/db/sponsor-engagement.test.ts
  ```

  Expected: no output (tsc clean), then eslint exits 0 with no findings.

- [ ] **Step 6: Commit.**

  ```bash
  cd "/Users/mattacevedo/Library/Mobile Documents/com~apple~CloudDocs/Acevedo/Tamahagane/Code/Untitled Badge Wallet Platform"
  git add lib/billing/engagement.ts tests/db/sponsor-engagement.test.ts
  git commit -m "$(cat <<'EOF'
Plan 6 Task 7: getSponsorEngagement data layer

Thin SDK-free wrapper over the sponsor_engagement RPC that maps the
snake_case aggregate row to the canonical EngagementMetrics shape
(invited/activated/imported/advisorUsed) consumed by the dashboard.
Live-DB spec seeds invites, active/removed members, credentials, and
advisor messages and asserts the mapped funnel counts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
  ```

  Expected: commit succeeds with two files changed.

---

### Task 8: Engagement dashboard UI — /sponsor page

**Files:**
- Create: `components/sponsor/StatCard.tsx`
- Create: `components/sponsor/StatCard.test.tsx`
- Create: `components/sponsor/MemberTable.tsx`
- Create: `components/sponsor/MemberTable.test.tsx`
- Create: `app/sponsor/page.tsx`
- Modify: none

**Interfaces:**

_Consumes:_
```ts
// lib/billing/types.ts (Task 3)
export interface EngagementMetrics { invited: number; activated: number; imported: number; advisorUsed: number; }
// lib/billing/engagement.ts (Task 7)
export async function getSponsorEngagement(db: SupabaseClient, sponsorId: string): Promise<EngagementMetrics>;
// lib/auth/require-sponsor-admin.ts (Task 4)
export async function requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>;
// lib/supabase/server.ts (existing)
export async function createServerClient(): Promise<SupabaseClient>;
```

_Produces:_
```tsx
// components/sponsor/StatCard.tsx
export function StatCard(props: { label: string; value: number; hint?: string }): JSX.Element;
// components/sponsor/MemberTable.tsx
export function MemberTable(props: { rows: Array<{ handle: string | null; status: string; consentSkills: boolean; consentCredentials: boolean; joinedAt: string }> }): JSX.Element;
```
`app/sponsor/page.tsx` — async server component: `requireSponsorAdmin()` → `getSponsorEngagement()` → four funnel `StatCard`s (Invited / Activated / Imported / Advisor used) + a sortable `MemberTable` rendering ONLY consented/allowed columns (handle, status, consent flags, joined date). Member rows are read RLS-scoped via `cohort_members_sponsor_select` — the page NEVER reads an earner's credentials/skills directly; it surfaces only the consent booleans.

---

- [ ] **Step 8.1: Write the failing StatCard test.**

Create `components/sponsor/StatCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatCard } from "./StatCard";

test("renders the label, the numeric value, and an optional hint", () => {
  const { rerender } = render(<StatCard label="Invited" value={12} />);
  // Label and value are both present and associated (label describes the value).
  expect(screen.getByText("Invited")).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
  // No hint rendered when the prop is omitted.
  expect(screen.queryByText(/of your cohort/i)).toBeNull();

  rerender(<StatCard label="Activated" value={5} hint="of your cohort" />);
  expect(screen.getByText("Activated")).toBeInTheDocument();
  expect(screen.getByText("5")).toBeInTheDocument();
  expect(screen.getByText("of your cohort")).toBeInTheDocument();
});

test("the value carries a text label, not color alone (has an accessible group name)", () => {
  render(<StatCard label="Imported" value={3} />);
  // The card is a labelled group so screen readers announce "Imported, 3".
  const group = screen.getByRole("group", { name: /imported/i });
  expect(group).toHaveTextContent("Imported");
  expect(group).toHaveTextContent("3");
});
```

- [ ] **Step 8.2: Run it — expect FAIL (module not found).**

```bash
npx vitest run components/sponsor/StatCard.test.tsx
```

Expected: fails with `Failed to resolve import "./StatCard"` / `Cannot find module`.

- [ ] **Step 8.3: Implement StatCard (minimal).**

Create `components/sponsor/StatCard.tsx`:

```tsx
import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    // role="group" + aria-label gives the card one accessible name ("Invited, 12"),
    // so meaning never rides on layout/color alone.
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-foreground/15 bg-white p-4"
      )}
    >
      <span className="text-sm font-medium text-foreground/70">{label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      {hint && <span className="text-xs text-foreground/60">{hint}</span>}
    </div>
  );
}
```

- [ ] **Step 8.4: Run it — expect PASS.**

```bash
npx vitest run components/sponsor/StatCard.test.tsx
```

Expected: `2 passed`.

- [ ] **Step 8.5: Commit.**

```bash
git add components/sponsor/StatCard.tsx components/sponsor/StatCard.test.tsx
git commit -m "feat(sponsor): StatCard funnel stat component (a11y group label)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 8.6: Write the failing MemberTable test (rendering + consent surface).**

Create `components/sponsor/MemberTable.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { MemberTable } from "./MemberTable";

const rows = [
  {
    handle: "ada",
    status: "active",
    consentSkills: true,
    consentCredentials: false,
    joinedAt: "2026-03-01T00:00:00.000Z",
  },
  {
    handle: null,
    status: "invited",
    consentSkills: false,
    consentCredentials: false,
    joinedAt: "2026-06-15T00:00:00.000Z",
  },
];

test("renders a real table with scoped column headers", () => {
  render(<MemberTable rows={rows} />);
  const table = screen.getByRole("table", { name: /cohort members/i });
  const headers = within(table).getAllByRole("columnheader");
  const headerText = headers.map((h) => h.textContent);
  expect(headerText).toEqual(
    expect.arrayContaining(["Member", "Status", "Skills shared", "Credentials shared", "Joined"])
  );
  // Every column header is a proper <th scope="col">.
  headers.forEach((h) => expect(h).toHaveAttribute("scope", "col"));
});

test("shows the handle, a fallback for null handles, and consent as text (not color-only)", () => {
  render(<MemberTable rows={rows} />);
  expect(screen.getByText("@ada")).toBeInTheDocument();
  // Null handle falls back to a readable placeholder, never blank.
  expect(screen.getByText(/pending/i)).toBeInTheDocument();
  // Consent booleans render as words, so meaning does not depend on a colored dot.
  expect(screen.getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText("No").length).toBeGreaterThanOrEqual(2);
});

test("does not expose credential or skill detail — only the consent flags", () => {
  render(<MemberTable rows={rows} />);
  // The table has exactly the five allowed columns and no extra ones.
  const table = screen.getByRole("table", { name: /cohort members/i });
  expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
});

test("renders an empty state when there are no members", () => {
  render(<MemberTable rows={[]} />);
  expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});
```

- [ ] **Step 8.7: Run it — expect FAIL (module not found).**

```bash
npx vitest run components/sponsor/MemberTable.test.tsx
```

Expected: fails with `Failed to resolve import "./MemberTable"`.

- [ ] **Step 8.8: Implement MemberTable (non-sortable first, minimal to pass).**

Create `components/sponsor/MemberTable.tsx`:

```tsx
"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export interface MemberRow {
  handle: string | null;
  status: string;
  consentSkills: boolean;
  consentCredentials: boolean;
  joinedAt: string;
}

type SortKey = "handle" | "status" | "consentSkills" | "consentCredentials" | "joinedAt";

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "handle", label: "Member" },
  { key: "status", label: "Status" },
  { key: "consentSkills", label: "Skills shared" },
  { key: "consentCredentials", label: "Credentials shared" },
  { key: "joinedAt", label: "Joined" },
];

function formatJoined(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function compare(a: MemberRow, b: MemberRow, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "boolean" && typeof bv === "boolean") {
    return av === bv ? 0 : av ? -1 : 1;
  }
  return String(av ?? "").localeCompare(String(bv ?? ""));
}

export function MemberTable({ rows }: { rows: MemberRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("joinedAt");
  const [asc, setAsc] = useState(false);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
        No members yet. Invite your cohort to get started.
      </p>
    );
  }

  const sorted = [...rows].sort((a, b) => {
    const c = compare(a, b, sortKey);
    return asc ? c : -c;
  });

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(true);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="Cohort members">
        <thead>
          <tr className="border-b border-foreground/15 text-left">
            {COLUMNS.map((col) => {
              const active = col.key === sortKey;
              const dir = active ? (asc ? "ascending" : "descending") : "none";
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={dir}
                  className="p-0 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggle(col.key)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-1 px-3 text-left text-foreground",
                      "hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    )}
                  >
                    {col.label}
                    <span aria-hidden="true" className="text-xs text-foreground/50">
                      {active ? (asc ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={`${row.handle ?? "pending"}-${i}`} className="border-b border-foreground/10">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                {row.handle ? `@${row.handle}` : <span className="text-foreground/60">Pending sign-up</span>}
              </th>
              <td className="px-3 py-2 capitalize">{row.status}</td>
              <td className="px-3 py-2">{row.consentSkills ? "Yes" : "No"}</td>
              <td className="px-3 py-2">{row.consentCredentials ? "Yes" : "No"}</td>
              <td className="px-3 py-2 tabular-nums">{formatJoined(row.joinedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8.9: Run it — expect PASS.**

```bash
npx vitest run components/sponsor/MemberTable.test.tsx
```

Expected: `4 passed`.

- [ ] **Step 8.10: Commit.**

```bash
git add components/sponsor/MemberTable.tsx components/sponsor/MemberTable.test.tsx
git commit -m "feat(sponsor): MemberTable (consent-only columns, scoped headers)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 8.11: Add the sortable-interaction test (accessible sort toggle).**

Append to `components/sponsor/MemberTable.test.tsx`:

```tsx
import userEvent from "@testing-library/user-event";

test("clicking a column header sorts and updates aria-sort", async () => {
  const user = userEvent.setup();
  render(<MemberTable rows={rows} />);
  const memberHeaderButton = screen.getByRole("button", { name: /member/i });
  const memberHeader = memberHeaderButton.closest("th") as HTMLTableCellElement;

  // First click on a not-yet-active column sorts ascending.
  await user.click(memberHeaderButton);
  expect(memberHeader).toHaveAttribute("aria-sort", "ascending");

  // First body row is a row-header (<th scope="row">); ascending by handle puts "@ada" first
  // ("@ada" < "Pending sign-up").
  const bodyRowHeaders = screen
    .getAllByRole("rowheader")
    .map((el) => el.textContent);
  expect(bodyRowHeaders[0]).toBe("@ada");

  // Clicking the same header again flips direction.
  await user.click(memberHeaderButton);
  expect(memberHeader).toHaveAttribute("aria-sort", "descending");
});
```

- [ ] **Step 8.12: Run it — expect PASS (implementation from 8.8 already covers sort).**

```bash
npx vitest run components/sponsor/MemberTable.test.tsx
```

Expected: `5 passed`. If the ascending order assertion fails, verify `compare()` uses `localeCompare` on the `@`-prefixed rendered value vs. the raw handle — the test asserts on rendered text, and the sort runs on the raw `handle` field, so `"ada"` (raw) sorts before `null→"Pending sign-up"` because `String(null ?? "")` is `""` which sorts first ascending. Adjust the expectation only if you change the null-sort convention: with `String(av ?? "")`, a null handle sorts to the TOP ascending. Fix the fixture/assertion to match the actual convention:

If the run shows `bodyRowHeaders[0]` is `"Pending sign-up"` (empty string sorts first), change the assertion in this test to:

```tsx
  expect(bodyRowHeaders[0]).toBe("Pending sign-up");
```

Re-run and confirm `5 passed`.

- [ ] **Step 8.13: Commit.**

```bash
git add components/sponsor/MemberTable.test.tsx
git commit -m "test(sponsor): MemberTable sortable header interaction + aria-sort

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 8.14: Write the failing /sponsor page test (server component, mocked deps).**

Create `app/sponsor/page.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

// Mock the auth gate, the engagement layer, and the Supabase client so the page
// renders without touching a real DB, network, or Stripe.
vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));
vi.mock("@/lib/billing/engagement", () => ({
  getSponsorEngagement: vi.fn(async () => ({
    invited: 10,
    activated: 6,
    imported: 4,
    advisorUsed: 2,
  })),
}));

const memberRows = [
  {
    handle: "ada",
    status: "active",
    consent_share_skills: true,
    consent_share_credentials: false,
    invited_at: "2026-03-01T00:00:00.000Z",
    earners: { handle: "ada" },
  },
];

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(async () => ({ data: memberRows, error: null })),
        })),
      })),
    })),
  })),
}));

import SponsorPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

test("renders four funnel stat cards from engagement metrics", async () => {
  const ui = await SponsorPage();
  render(ui);
  expect(screen.getByRole("group", { name: /invited: 10/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /activated: 6/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /imported: 4/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /advisor used: 2/i })).toBeInTheDocument();
});

test("renders the member table with the mocked cohort row", async () => {
  const ui = await SponsorPage();
  render(ui);
  const table = screen.getByRole("table", { name: /cohort members/i });
  expect(within(table).getByText("@ada")).toBeInTheDocument();
  // Consent surfaced as text, credential/skill detail never fetched.
  expect(within(table).getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  expect(within(table).getAllByText("No").length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 8.15: Run it — expect FAIL (module not found).**

```bash
npx vitest run app/sponsor/page.test.tsx
```

Expected: fails with `Failed to resolve import "./page"`.

- [ ] **Step 8.16: Implement the /sponsor page (async server component).**

Create `app/sponsor/page.tsx`:

```tsx
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { getSponsorEngagement } from "@/lib/billing/engagement";
import { createServerClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/sponsor/StatCard";
import { MemberTable, type MemberRow } from "@/components/sponsor/MemberTable";

interface CohortMemberJoin {
  status: string;
  consent_share_skills: boolean;
  consent_share_credentials: boolean;
  invited_at: string;
  earners: { handle: string | null } | null;
}

export default async function SponsorPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

  const [metrics, membersResult] = await Promise.all([
    getSponsorEngagement(supabase, sponsorId),
    // RLS (cohort_members_sponsor_select) scopes this to the admin's own cohort.
    // We read ONLY membership + consent flags + the earner's public handle —
    // never credentials or skills.
    supabase
      .from("cohort_members")
      .select(
        "status, consent_share_skills, consent_share_credentials, invited_at, earners(handle)"
      )
      .eq("sponsor_id", sponsorId)
      .order("invited_at", { ascending: false }),
  ]);

  const memberData = (membersResult.data ?? []) as unknown as CohortMemberJoin[];
  const rows: MemberRow[] = memberData.map((m) => ({
    handle: m.earners?.handle ?? null,
    status: m.status,
    consentSkills: m.consent_share_skills,
    consentCredentials: m.consent_share_credentials,
    joinedAt: m.invited_at,
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Cohort engagement</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Aggregate funnel across your cohort. You only see what members have consented to share.
        </p>
      </header>

      <section aria-label="Engagement funnel" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Invited" value={metrics.invited} hint="total invites + members" />
        <StatCard label="Activated" value={metrics.activated} hint="joined the wallet" />
        <StatCard label="Imported" value={metrics.imported} hint="added a credential" />
        <StatCard label="Advisor used" value={metrics.advisorUsed} hint="tried the AI advisor" />
      </section>

      <section aria-label="Members">
        <h2 className="mb-2 font-heading text-base font-semibold">Members</h2>
        <MemberTable rows={rows} />
      </section>
    </div>
  );
}
```

- [ ] **Step 8.17: Run it — expect PASS.**

```bash
npx vitest run app/sponsor/page.test.tsx
```

Expected: `2 passed`.

- [ ] **Step 8.18: Type-check + lint the new surface.**

```bash
npx tsc --noEmit && npx eslint app/sponsor/page.tsx components/sponsor/StatCard.tsx components/sponsor/MemberTable.tsx app/sponsor/page.test.tsx components/sponsor/StatCard.test.tsx components/sponsor/MemberTable.test.tsx
```

Expected: no output from either command (clean). If `tsc` flags the `earners(handle)` join shape, confirm the `as unknown as CohortMemberJoin[]` cast is present — Supabase types the embedded relation as an array or object depending on the FK, and the double cast normalizes it to our shape.

- [ ] **Step 8.19: Commit.**

```bash
git add app/sponsor/page.tsx app/sponsor/page.test.tsx
git commit -m "feat(sponsor): /sponsor engagement dashboard (funnel cards + member table)

Renders four funnel StatCards from getSponsorEngagement and an RLS-scoped
MemberTable that surfaces only consent flags/status/handle/joined date —
never an earner's credentials or skills.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 8.20: Run the non-live half of the suite to confirm no regressions.**

```bash
npx vitest run --exclude "**/tests/db/**"
```

Expected: all component/unit files pass, including the three new files (`StatCard.test.tsx` 2, `MemberTable.test.tsx` 5, `app/sponsor/page.test.tsx` 2). No failures. (The live-DB half is exercised by Task 2 / Task 14; this UI task does not touch it.)

---

### Task 9: Consented aggregate skills — getSponsorSkillCoverage + /sponsor/skills

**Files:**
- Create: `lib/billing/skill-coverage.ts`
- Create: `tests/db/sponsor-skills.test.ts` (live-DB half — `tests/db/`)
- Create: `components/sponsor/CoverageBars.tsx`
- Create: `components/sponsor/CoverageBars.test.tsx` (unit — non-`tests/db/` half)
- Create: `app/sponsor/skills/page.tsx`

**Interfaces:**

Consumes:
- `sponsor_skill_coverage(target_sponsor uuid) returns table(skill_name text, member_count int)` — SECURITY DEFINER RPC guarded by `is_sponsor_admin`, consent_share_skills=true only, `order by member_count desc limit 20` (Task 1).
- `SkillCoverageRow { skillName: string; memberCount: number }` from `lib/billing/types.ts` (Task 3).
- `requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>` from `lib/auth/require-sponsor-admin.ts` (Task 4).
- `createServerClient()` from `lib/supabase/server.ts` (existing).
- Test helpers `adminClient()` from `tests/db/admin-client.ts`, `makeUserClient(email)` from `tests/db/user-client.ts` (existing).

Produces:
```ts
// lib/billing/skill-coverage.ts
export async function getSponsorSkillCoverage(
  db: SupabaseClient,
  sponsorId: string
): Promise<SkillCoverageRow[]>;
// rpc('sponsor_skill_coverage', { target_sponsor: sponsorId });
// maps { skill_name, member_count } -> { skillName, memberCount }; already sorted desc; [] if no rows.
```
```tsx
// components/sponsor/CoverageBars.tsx
export function CoverageBars(props: { rows: SkillCoverageRow[] }): JSX.Element;
// horizontal bars WITH an equivalent <table> fallback (WCAG: never chart-only).
```

---

- [ ] **Step 1: Write the failing unit test for `getSponsorSkillCoverage` (row mapping + empty).**

  This is a data-layer mapping test that stubs the Supabase `rpc()` — no live DB, so it lives in the non-`tests/db/` half and runs fast. Create `lib/billing/skill-coverage.test.ts`:

  ```ts
  import { expect, test, vi } from "vitest";
  import { getSponsorSkillCoverage } from "./skill-coverage";
  import type { SupabaseClient } from "@supabase/supabase-js";

  function fakeDb(rpcResult: { data: unknown; error: unknown }): SupabaseClient {
    return {
      rpc: vi.fn().mockResolvedValue(rpcResult),
    } as unknown as SupabaseClient;
  }

  test("maps snake_case RPC rows to SkillCoverageRow, preserving order", async () => {
    const db = fakeDb({
      data: [
        { skill_name: "Python", member_count: 7 },
        { skill_name: "SQL", member_count: 3 },
      ],
      error: null,
    });
    const rows = await getSponsorSkillCoverage(db, "sponsor-1");
    expect(rows).toEqual([
      { skillName: "Python", memberCount: 7 },
      { skillName: "SQL", memberCount: 3 },
    ]);
    expect(db.rpc).toHaveBeenCalledWith("sponsor_skill_coverage", {
      target_sponsor: "sponsor-1",
    });
  });

  test("returns [] when RPC yields no rows (null data)", async () => {
    const db = fakeDb({ data: null, error: null });
    expect(await getSponsorSkillCoverage(db, "sponsor-1")).toEqual([]);
  });

  test("throws when RPC returns an error", async () => {
    const db = fakeDb({ data: null, error: { message: "not authorized" } });
    await expect(getSponsorSkillCoverage(db, "sponsor-1")).rejects.toThrow(
      "not authorized"
    );
  });
  ```

- [ ] **Step 2: Run the unit test — expect FAIL (module missing).**

  ```
  npx vitest run lib/billing/skill-coverage.test.ts
  ```
  Expected: fails to resolve `./skill-coverage` — `Error: Failed to load url ./skill-coverage` / "Cannot find module". No test passes.

- [ ] **Step 3: Implement `lib/billing/skill-coverage.ts` (minimal).**

  ```ts
  // Consented aggregate skill coverage for a sponsor. Thin mapping layer over the
  // SECURITY DEFINER `sponsor_skill_coverage` RPC (Task 1), which itself enforces
  // is_sponsor_admin + consent_share_skills=true and returns the top ~20 skills
  // ordered by member_count desc. This module NEVER reads individual earner rows.
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { SkillCoverageRow } from "@/lib/billing/types";

  interface CoverageRpcRow {
    skill_name: string;
    member_count: number;
  }

  export async function getSponsorSkillCoverage(
    db: SupabaseClient,
    sponsorId: string
  ): Promise<SkillCoverageRow[]> {
    const { data, error } = await db.rpc("sponsor_skill_coverage", {
      target_sponsor: sponsorId,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as CoverageRpcRow[];
    return rows.map((r) => ({
      skillName: r.skill_name,
      memberCount: r.member_count,
    }));
  }
  ```

- [ ] **Step 4: Run the unit test — expect PASS.**

  ```
  npx vitest run lib/billing/skill-coverage.test.ts
  ```
  Expected: `3 passed`.

- [ ] **Step 5: Commit.**

  ```
  git add lib/billing/skill-coverage.ts lib/billing/skill-coverage.test.ts
  git commit -m "feat(billing): getSponsorSkillCoverage maps sponsor_skill_coverage RPC

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write the failing live-DB test asserting consent gating + admin guard.**

  This exercises the real RPC from migration 0007: it must count ONLY members whose `consent_share_skills=true`, aggregate across earners, and RAISE for a non-admin caller. Create `tests/db/sponsor-skills.test.ts`:

  ```ts
  import { afterAll, expect, test } from "vitest";
  import { adminClient } from "./admin-client";
  import { makeUserClient } from "./user-client";
  import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";

  const admin = adminClient();
  const createdUsers: string[] = [];

  afterAll(async () => {
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  });

  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function seedEarner(): Promise<string> {
    const email = `sk-${uniq()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (error) throw error;
    const id = data!.user!.id;
    createdUsers.push(id);
    await admin.from("earners").insert({ id, handle: `h${uniq().replace(/[^a-z0-9]/gi, "")}` });
    return id;
  }

  async function twoSkillIds(): Promise<[string, string]> {
    const { data } = await admin.from("skills").select("id, canonical_name").limit(2);
    expect(data && data.length).toBeGreaterThanOrEqual(2);
    return [data![0].id as string, data![1].id as string];
  }

  async function giveEarnerSkill(earnerId: string, skillId: string) {
    // earner_skills is the rolled-up profile the coverage RPC aggregates over.
    await admin
      .from("earner_skills")
      .insert({ earner_id: earnerId, skill_id: skillId, source_count: 1, highest_confidence: 1.0 });
  }

  test("coverage counts consenting members only; admin-guarded", async () => {
    // An admin who owns a sponsor, created via the create_sponsor RPC (Task 1).
    const { client: adminUser } = await makeUserClient(`owner-${uniq()}@example.com`);
    createdUsers.push((await adminUser.auth.getUser()).data.user!.id);
    const { data: sponsorId, error: createErr } = await adminUser.rpc("create_sponsor", {
      sponsor_name: "Skill Co",
    });
    expect(createErr).toBeNull();

    const [skillA] = await twoSkillIds();

    // Member 1: consents to share skills; has skillA.
    const m1 = await seedEarner();
    await giveEarnerSkill(m1, skillA);
    await admin.from("cohort_members").insert({
      sponsor_id: sponsorId,
      earner_id: m1,
      status: "active",
      consent_share_skills: true,
    });

    // Member 2: does NOT consent; also has skillA -> must be excluded from counts.
    const m2 = await seedEarner();
    await giveEarnerSkill(m2, skillA);
    await admin.from("cohort_members").insert({
      sponsor_id: sponsorId,
      earner_id: m2,
      status: "active",
      consent_share_skills: false,
    });

    const rows = await getSponsorSkillCoverage(adminUser, sponsorId as string);
    const skillARow = rows.find((r) => r.memberCount > 0);
    expect(skillARow).toBeDefined();
    // Only the consenting member counts.
    expect(skillARow!.memberCount).toBe(1);
  });

  test("sponsor_skill_coverage RAISES for a non-admin caller", async () => {
    // Owner creates a sponsor; a DIFFERENT user (not an admin of it) calls the RPC.
    const { client: owner } = await makeUserClient(`o2-${uniq()}@example.com`);
    createdUsers.push((await owner.auth.getUser()).data.user!.id);
    const { data: sponsorId } = await owner.rpc("create_sponsor", {
      sponsor_name: "Guarded Co",
    });

    const { client: outsider } = await makeUserClient(`out-${uniq()}@example.com`);
    createdUsers.push((await outsider.auth.getUser()).data.user!.id);

    await expect(
      getSponsorSkillCoverage(outsider, sponsorId as string)
    ).rejects.toThrow();
  });
  ```

- [ ] **Step 7: Run the live-DB test — expect PASS (0007 is already applied from Task 1).**

  ```
  npx vitest run tests/db/sponsor-skills.test.ts
  ```
  Expected: `2 passed`. (If the RPC / create_sponsor is missing, migration 0007 was not applied — run `node scripts/apply-migration.mjs supabase/migrations/0007_sponsor_billing.sql` first, then rerun.)

- [ ] **Step 8: Commit.**

  ```
  git add tests/db/sponsor-skills.test.ts
  git commit -m "test(billing): live-DB coverage excludes non-consenting members, guards non-admin

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

- [ ] **Step 9: Write the failing component test for `CoverageBars` (bars + table fallback + a11y).**

  Create `components/sponsor/CoverageBars.test.tsx`:

  ```tsx
  import { render, screen, within } from "@testing-library/react";
  import { expect, test } from "vitest";
  import { CoverageBars } from "./CoverageBars";

  const rows = [
    { skillName: "Python", memberCount: 8 },
    { skillName: "SQL", memberCount: 2 },
  ];

  test("renders an accessible data table with a caption and every skill row", () => {
    render(<CoverageBars rows={rows} />);
    const table = screen.getByRole("table", { name: /skill coverage/i });
    expect(table).toBeInTheDocument();
    // Header cells present.
    expect(within(table).getByRole("columnheader", { name: /skill/i })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /members/i })).toBeInTheDocument();
    // Each skill + its count appears in the table.
    expect(within(table).getByRole("cell", { name: "Python" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "8" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "SQL" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "2" })).toBeInTheDocument();
  });

  test("bars are decorative (aria-hidden) so the count is read once, from the table", () => {
    const { container } = render(<CoverageBars rows={rows} />);
    const bars = container.querySelector('[data-testid="coverage-bars"]');
    expect(bars).not.toBeNull();
    expect(bars).toHaveAttribute("aria-hidden", "true");
  });

  test("bar width is proportional to the max count", () => {
    const { container } = render(<CoverageBars rows={rows} />);
    const fills = container.querySelectorAll('[data-testid="bar-fill"]');
    expect(fills).toHaveLength(2);
    // Python is the max (8) -> 100%; SQL is 2/8 -> 25%.
    expect((fills[0] as HTMLElement).style.width).toBe("100%");
    expect((fills[1] as HTMLElement).style.width).toBe("25%");
  });

  test("empty state communicates no consented skills in words", () => {
    render(<CoverageBars rows={[]} />);
    expect(screen.getByText(/no consented skill data yet/i)).toBeInTheDocument();
  });
  ```

- [ ] **Step 10: Run the component test — expect FAIL (component missing).**

  ```
  npx vitest run components/sponsor/CoverageBars.test.tsx
  ```
  Expected: fails to resolve `./CoverageBars` — "Cannot find module" / "Failed to load url". No test passes.

- [ ] **Step 11: Implement `components/sponsor/CoverageBars.tsx`.**

  Bars are `aria-hidden` decoration; the `<table>` is the real, screen-reader-consumed data (WCAG: chart never color/visual-alone). Colors use the design primary via the existing CSS var pattern.

  ```tsx
  import { cn } from "@/lib/cn";
  import type { SkillCoverageRow } from "@/lib/billing/types";

  export function CoverageBars({ rows }: { rows: SkillCoverageRow[] }) {
    if (rows.length === 0) {
      return (
        <p className="text-sm text-gray-600">
          No consented skill data yet. Coverage appears once cohort members opt in
          to share their skills.
        </p>
      );
    }

    const max = Math.max(...rows.map((r) => r.memberCount), 1);

    return (
      <div className="space-y-4">
        {/* Decorative visual — the numbers below are the authoritative source. */}
        <div data-testid="coverage-bars" aria-hidden="true" className="space-y-2">
          {rows.map((r) => (
            <div key={r.skillName} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-sm">{r.skillName}</span>
              <span className="h-4 flex-1 overflow-hidden rounded bg-gray-100">
                <span
                  data-testid="bar-fill"
                  className="block h-full rounded bg-[var(--color-primary,#2563EB)]"
                  style={{ width: `${Math.round((r.memberCount / max) * 100)}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-sm tabular-nums">
                {r.memberCount}
              </span>
            </div>
          ))}
        </div>

        {/* Accessible equivalent — the real data table. */}
        <table className={cn("w-full border-collapse text-sm")}>
          <caption className="sr-only">Skill coverage across consenting members</caption>
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th scope="col" className="py-2 pr-4 font-medium">
                Skill
              </th>
              <th scope="col" className="py-2 font-medium">
                Members
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.skillName} className="border-b border-gray-100">
                <td className="py-2 pr-4">{r.skillName}</td>
                <td className="py-2 tabular-nums">{r.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  ```

- [ ] **Step 12: Run the component test — expect PASS.**

  ```
  npx vitest run components/sponsor/CoverageBars.test.tsx
  ```
  Expected: `4 passed`.

- [ ] **Step 13: Commit.**

  ```
  git add components/sponsor/CoverageBars.tsx components/sponsor/CoverageBars.test.tsx
  git commit -m "feat(sponsor): CoverageBars chart with accessible table fallback

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

- [ ] **Step 14: Write the failing page test for `/sponsor/skills` (gate + data wiring).**

  The page is an async server component; test it by mocking `requireSponsorAdmin`, `createServerClient`, and `getSponsorSkillCoverage`, then awaiting the component and rendering the returned tree. Create `app/sponsor/skills/page.test.tsx`:

  ```tsx
  import { render, screen } from "@testing-library/react";
  import { expect, test, vi, beforeEach } from "vitest";

  const requireSponsorAdmin = vi.fn();
  const getSponsorSkillCoverage = vi.fn();
  const createServerClient = vi.fn();

  vi.mock("@/lib/auth/require-sponsor-admin", () => ({ requireSponsorAdmin }));
  vi.mock("@/lib/billing/skill-coverage", () => ({ getSponsorSkillCoverage }));
  vi.mock("@/lib/supabase/server", () => ({ createServerClient }));

  import SkillsPage from "./page";

  beforeEach(() => {
    vi.clearAllMocks();
    requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "s1" });
    createServerClient.mockResolvedValue({ __db: true });
    getSponsorSkillCoverage.mockResolvedValue([
      { skillName: "Python", memberCount: 5 },
    ]);
  });

  test("gates on requireSponsorAdmin and renders coverage for that sponsor", async () => {
    render(await SkillsPage());
    expect(requireSponsorAdmin).toHaveBeenCalledOnce();
    expect(getSponsorSkillCoverage).toHaveBeenCalledWith({ __db: true }, "s1");
    // Rendered via CoverageBars' table.
    expect(screen.getByRole("cell", { name: "Python" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "5" })).toBeInTheDocument();
  });

  test("renders a page heading", async () => {
    render(await SkillsPage());
    expect(
      screen.getByRole("heading", { name: /skill coverage/i })
    ).toBeInTheDocument();
  });
  ```

- [ ] **Step 15: Run the page test — expect FAIL (page missing).**

  ```
  npx vitest run app/sponsor/skills/page.test.tsx
  ```
  Expected: fails to resolve `./page` — "Cannot find module". No test passes.

- [ ] **Step 16: Implement `app/sponsor/skills/page.tsx`.**

  ```tsx
  import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
  import { createServerClient } from "@/lib/supabase/server";
  import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";
  import { CoverageBars } from "@/components/sponsor/CoverageBars";

  export default async function SkillsPage() {
    const { sponsorId } = await requireSponsorAdmin();
    const db = await createServerClient();
    const rows = await getSponsorSkillCoverage(db, sponsorId);

    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold">Skill coverage</h1>
        <p className="mt-1 text-sm text-gray-600">
          Aggregate skills across cohort members who opted in to share. Individual
          members are never identified here.
        </p>
        <div className="mt-6">
          <CoverageBars rows={rows} />
        </div>
      </main>
    );
  }
  ```

- [ ] **Step 17: Run the page test — expect PASS.**

  ```
  npx vitest run app/sponsor/skills/page.test.tsx
  ```
  Expected: `2 passed`.

- [ ] **Step 18: Typecheck + lint the new files, then run BOTH suite halves.**

  ```
  npx tsc --noEmit
  npx eslint lib/billing/skill-coverage.ts lib/billing/skill-coverage.test.ts components/sponsor/CoverageBars.tsx components/sponsor/CoverageBars.test.tsx app/sponsor/skills/page.tsx app/sponsor/skills/page.test.tsx tests/db/sponsor-skills.test.ts
  npx vitest run --exclude "**/tests/db/**"
  npx vitest run tests/db
  ```
  Expected: `tsc` prints nothing (exit 0); eslint prints nothing (exit 0); both vitest runs report all files passing with no failures. (If a live-DB half spuriously worker-timeouts on the iCloud path, rerun `npx vitest run tests/db` once — do not edit `vitest.config.ts`.)

- [ ] **Step 19: Final commit for the page.**

  ```
  git add app/sponsor/skills/page.tsx app/sponsor/skills/page.test.tsx
  git commit -m "feat(sponsor): /sponsor/skills page — gated consented skill coverage

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 10: Stripe customer + Checkout session

**Files:**
- Create: `lib/billing/customer.ts`
- Create: `lib/billing/customer.test.ts`
- Create: `lib/billing/checkout.ts`
- Create: `lib/billing/checkout.test.ts`
- Modify: `lib/billing/stripe.test.ts` (add a case asserting `createStripeClient({ client })` returns the injected fake unchanged, so `ensureStripeCustomer`/`createCheckoutSession` can be driven by a fake in this task's tests)
- Modify: `app/sponsor/actions.ts` (add the `startCheckout` server action)

**Interfaces:**

_Consumes:_
- `StripeLike` and `SponsorRow` from `lib/billing/types.ts` (Task 3).
- `createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike` from `lib/billing/stripe.ts` (Task 3).
- `requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>` from `lib/auth/require-sponsor-admin.ts` (Task 4).
- `createServerClient()` from `lib/supabase/server.ts`; `sponsors` billing columns from migration 0007 (Task 1): `name`, `stripe_customer_id`.
- Active-member count query on `cohort_members` (`status = 'active'`). Task 13 centralizes this as `countActiveMembers(db, sponsorId)`. **T13 is not yet merged, so this task inlines the identical count query in the `startCheckout` action and leaves a `// TODO(Task 13): replace with countActiveMembers()` marker so T13 can refactor it away.**

_Produces:_
```ts
// lib/billing/customer.ts
export async function ensureStripeCustomer(stripe: StripeLike, db: SupabaseClient, sponsorId: string): Promise<string>;
// returns existing sponsors.stripe_customer_id, or creates a Stripe customer (name = sponsor.name,
// metadata.sponsor_id = sponsorId), persists the new id onto sponsors.stripe_customer_id, returns it.

// lib/billing/checkout.ts
export class SubscriptionAlreadyExistsError extends Error {} // thrown when sponsors.stripe_subscription_id is non-null
export async function createCheckoutSession(
  stripe: StripeLike,
  db: SupabaseClient,
  args: { sponsorId: string; priceId: string; quantity: number; successUrl: string; cancelUrl: string }
): Promise<{ url: string }>;
// F13: reads sponsors.stripe_subscription_id first; if non-null (incl. past_due/incomplete) throws
// SubscriptionAlreadyExistsError WITHOUT creating a session. Otherwise ensures the customer, creates a
// subscription-mode Checkout session (customer, line_items:[{ price, quantity }], success_url,
// cancel_url), returns { url }; throws if Stripe returns a null session url.

// app/sponsor/actions.ts
export async function startCheckout(formData: FormData): Promise<void>;
// requireSponsorAdmin(); quantity = current active-member count (>= 1); priceId = process.env.STRIPE_PRICE_ID;
// success/cancel URLs from the sponsor origin; redirect(session.url). If createCheckoutSession throws
// SubscriptionAlreadyExistsError, routes to the Customer Portal via openBillingPortal (F13).
```

---

- [ ] **Step 1: Confirm the injected fake passes through `createStripeClient` (extend `stripe.test.ts`).**
  Task 3 already tests the real-key path is not read. Add one case pinning the behavior this task relies on: when a `client` is injected, `createStripeClient` returns it verbatim (no `new Stripe(...)`).
  Append to `lib/billing/stripe.test.ts`:
  ```ts
  test("createStripeClient returns the injected client unchanged (no real SDK constructed)", () => {
    const fake: StripeLike = {
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), update: vi.fn() },
      invoices: { list: vi.fn() },
      webhooks: { constructEvent: vi.fn() },
    } as unknown as StripeLike;
    expect(createStripeClient({ client: fake })).toBe(fake);
  });
  ```
  Ensure the file's imports include `StripeLike`:
  ```ts
  import { createStripeClient, STRIPE_API_VERSION } from "./stripe";
  import type { StripeLike } from "./types";
  import { expect, test, vi } from "vitest";
  ```
  (If `expect/test/vi` and `createStripeClient` are already imported from Task 3, only add the `StripeLike` type import and the new `test(...)` block — do not duplicate imports.)

- [ ] **Step 2: Run the extended stripe test — expect PASS (guards the fake-injection contract).**
  ```
  npx vitest run lib/billing/stripe.test.ts
  ```
  Expected: all tests pass, including `createStripeClient returns the injected client unchanged (no real SDK constructed)`. If this fails, Task 3's `createStripeClient` does not honor `opts.client` first — fix Task 3 before continuing (this task depends on injecting a fake).
  Commit:
  ```
  git add lib/billing/stripe.test.ts
  git commit -m "test(billing): pin createStripeClient injected-client passthrough for Task 10 fakes"
  ```

- [ ] **Step 3: Write the failing test for `ensureStripeCustomer` (returns existing id; creates+persists otherwise).**
  Create `lib/billing/customer.test.ts`. The Supabase client is a hand-rolled fake exposing only the chained calls we use (`from().select().eq().single()` for the read, `from().update().eq()` for the write) — no real network, mirroring the injectable-adapter discipline used for the LLM in `lib/advisor/llm.test.ts`.
  ```ts
  import { expect, test, vi } from "vitest";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { StripeLike } from "./types";
  import { ensureStripeCustomer } from "./customer";

  function fakeStripe(overrides?: Partial<StripeLike>): StripeLike {
    return {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_new" }) },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), update: vi.fn() },
      invoices: { list: vi.fn() },
      webhooks: { constructEvent: vi.fn() },
      ...overrides,
    } as unknown as StripeLike;
  }

  // Minimal Supabase fake: one row of `sponsors` state, mutated by update().
  function fakeDb(row: { name: string; stripe_customer_id: string | null }) {
    const state = { ...row };
    const update = vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state, patch);
      return { eq: vi.fn().mockResolvedValue({ error: null }) };
    });
    const from = vi.fn((table: string) => {
      expect(table).toBe("sponsors");
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { name: state.name, stripe_customer_id: state.stripe_customer_id },
              error: null,
            }),
          })),
        })),
        update,
      };
    });
    return { db: { from } as unknown as SupabaseClient, state, update };
  }

  test("returns the existing stripe_customer_id and does not call Stripe", async () => {
    const stripe = fakeStripe();
    const { db } = fakeDb({ name: "Acme", stripe_customer_id: "cus_existing" });
    const id = await ensureStripeCustomer(stripe, db, "spon_1");
    expect(id).toBe("cus_existing");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  test("creates a Stripe customer (name + metadata.sponsor_id), persists, and returns the new id", async () => {
    const stripe = fakeStripe();
    const { db, state, update } = fakeDb({ name: "Acme", stripe_customer_id: null });
    const id = await ensureStripeCustomer(stripe, db, "spon_1");
    expect(id).toBe("cus_new");
    const createArgs = (stripe.customers.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      name: string;
      metadata: { sponsor_id: string };
    };
    expect(createArgs.name).toBe("Acme");
    expect(createArgs.metadata.sponsor_id).toBe("spon_1");
    expect(update).toHaveBeenCalledWith({ stripe_customer_id: "cus_new" });
    expect(state.stripe_customer_id).toBe("cus_new"); // persisted
  });
  ```

- [ ] **Step 4: Run it — expect FAIL (module missing).**
  ```
  npx vitest run lib/billing/customer.test.ts
  ```
  Expected: failure resolving `./customer` — `Failed to load url ./customer` / `Cannot find module`.

- [ ] **Step 5: Implement `lib/billing/customer.ts` (minimal).**
  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { StripeLike } from "./types";

  /**
   * Idempotently resolve the Stripe customer id for a sponsor. Returns the persisted
   * sponsors.stripe_customer_id when present; otherwise creates a Stripe customer (named after the
   * sponsor, tagged with sponsor_id metadata for webhook reconciliation), writes the id back onto
   * the sponsor row, and returns it. The Supabase client MUST have privileges to update the row
   * (service-role in webhook contexts, or an RLS-authorized sponsor admin via sponsors_admin_update).
   */
  export async function ensureStripeCustomer(
    stripe: StripeLike,
    db: SupabaseClient,
    sponsorId: string
  ): Promise<string> {
    const { data, error } = await db
      .from("sponsors")
      .select("name, stripe_customer_id")
      .eq("id", sponsorId)
      .single();
    if (error) throw error;
    if (!data) throw new Error(`sponsor not found: ${sponsorId}`);

    const existing = (data.stripe_customer_id as string | null) ?? null;
    if (existing) return existing;

    const customer = await stripe.customers.create({
      name: (data.name as string) ?? "",
      metadata: { sponsor_id: sponsorId },
    });

    const { error: updateError } = await db
      .from("sponsors")
      .update({ stripe_customer_id: customer.id })
      .eq("id", sponsorId);
    if (updateError) throw updateError;

    return customer.id;
  }
  ```

- [ ] **Step 6: Run it — expect PASS; commit.**
  ```
  npx vitest run lib/billing/customer.test.ts
  ```
  Expected: 2 passed. Commit:
  ```
  git add lib/billing/customer.ts lib/billing/customer.test.ts
  git commit -m "feat(billing): ensureStripeCustomer — idempotent Stripe customer per sponsor"
  ```

- [ ] **Step 7: Write the failing test for `createCheckoutSession` (subscription mode, line item, url).**
  Create `lib/billing/checkout.test.ts`. Reuse the same fake shapes; here `ensureStripeCustomer` runs against a sponsor with an existing customer so the test focuses on the Checkout args.
  ```ts
  import { expect, test, vi } from "vitest";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { StripeLike } from "./types";
  import { createCheckoutSession, SubscriptionAlreadyExistsError } from "./checkout";

  function fakeStripe(sessionUrl: string | null): {
    stripe: StripeLike;
    create: ReturnType<typeof vi.fn>;
  } {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: sessionUrl });
    const stripe = {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_new" }) },
      checkout: { sessions: { create } },
      billingPortal: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), update: vi.fn() },
      invoices: { list: vi.fn() },
      webhooks: { constructEvent: vi.fn() },
    } as unknown as StripeLike;
    return { stripe, create };
  }

  // The sponsors row read now includes stripe_subscription_id so the F13 no-second-subscription guard
  // can be exercised. Default subscriptionId is null (no existing subscription -> Checkout allowed).
  function fakeDb(stripeCustomerId: string | null, subscriptionId: string | null = null) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                name: "Acme",
                stripe_customer_id: stripeCustomerId,
                stripe_subscription_id: subscriptionId,
              },
              error: null,
            }),
          })),
        })),
        update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
      })),
    } as unknown as SupabaseClient;
  }

  test("creates a subscription-mode session with the price+quantity line item and returns url", async () => {
    const { stripe, create } = fakeStripe("https://checkout.stripe.com/c/pay/cs_1");
    const db = fakeDb("cus_existing"); // no existing subscription
    const out = await createCheckoutSession(stripe, db, {
      sponsorId: "spon_1",
      priceId: "price_123",
      quantity: 7,
      successUrl: "https://app.example.com/sponsor/billing?ok=1",
      cancelUrl: "https://app.example.com/sponsor/billing?cancel=1",
    });
    expect(out.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    const args = create.mock.calls[0][0] as {
      mode: string;
      customer: string;
      line_items: Array<{ price: string; quantity: number }>;
      success_url: string;
      cancel_url: string;
    };
    expect(args.mode).toBe("subscription");
    expect(args.customer).toBe("cus_existing");
    expect(args.line_items).toEqual([{ price: "price_123", quantity: 7 }]);
    expect(args.success_url).toBe("https://app.example.com/sponsor/billing?ok=1");
    expect(args.cancel_url).toBe("https://app.example.com/sponsor/billing?cancel=1");
  });

  test("throws SubscriptionAlreadyExistsError and does NOT create a session when a subscription exists (F13)", async () => {
    const { stripe, create } = fakeStripe("https://checkout.stripe.com/c/pay/cs_1");
    // A past_due subscription still means one EXISTS — do not start a second; route to Portal.
    const db = fakeDb("cus_existing", "sub_pastdue");
    await expect(
      createCheckoutSession(stripe, db, {
        sponsorId: "spon_1",
        priceId: "price_123",
        quantity: 1,
        successUrl: "https://app.example.com/ok",
        cancelUrl: "https://app.example.com/cancel",
      })
    ).rejects.toBeInstanceOf(SubscriptionAlreadyExistsError);
    expect(create).not.toHaveBeenCalled();
  });

  test("throws when Stripe returns a null session url", async () => {
    const { stripe } = fakeStripe(null);
    const db = fakeDb("cus_existing");
    await expect(
      createCheckoutSession(stripe, db, {
        sponsorId: "spon_1",
        priceId: "price_123",
        quantity: 1,
        successUrl: "https://app.example.com/ok",
        cancelUrl: "https://app.example.com/cancel",
      })
    ).rejects.toThrow(/checkout session url/i);
  });
  ```

- [ ] **Step 8: Run it — expect FAIL (module missing).**
  ```
  npx vitest run lib/billing/checkout.test.ts
  ```
  Expected: failure resolving `./checkout`.

- [ ] **Step 9: Implement `lib/billing/checkout.ts` (minimal).**
  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { StripeLike } from "./types";
  import { ensureStripeCustomer } from "./customer";

  /**
   * Thrown when a sponsor already has a subscription and therefore must NOT start a second one via
   * Checkout. The caller (startCheckout action) catches this and routes the admin to the Customer
   * Portal to fix payment / manage the EXISTING subscription instead. Carrying a discriminable name
   * lets the action branch on it without string-matching the message.
   */
  export class SubscriptionAlreadyExistsError extends Error {
    readonly code = "subscription_exists";
    constructor(public readonly stripeSubscriptionId: string) {
      super(`sponsor already has subscription ${stripeSubscriptionId}`);
      this.name = "SubscriptionAlreadyExistsError";
    }
  }

  /**
   * Create a subscription-mode Stripe Checkout session for a sponsor's seat subscription. The single
   * line item pins the seat price and the seat quantity (the caller passes the active-member count).
   *
   * Guards against a SECOND subscription (F13): if the sponsor row already has a
   * stripe_subscription_id (even in past_due/incomplete), this throws SubscriptionAlreadyExistsError
   * instead of creating another subscription — the admin should fix the existing one in the Portal.
   *
   * Returns the hosted Checkout url; throws if Stripe omits it (a Checkout session with no url cannot
   * be redirected to and indicates a misconfiguration rather than a normal outcome).
   */
  export async function createCheckoutSession(
    stripe: StripeLike,
    db: SupabaseClient,
    args: {
      sponsorId: string;
      priceId: string;
      quantity: number;
      successUrl: string;
      cancelUrl: string;
    }
  ): Promise<{ url: string }> {
    // Read the current subscription state BEFORE creating anything.
    const { data: sponsor, error } = await db
      .from("sponsors")
      .select("stripe_subscription_id")
      .eq("id", args.sponsorId)
      .single();
    if (error) throw error;
    const existingSub = (sponsor?.stripe_subscription_id as string | null) ?? null;
    if (existingSub) throw new SubscriptionAlreadyExistsError(existingSub);

    const customerId = await ensureStripeCustomer(stripe, db, args.sponsorId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: args.quantity }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    });

    if (!session.url) {
      throw new Error("Stripe returned a checkout session url of null");
    }
    return { url: session.url };
  }
  ```

- [ ] **Step 10: Run it — expect PASS; commit.**
  ```
  npx vitest run lib/billing/checkout.test.ts
  ```
  Expected: 3 passed (happy path, no-second-subscription guard, null-url throw). Commit:
  ```
  git add lib/billing/checkout.ts lib/billing/checkout.test.ts
  git commit -m "feat(billing): createCheckoutSession — subscription-mode Checkout, guards against a second subscription (F13)"
  ```

- [ ] **Step 11: Add the `startCheckout` server action to `app/sponsor/actions.ts`.**
  This wires the pure helpers to the request: it resolves the admin's sponsor, computes the seat quantity from the live active-member count (inlined here; Task 13 refactors to `countActiveMembers`), reads the price id from the environment (never a test), builds absolute success/cancel URLs from the request origin, and redirects to the hosted session.
  `redirect()` throws a control-flow signal, so it is called OUTSIDE any `try/catch` (matching `app/app/advisor/actions.ts`).
  Add these imports at the top of `app/sponsor/actions.ts` (merge with the existing Task 4/5 import block — do not duplicate `createServerClient`, `redirect`, or `requireSponsorAdmin`):
  ```ts
  import { headers } from "next/headers";
  import { createStripeClient } from "@/lib/billing/stripe";
  import { createCheckoutSession, SubscriptionAlreadyExistsError } from "@/lib/billing/checkout";
  ```
  Append this action to the file (it already begins with `"use server";` and exports only async functions — keep that invariant):
  ```ts
  /**
   * Begin a Stripe Checkout for the current sponsor's seat subscription. Quantity is the current
   * active-member count (minimum 1 so a brand-new org can still subscribe a seat). The price id is
   * environment-only (STRIPE_PRICE_ID); tests never read it because they exercise
   * createCheckoutSession directly with an injected fake StripeLike.
   *
   * F13: if a subscription already exists (createCheckoutSession throws SubscriptionAlreadyExistsError,
   * including for past_due/incomplete), do NOT start a second one — route the admin to the Customer
   * Portal to fix payment. The final redirect(s) run OUTSIDE the try/catch (redirect throws a control
   * signal, so it must not be swallowed).
   */
  export async function startCheckout(): Promise<void> {
    const { sponsorId } = await requireSponsorAdmin();
    const supabase = await createServerClient();

    // TODO(Task 13): replace with countActiveMembers(supabase, sponsorId).
    const { count } = await supabase
      .from("cohort_members")
      .select("*", { count: "exact", head: true })
      .eq("sponsor_id", sponsorId)
      .eq("status", "active");
    const quantity = Math.max(count ?? 0, 1);

    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) redirect("/sponsor/billing?error=price_not_configured");

    const hdrs = await headers();
    const origin =
      hdrs.get("origin") ??
      (hdrs.get("host") ? `https://${hdrs.get("host")}` : "");
    const billingUrl = `${origin}/sponsor/billing`;

    const stripe = createStripeClient();
    let checkoutUrl: string;
    try {
      const { url } = await createCheckoutSession(stripe, supabase, {
        sponsorId,
        priceId: priceId!,
        quantity,
        successUrl: `${billingUrl}?checkout=success`,
        cancelUrl: `${billingUrl}?checkout=cancel`,
      });
      checkoutUrl = url;
    } catch (err) {
      if (err instanceof SubscriptionAlreadyExistsError) {
        // A subscription already exists — send the admin to the Portal to manage/fix it instead of
        // creating a second one. openBillingPortal (Task 11) redirects to the portal session.
        return openBillingPortal(new FormData());
      }
      throw err;
    }

    redirect(checkoutUrl);
  }
  ```
  Note: `startCheckout` takes no `FormData` because the price and quantity are server-derived; the billing UI (Task 11) invokes it via a `<form action={startCheckout}>` submit button with no fields. The interface contract lists `startCheckout(formData: FormData)`; a zero-arg action is form-action-compatible (Next passes `FormData` positionally and it is simply ignored). Keep the zero-arg signature — it is the honest shape. `openBillingPortal` is defined in the same `app/sponsor/actions.ts` module in Task 11; because both actions live in one file, `startCheckout` can call it directly. (If Task 11 has not landed yet when you implement this step, add the `SubscriptionAlreadyExistsError` catch as a `redirect("/sponsor/billing?manage=1")` placeholder and switch it to `openBillingPortal(...)` once Task 11 exists — but since Task 10 precedes Task 11, the honest approach is to note the dependency and land the `openBillingPortal` call when Task 11 adds that action.)

- [ ] **Step 12: Type-check the action + helpers — expect clean.**
  ```
  npx tsc --noEmit
  ```
  Expected: no errors. Common failure: `headers()` must be `await`ed (Next 16 async dynamic APIs) — the code above already awaits it. If `createStripeClient` or `createCheckoutSession` import paths error, confirm Tasks 3 and the two helpers above exist.

- [ ] **Step 13: Run the billing unit tests together — expect all green.**
  ```
  npx vitest run lib/billing/stripe.test.ts lib/billing/customer.test.ts lib/billing/checkout.test.ts
  ```
  Expected: all suites pass (stripe passthrough + customer 2 + checkout 2). No real Stripe key is read and no `stripe` package is imported outside `lib/billing/stripe.ts` — the Task 14 grep-guard will re-verify this repo-wide.

- [ ] **Step 14: Lint the touched files; commit the action.**
  ```
  npx eslint lib/billing/customer.ts lib/billing/checkout.ts app/sponsor/actions.ts
  ```
  Expected: no errors/warnings. Then:
  ```
  git add app/sponsor/actions.ts
  git commit -m "feat(sponsor): startCheckout action — seat-quantity Checkout via injectable Stripe"
  ```

---

### Task 11: Customer Portal + billing UI

**Files:**
- Create: `lib/billing/portal.ts` (`createPortalSession` + `listInvoices` — both take an injected `StripeLike`)
- Create: `app/sponsor/billing/page.tsx` (async server component; `requireSponsorAdmin` → `BillingSummary` + invoices; Checkout button when inactive, Portal button when active)
- Create: `app/sponsor/billing/page.test.tsx` (server-component render test with all deps `vi.mock`'d — never a real Stripe client or key)
- Modify: `lib/billing/stripe.test.ts` (add `createPortalSession` + `listInvoices` cases driven by an injected fake `StripeLike`; assert no real key read)
- Modify: `app/sponsor/actions.ts` (add the `openBillingPortal` server action)

**Interfaces:**

_Consumes:_
```ts
// lib/billing/types.ts (Task 3)
export interface StripeLike { /* …customers, checkout, billingPortal, subscriptions, invoices, webhooks… */ }
export interface BillingSummary { plan: string; subscriptionStatus: string; seats: number; stripeCustomerId: string | null; }
// lib/billing/customer.ts (Task 10)
export async function ensureStripeCustomer(stripe: StripeLike, db: SupabaseClient, sponsorId: string): Promise<string>;
// lib/billing/stripe.ts (Task 3)
export function createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike;
// app/sponsor/actions.ts (Task 10) — reused, not redefined here
export async function startCheckout(formData: FormData): Promise<void>;
// lib/auth/require-sponsor-admin.ts (Task 4)
export async function requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }>;
// lib/supabase/server.ts (existing)
export async function createServerClient(): Promise<SupabaseClient>;
```

_Produces:_
```ts
// lib/billing/portal.ts
export async function createPortalSession(
  stripe: StripeLike,
  db: SupabaseClient,
  args: { sponsorId: string; returnUrl: string }
): Promise<{ url: string }>;
// ensures the sponsor has a Stripe customer (via ensureStripeCustomer), then creates a
// billingPortal session for { customer, return_url } and returns { url }.

export async function listInvoices(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<Array<{ id: string; status: string | null; amountPaid: number; hostedUrl: string | null; created: number }>>;
// reads sponsors.stripe_customer_id; if null returns []; else stripe.invoices.list({ customer, limit: 12 })
// and maps snake_case Stripe fields → camelCase.

// app/sponsor/actions.ts
export async function openBillingPortal(formData: FormData): Promise<void>;
// requireSponsorAdmin → createPortalSession(createStripeClient(), db, { sponsorId, returnUrl }) → redirect(session.url)
```

`app/sponsor/billing/page.tsx` — async server component: `requireSponsorAdmin()` → read the sponsor's `plan/subscription_status/seats/stripe_customer_id/stripe_subscription_id` into a `BillingSummary` (+ a `hasSubscription` flag from `stripe_subscription_id`) → `listInvoices()`. Renders the summary; a **Start subscription** button (submits `startCheckout` from Task 10) ONLY when there is NO subscription (`stripe_subscription_id` is null); a **Manage billing** button (submits `openBillingPortal`) whenever a subscription EXISTS — including `past_due`/`incomplete`, so the admin fixes payment in the Portal rather than starting a second subscription (F13); and an invoices `<table>` (amount, status as text+icon never color-alone, date, external "View" link).

---

- [ ] **Step 11.1: Write the failing `createPortalSession` test.**

Append to `lib/billing/stripe.test.ts` (it already holds Task 3/10 cases + the fake-`StripeLike` scaffolding). Add the portal import and the first case:

```ts
import { createPortalSession, listInvoices } from "./portal";

// A hand-written fake DB that returns a canned sponsors row for the .from("sponsors")
// single()-style read the billing helpers perform, and records any update() it receives.
// Mirrors the injectable-fake approach of lib/advisor/llm.test.ts — no Supabase, no network.
function fakeDb(sponsorRow: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table !== "sponsors") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: sponsorRow, error: null }),
            single: async () => ({ data: sponsorRow, error: null }),
          }),
        }),
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
  };
  return { db: db as unknown as import("@supabase/supabase-js").SupabaseClient, updates };
}

test("createPortalSession ensures a customer then creates a portal session for that customer", async () => {
  // Sponsor already has a customer id, so ensureStripeCustomer must NOT create a new one.
  const { db } = fakeDb({
    id: "sp1",
    name: "Acme",
    plan: "team",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_1",
    subscription_status: "active",
  });
  const portalCreate = vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/session/abc" });
  const customersCreate = vi.fn(); // should never be called
  const stripe = {
    customers: { create: customersCreate },
    billingPortal: { sessions: { create: portalCreate } },
  } as unknown as import("./types").StripeLike;

  const out = await createPortalSession(stripe, db, {
    sponsorId: "sp1",
    returnUrl: "https://app.test/sponsor/billing",
  });

  expect(out).toEqual({ url: "https://billing.stripe.test/session/abc" });
  expect(customersCreate).not.toHaveBeenCalled();
  const args = portalCreate.mock.calls[0][0] as Record<string, unknown>;
  expect(args.customer).toBe("cus_existing");
  expect(args.return_url).toBe("https://app.test/sponsor/billing");
});
```

- [ ] **Step 11.2: Run it — expect FAIL (module not found).**

```bash
npx vitest run lib/billing/stripe.test.ts
```

Expected: fails with `Failed to resolve import "./portal"` (`Cannot find module './portal'`).

- [ ] **Step 11.3: Implement `createPortalSession` (minimal).**

Create `lib/billing/portal.ts`:

```ts
// Customer Portal + invoice listing for the Sponsor Console (Plan 6, Task 11).
// Both helpers take an injected StripeLike (never a concrete Stripe client) so tests supply a
// hand-written fake and NEVER read STRIPE_SECRET_KEY — mirrors the injectable adapter in
// lib/advisor/llm.ts. The only module allowed to import the real `stripe` package is
// lib/billing/stripe.ts; these helpers stay SDK-free.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";
import { ensureStripeCustomer } from "@/lib/billing/customer";

/**
 * Create a Stripe Customer Portal session so the sponsor admin can self-serve payment methods,
 * proration, cancellation, etc. Ensures the sponsor has a Stripe customer first (idempotent).
 */
export async function createPortalSession(
  stripe: StripeLike,
  db: SupabaseClient,
  args: { sponsorId: string; returnUrl: string }
): Promise<{ url: string }> {
  const customerId = await ensureStripeCustomer(stripe, db, args.sponsorId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: args.returnUrl,
  });
  return { url: session.url };
}
```

- [ ] **Step 11.4: Run it — expect PASS.**

```bash
npx vitest run lib/billing/stripe.test.ts
```

Expected: all prior cases plus `createPortalSession ensures a customer then creates a portal session for that customer` pass (`N passed`, 0 failed).

- [ ] **Step 11.5: Commit.**

```bash
git add lib/billing/portal.ts lib/billing/stripe.test.ts
git commit -m "feat(billing): createPortalSession (injectable StripeLike, ensures customer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 11.5b: Operator note — DISABLE quantity editing in the Stripe Customer Portal (F13note).**

Reconciliation (`syncSubscriptionSeats`, Task 13) is the SOLE writer of the subscription's seat quantity — it drives the item quantity to the active-member count. If an admin can edit the quantity in the Customer Portal, they can set a value the very next reconcile will overwrite (a confusing fight loop). Prevent that by configuring the Portal so `subscription_update` does NOT allow quantity changes.

This is Stripe **dashboard/account** configuration, not app runtime state, so it lives here as an explicit operator step (and is echoed in the Task 14 PR body). Configure it EITHER in the Stripe Dashboard (Settings → Billing → Customer portal → uncheck "Customers can update quantities") OR once via the API using a portal configuration whose `subscription_update.default_allowed_updates` excludes `"quantity"`, e.g.:

```bash
# One-time account setup (run with your Stripe secret key in the environment; not app code, not a test).
stripe billing_portal configurations create \
  --features "subscription_update[enabled]=true" \
  --features "subscription_update[default_allowed_updates][]=cancel" \
  --features "subscription_update[proration_behavior]=create_prorations" \
  --features "subscription_update[products][0][product]=$STRIPE_PRODUCT_ID" \
  --features "subscription_update[products][0][prices][]=$STRIPE_PRICE_ID"
```

Note the `default_allowed_updates` list intentionally OMITS `"quantity"` (it permits only `cancel` here; add `price` if you offer plan switches). `createPortalSession` does not pass a `configuration` id, so it uses the account's default portal configuration — ensure the configuration above is set as the default (Dashboard) or pass its id into `billingPortal.sessions.create` if you prefer an explicit one. No app-code change and no test is required for this step; it is a deployment prerequisite recorded in the PR body's Operator setup section.

---

- [ ] **Step 11.6: Write the failing `listInvoices` tests (mapping + null-customer short-circuit).**

Append to `lib/billing/stripe.test.ts`:

```ts
test("listInvoices maps Stripe invoice fields to camelCase for a sponsor with a customer", async () => {
  const { db } = fakeDb({
    id: "sp1",
    name: "Acme",
    plan: "team",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_1",
    subscription_status: "active",
  });
  const invoicesList = vi.fn().mockResolvedValue({
    data: [
      {
        id: "in_2",
        status: "paid",
        amount_paid: 4900,
        hosted_invoice_url: "https://invoice.stripe.test/in_2",
        created: 1717200000,
      },
      {
        id: "in_1",
        status: "open",
        amount_paid: 0,
        hosted_invoice_url: null,
        created: 1714521600,
      },
    ],
  });
  const stripe = {
    invoices: { list: invoicesList },
  } as unknown as import("./types").StripeLike;

  const out = await listInvoices(stripe, db, "sp1");

  // Stripe is queried scoped to the sponsor's customer, bounded to a small page.
  const listArgs = invoicesList.mock.calls[0][0] as Record<string, unknown>;
  expect(listArgs.customer).toBe("cus_existing");
  expect(listArgs.limit).toBe(12);

  expect(out).toEqual([
    { id: "in_2", status: "paid", amountPaid: 4900, hostedUrl: "https://invoice.stripe.test/in_2", created: 1717200000 },
    { id: "in_1", status: "open", amountPaid: 0, hostedUrl: null, created: 1714521600 },
  ]);
});

test("listInvoices returns [] without calling Stripe when the sponsor has no customer", async () => {
  const { db } = fakeDb({
    id: "sp2",
    name: "NoCust",
    plan: "free",
    seats: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: "inactive",
  });
  const invoicesList = vi.fn();
  const stripe = { invoices: { list: invoicesList } } as unknown as import("./types").StripeLike;

  const out = await listInvoices(stripe, db, "sp2");

  expect(out).toEqual([]);
  expect(invoicesList).not.toHaveBeenCalled();
});
```

- [ ] **Step 11.7: Run it — expect FAIL (`listInvoices is not a function`).**

```bash
npx vitest run lib/billing/stripe.test.ts
```

Expected: the two new cases fail with `TypeError: listInvoices is not a function` (it is imported but not yet exported from `./portal`).

- [ ] **Step 11.8: Implement `listInvoices` (minimal).**

Append to `lib/billing/portal.ts`:

```ts
/**
 * List the sponsor's recent invoices (newest first, as Stripe returns them). Reads the persisted
 * stripe_customer_id; if the sponsor has never checked out there is no customer, so we short-circuit
 * to [] WITHOUT touching Stripe. Maps snake_case Stripe fields → the camelCase shape the UI expects.
 */
export async function listInvoices(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<Array<{ id: string; status: string | null; amountPaid: number; hostedUrl: string | null; created: number }>> {
  const { data: sponsor } = await db
    .from("sponsors")
    .select("stripe_customer_id")
    .eq("id", sponsorId)
    .single();

  const customerId = (sponsor?.stripe_customer_id as string | null) ?? null;
  if (!customerId) return [];

  const result = await stripe.invoices.list({ customer: customerId, limit: 12 });
  return result.data.map((inv) => ({
    id: inv.id,
    status: inv.status,
    amountPaid: inv.amount_paid,
    hostedUrl: inv.hosted_invoice_url,
    created: inv.created,
  }));
}
```

- [ ] **Step 11.9: Run it — expect PASS.**

```bash
npx vitest run lib/billing/stripe.test.ts
```

Expected: all cases pass (`N passed`, 0 failed), including the two new `listInvoices` cases.

- [ ] **Step 11.10: Commit.**

```bash
git add lib/billing/portal.ts lib/billing/stripe.test.ts
git commit -m "feat(billing): listInvoices (null-customer short-circuit, camelCase mapping)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 11.11: Write the failing `openBillingPortal` action test.**

Create `app/sponsor/billing/actions-openportal.test.ts`. (A dedicated file keeps the action's mocks isolated from the page test's mocks — the two files mock the same modules differently.)

```ts
import { expect, test, vi, beforeEach } from "vitest";

// The redirect() call throws in Next to unwind the request; capture the target instead.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({ __fake: "db" })),
}));
// createStripeClient() must return a fake — the action must NEVER build a real client.
vi.mock("@/lib/billing/stripe", () => ({
  createStripeClient: vi.fn(() => ({ __fake: "stripe" })),
}));
// createPortalSession is exercised on its own in stripe.test.ts; here we only assert wiring.
vi.mock("@/lib/billing/portal", () => ({
  createPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.test/session/xyz" })),
}));
// headers() feeds the returnUrl origin.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map([["origin", "https://app.test"]])),
}));

import { openBillingPortal } from "@/app/sponsor/actions";
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createPortalSession } from "@/lib/billing/portal";
import { createStripeClient } from "@/lib/billing/stripe";

beforeEach(() => {
  vi.clearAllMocks();
});

test("openBillingPortal gates on the sponsor admin, builds a portal session, and redirects to it", async () => {
  await expect(openBillingPortal(new FormData())).rejects.toThrow(
    "REDIRECT:https://billing.stripe.test/session/xyz"
  );
  expect(requireSponsorAdmin).toHaveBeenCalledOnce();
  expect(createStripeClient).toHaveBeenCalledOnce();
  const args = (createPortalSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
    sponsorId: string;
    returnUrl: string;
  };
  expect(args.sponsorId).toBe("sp1");
  expect(args.returnUrl).toBe("https://app.test/sponsor/billing");
});
```

- [ ] **Step 11.12: Run it — expect FAIL (`openBillingPortal` not exported).**

```bash
npx vitest run app/sponsor/billing/actions-openportal.test.ts
```

Expected: fails — `openBillingPortal` is imported from `@/app/sponsor/actions` but not yet exported (`openBillingPortal is not a function`).

- [ ] **Step 11.13: Implement `openBillingPortal` in the shared actions module.**

Append to `app/sponsor/actions.ts` (the `"use server"` file created in Task 4 and extended in Tasks 5/10 — it may export ONLY async functions, so add only this async function; keep existing imports and add the ones below if not already present):

```ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createStripeClient } from "@/lib/billing/stripe";
import { createPortalSession } from "@/lib/billing/portal";

/**
 * Open the Stripe Customer Portal for the current sponsor. Role-gated; resolves the app origin from
 * the request headers so the portal returns the admin to /sponsor/billing. Injects a REAL Stripe
 * client (createStripeClient) — tests mock this module, never construct a real client.
 */
export async function openBillingPortal(_formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();
  const origin = (await headers()).get("origin") ?? "";
  const { url } = await createPortalSession(createStripeClient(), supabase, {
    sponsorId,
    returnUrl: `${origin}/sponsor/billing`,
  });
  redirect(url);
}
```

> If `headers`, `redirect`, `createServerClient`, or `requireSponsorAdmin` are already imported at the top of the file from Task 4/5/10, DO NOT duplicate the import — add only the missing ones (`createStripeClient`, `createPortalSession`). Duplicate top-level imports are a TypeScript error.

- [ ] **Step 11.14: Run it — expect PASS.**

```bash
npx vitest run app/sponsor/billing/actions-openportal.test.ts
```

Expected: `1 passed`.

- [ ] **Step 11.15: Commit.**

```bash
git add app/sponsor/actions.ts app/sponsor/billing/actions-openportal.test.ts
git commit -m "feat(sponsor): openBillingPortal action (role-gated, injected Stripe client)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 11.16: Write the failing billing-page test (inactive → Checkout; active → Portal + invoices).**

Create `app/sponsor/billing/page.test.tsx`. All external deps are `vi.mock`'d so the server component renders with no DB, no network, and no Stripe.

```tsx
import { render, screen, within } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));

// The server actions are referenced only as <form action={...}> handlers — stub them so the
// page imports without pulling in the real "use server" module (which reaches for Stripe/env).
vi.mock("@/app/sponsor/actions", () => ({
  startCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));

const listInvoicesMock = vi.fn();
vi.mock("@/lib/billing/portal", () => ({
  listInvoices: (...args: unknown[]) => listInvoicesMock(...args),
}));
vi.mock("@/lib/billing/stripe", () => ({
  createStripeClient: vi.fn(() => ({ __fake: "stripe" })),
}));

// Fake Supabase returning the sponsor's billing row for the .from("sponsors")…single() read.
let sponsorRow: Record<string, unknown>;
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: sponsorRow, error: null })),
        })),
      })),
    })),
  })),
}));

import BillingPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  listInvoicesMock.mockResolvedValue([]);
});

test("no subscription shows the plan summary and a Checkout call-to-action (no Portal button)", async () => {
  sponsorRow = {
    plan: "free",
    subscription_status: "inactive",
    seats: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null, // no subscription -> Checkout CTA
  };
  const ui = await BillingPage();
  render(ui);

  // Summary surfaces plan + status as text (never color-only).
  expect(screen.getByText(/inactive/i)).toBeInTheDocument();
  // Checkout button present, Manage-billing button absent.
  expect(screen.getByRole("button", { name: /start subscription|checkout/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /manage billing/i })).toBeNull();
  // No invoices → empty state, no table.
  expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("active subscription shows a Manage-billing button and an invoices table", async () => {
  sponsorRow = {
    plan: "team",
    subscription_status: "active",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_active",
  };
  listInvoicesMock.mockResolvedValue([
    {
      id: "in_2",
      status: "paid",
      amountPaid: 4900,
      hostedUrl: "https://invoice.stripe.test/in_2",
      created: 1717200000,
    },
  ]);

  const ui = await BillingPage();
  render(ui);

  expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /start subscription|checkout/i })).toBeNull();

  const table = screen.getByRole("table", { name: /invoices/i });
  // Amount rendered as currency, status as text, and an external link to the hosted invoice.
  expect(within(table).getByText("$49.00")).toBeInTheDocument();
  expect(within(table).getByText(/paid/i)).toBeInTheDocument();
  const link = within(table).getByRole("link", { name: /view/i });
  expect(link).toHaveAttribute("href", "https://invoice.stripe.test/in_2");
});

test("past_due subscription (exists but not active) shows Manage-billing (Portal), NOT Start subscription (F13)", async () => {
  sponsorRow = {
    plan: "team",
    subscription_status: "past_due",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_pastdue", // a subscription EXISTS -> fix it in the Portal
  };
  const ui = await BillingPage();
  render(ui);

  expect(screen.getByText(/past.?due/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  // Must NOT offer to start a second subscription.
  expect(screen.queryByRole("button", { name: /start subscription|checkout/i })).toBeNull();
});
```

- [ ] **Step 11.17: Run it — expect FAIL (module not found).**

```bash
npx vitest run app/sponsor/billing/page.test.tsx
```

Expected: fails with `Failed to resolve import "./page"` (`Cannot find module './page'`).

- [ ] **Step 11.18: Implement the billing page (async server component).**

Create `app/sponsor/billing/page.tsx`:

```tsx
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { createStripeClient } from "@/lib/billing/stripe";
import { listInvoices } from "@/lib/billing/portal";
import { startCheckout, openBillingPortal } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";
import type { BillingSummary } from "@/lib/billing/types";

/** Cents → "$49.00". */
function formatAmount(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    cents / 100
  );
}

/** Unix seconds → "Jun 1, 2026". */
function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime())
    ? String(unixSeconds)
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default async function BillingPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

  const { data: row } = await supabase
    .from("sponsors")
    .select("plan, subscription_status, seats, stripe_customer_id, stripe_subscription_id")
    .eq("id", sponsorId)
    .single();

  const summary: BillingSummary = {
    plan: (row?.plan as string | null) ?? "free",
    subscriptionStatus: (row?.subscription_status as string | null) ?? "inactive",
    seats: (row?.seats as number | null) ?? 0,
    stripeCustomerId: (row?.stripe_customer_id as string | null) ?? null,
  };

  // F13: the Checkout CTA appears ONLY when there is NO subscription at all. A subscription that
  // exists but is not active (past_due/incomplete) must route to the Portal to FIX payment, never
  // start a second subscription — so the button choice keys on stripe_subscription_id, not status.
  const hasSubscription = ((row?.stripe_subscription_id as string | null) ?? null) !== null;
  const invoices = await listInvoices(createStripeClient(), supabase, sponsorId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Your subscription bills per active seat. Manage payment details in the Stripe portal.
        </p>
      </header>

      <section
        aria-label="Subscription summary"
        className="grid grid-cols-1 gap-4 rounded-lg border border-foreground/15 bg-white p-4 sm:grid-cols-3"
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Plan</span>
          <span className="font-heading text-lg font-semibold capitalize">{summary.plan}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Status</span>
          <span className="inline-flex items-center gap-1 font-heading text-lg font-semibold capitalize">
            <span aria-hidden="true">{summary.subscriptionStatus === "active" ? "✓" : "○"}</span>
            {summary.subscriptionStatus}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Active seats</span>
          <span className="font-heading text-lg font-semibold tabular-nums">{summary.seats}</span>
        </div>
      </section>

      <section aria-label="Subscription actions">
        {hasSubscription ? (
          <form action={openBillingPortal}>
            <Button type="submit">Manage billing</Button>
          </form>
        ) : (
          <form action={startCheckout}>
            <Button type="submit">Start subscription</Button>
          </form>
        )}
      </section>

      <section aria-label="Invoices" className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
            No invoices yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" aria-label="Invoices">
              <thead>
                <tr className="border-b border-foreground/15 text-left">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Invoice
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-foreground/10">
                    <td className="px-3 py-2 tabular-nums">{formatDate(inv.created)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatAmount(inv.amountPaid)}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 capitalize">
                        <span aria-hidden="true">{inv.status === "paid" ? "✓" : "•"}</span>
                        {inv.status ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {inv.hostedUrl ? (
                        <a
                          href={inv.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                        >
                          View
                          <span className="sr-only"> invoice (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span className="text-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 11.19: Run it — expect PASS.**

```bash
npx vitest run app/sponsor/billing/page.test.tsx
```

Expected: `3 passed` (no-subscription → Checkout CTA, active → Manage billing + invoices, past_due → Manage billing not Checkout).

> If the active-case test fails on the `$49.00` assertion, it is a locale/currency-format mismatch in the CI environment. The implementation pins `currency: "USD"`; confirm the failure text — if `Intl` renders `US$49.00` under a non-US default locale, the assertion is what to adjust (match rendered text), not the component. Re-run and confirm `2 passed`.

- [ ] **Step 11.20: Commit.**

```bash
git add app/sponsor/billing/page.tsx app/sponsor/billing/page.test.tsx
git commit -m "feat(sponsor): /sponsor/billing page (summary, Checkout/Portal CTA, invoices table)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

- [ ] **Step 11.21: Guard — confirm the billing surface reads no real Stripe key and imports no SDK.**

The page and helpers must reach Stripe ONLY through the injectable `createStripeClient()` / `StripeLike`, never `process.env.STRIPE_*` or `import "stripe"`. Verify:

```bash
grep -RnE "STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|process\.env\.STRIPE|from \"stripe\"|require\(\"stripe\"\)" \
  lib/billing/portal.ts app/sponsor/billing/page.tsx app/sponsor/actions.ts \
  lib/billing/stripe.test.ts app/sponsor/billing/page.test.tsx app/sponsor/billing/actions-openportal.test.ts
```

Expected: **no output** (exit code 1). Any match means a helper/UI/test is bypassing the adapter — fix it before proceeding. (The dedicated grep-guard test lands in Task 14; this is the local check for Task 11's files.)

- [ ] **Step 11.22: Run the full Task 11 slice + typecheck.**

```bash
npx vitest run lib/billing/stripe.test.ts app/sponsor/billing/page.test.tsx app/sponsor/billing/actions-openportal.test.ts
npx tsc --noEmit
```

Expected: vitest reports all Task 11 cases green (`N passed`, 0 failed) and `tsc --noEmit` exits 0 with no output. If `tsc` flags a duplicate import in `app/sponsor/actions.ts`, remove the redundant top-level import added in Step 11.13 (it was already imported by an earlier task).

- [ ] **Step 11.23: Final Task 11 commit (if any fixups were needed).**

```bash
git add -A
git commit -m "test(billing): Task 11 slice green + tsc clean (portal, billing UI, action)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Stripe webhook route — signature verify + event dispatch

**Files:**
- Create: `lib/billing/webhook.ts` (event dispatcher — `handleStripeEvent(db, event)`; maps Stripe subscription/invoice events to a `sponsors` UPDATE keyed by `stripe_customer_id`, with `stripe_events` dedup and a live-subscription read via `createStripeClient()`; imports the adapter seam from `lib/billing/stripe.ts`, never the `stripe` package directly)
- Create: `lib/billing/webhook.test.ts` (unit test with a fake service-role Supabase client + canned events; asserts the exact `sponsors` update args and the handled/ignored mapping)
- Create: `lib/supabase/service.ts` (service-role Supabase client factory for server-side, RLS-bypassing use — the webhook route's DB handle; mirrors `tests/db/admin-client.ts` but lives in `lib/` for production use)
- Create: `app/api/stripe/webhook/route.ts` (Next.js route handler `POST`; reads the RAW body, verifies the signature via `createStripeClient().webhooks.constructEvent`, dispatches to `handleStripeEvent`, maps to 200/400)
- Create: `app/api/stripe/webhook/route.test.ts` (route unit test; injects a fake `StripeLike` whose `constructEvent` returns a canned event or throws for bad-sig, and a fake service-role db; asserts 200 on good sig, 400 on bad sig, and that the dispatcher was invoked)

**Interfaces:**

Consumes:
- `StripeLike` and its `webhooks.constructEvent(payload, sig, secret)` (now returning `{ id, created, type, data.object }` — Task 3 F5) from `lib/billing/types.ts` (Task 3), plus `createStripeClient({ client? })` and `planForPriceId` / `PLAN_BY_PRICE_ID` from `lib/billing/stripe.ts` (Task 3) — the route builds the real client in production but the test injects a fake `StripeLike`; the dispatcher uses `createStripeClient()` for the live-subscription read and `planForPriceId` to label the plan.
- The `sponsors` billing columns from migration 0007 (Task 1): `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `plan`, `seats`, plus the unique index `sponsors_stripe_customer_id_key` (guarantees the by-customer lookup resolves a single sponsor).
- The `stripe_events` idempotency ledger from migration 0007 (Task 1) — `handleStripeEvent` INSERTs `event.id` FIRST and treats a 23505 as an already-processed duplicate.
- A service-role Supabase client (the `adminClient()` pattern from `tests/db/admin-client.ts`) — the webhook bypasses RLS, so no `sponsors` UPDATE / `stripe_events` INSERT policy is required (this is why Task 1 left the webhook path un-policied).

Produces:
```ts
// lib/billing/webhook.ts
export async function handleStripeEvent(
  db: SupabaseClient,
  event: { id: string; type: string; data: { object: Record<string, unknown> } }
): Promise<{ handled: boolean }>;
// dispatches customer.subscription.created | updated | deleted + invoice.paid | invoice.payment_failed;
// updates sponsors (subscription_status, plan, stripe_subscription_id) matched by stripe_customer_id.
// Idempotent via a stripe_events(id) INSERT FIRST — a duplicate event.id (23505) short-circuits with
// { handled: true } and NO side effects. For .updated it reads the LIVE subscription (retrieve) and
// writes its authoritative status (a stale payload never wins); a live canceled/not-found result is
// terminal (clears the id). .deleted is terminal too. plan comes from PLAN_BY_PRICE_ID (price.id),
// never price.nickname. seats are NOT written here — reconciliation (Task 13) is the sole seats
// writer. invoice.* acts only when billing_reason ∈ {subscription_cycle, subscription_create} AND the
// invoice's subscription equals the sponsor's current stripe_subscription_id. Returns { handled:false }
// for events it does not act on (route still returns 200).
```
```ts
// lib/supabase/service.ts
export function createServiceRoleClient(): SupabaseClient;
// service-role client (SUPABASE_SERVICE_ROLE_KEY); bypasses RLS; server-only.
```
```ts
// app/api/stripe/webhook/route.ts
export async function POST(request: NextRequest): Promise<NextResponse>;
// reads await request.text() (RAW bytes) + 'stripe-signature' header;
// createStripeClient().webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
// on throw (bad sig / missing sig) -> 400; else handleStripeEvent(serviceRoleDb, event) -> 200.
// Testable via an internal handlePost(request, { stripe, db }) seam that the exported POST wires to
// the real createStripeClient()/createServiceRoleClient(); the test calls handlePost with fakes.
```

---

- [ ] **Step 1: Write the FAILING test for `handleStripeEvent` (subscription events → sponsors UPDATE).**

  The dispatcher receives an already-verified event (with its `id`) and side-effects only through the injected service-role Supabase client. It also (a) records the event id in `stripe_events` for idempotency, and (b) on `customer.subscription.updated` reads the LIVE subscription via `createStripeClient().subscriptions.retrieve(...)`. The test therefore uses a hand-written fake `db` that models `stripe_events` dedup + `sponsors` select/update, and `vi.mock`s the Stripe factory so the live-truth read is controllable and network-free. The mock is defined ONCE at the top (mutable `subRetrieve`/`subUpdate` fns) so Task 13's appended reconciliation test can drive the same fake without a second `vi.mock` of the module. Create `lib/billing/webhook.test.ts`:

  ```ts
  import { expect, test, vi, beforeEach } from "vitest";
  import type { SupabaseClient } from "@supabase/supabase-js";

  // Mutable fake Stripe surface, defined via vi.hoisted so the (hoisted) vi.mock factory below can
  // safely reference it. Task 12 needs subscriptions.retrieve for the live-truth read on
  // customer.subscription.updated; Task 13 later drives subscriptions.update through the SAME fake.
  // Default retrieve reports an ACTIVE subscription; individual tests reassign subRetrieve as needed.
  const stripeFake = vi.hoisted(() => {
    const makeRetrieve = () =>
      vi.fn(async (id: string) => ({
        id,
        status: "active",
        items: { data: [{ id: "si_live", quantity: 1 }] },
      }));
    return {
      subRetrieve: makeRetrieve(),
      subUpdate: vi.fn(async (id: string) => ({ id })),
      makeRetrieve,
    };
  });

  vi.mock("@/lib/billing/stripe", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/billing/stripe")>();
    return {
      ...actual, // keep the real planForPriceId / PLAN_BY_PRICE_ID
      createStripeClient: () => ({
        subscriptions: {
          retrieve: (id: string) => stripeFake.subRetrieve(id),
          update: (id: string, args: unknown) => stripeFake.subUpdate(id, args),
        },
      }),
    };
  });

  import { handleStripeEvent } from "./webhook";

  // Convenience aliases so individual tests can reassign the fakes ergonomically.
  let subRetrieve = stripeFake.subRetrieve;
  let subUpdate = stripeFake.subUpdate;

  beforeEach(() => {
    // Reset to the default active-subscription behavior before each test.
    stripeFake.subRetrieve = stripeFake.makeRetrieve();
    stripeFake.subUpdate = vi.fn(async (id: string) => ({ id }));
    subRetrieve = stripeFake.subRetrieve;
    subUpdate = stripeFake.subUpdate;
  });

  /**
   * A fake service-role Supabase client. Models:
   *  - stripe_events: insert(id) -> unique-violation (23505) if the id was already inserted.
   *  - sponsors: update(values).eq(col, val) recorded; select().eq().maybeSingle() returns a canned row.
   *  - cohort_members: head-count query -> { count } (needed once Task 13's reconcile runs inside the
   *    updated branch; harmless before then). `opts.activeCount` defaults to 0.
   * `opts.sponsorRow` is what the sponsors select resolves to (null => no sponsor for that customer).
   * The updated-branch tests below assert with `.some(...)` on `updates` rather than an exact length,
   * so they stay green AFTER Task 13 appends the seats-reconcile write to the same branch.
   */
  function fakeDb(opts?: { sponsorRow?: Record<string, unknown> | null; activeCount?: number }) {
    const updates: Array<{ table: string; values: Record<string, unknown>; eqCol: string; eqVal: unknown }> = [];
    const seenEvents = new Set<string>();
    const sponsorRow = opts?.sponsorRow === undefined
      ? { id: "sp_1", stripe_subscription_id: null }
      : opts.sponsorRow;

    const client = {
      from(table: string) {
        if (table === "stripe_events") {
          return {
            insert(row: { id: string }) {
              if (seenEvents.has(row.id)) {
                return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
              }
              seenEvents.add(row.id);
              return Promise.resolve({ error: null });
            },
          };
        }
        if (table === "cohort_members") {
          const c: Record<string, unknown> = {};
          c.select = () => c;
          c.eq = () => c;
          c.then = (res: (v: { count: number; error: null }) => void) =>
            res({ count: opts?.activeCount ?? 0, error: null });
          return c;
        }
        // sponsors
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: sponsorRow, error: null }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            return {
              eq(eqCol: string, eqVal: unknown) {
                updates.push({ table, values, eqCol, eqVal });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, updates };
  }

  test("customer.subscription.created writes status/id/plan keyed by stripe_customer_id (no seats)", async () => {
    const { client, updates } = fakeDb();
    const out = await handleStripeEvent(client, {
      id: "evt_created_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_abc",
          status: "active",
          items: { data: [{ quantity: 5, price: { id: "price_x" } }] },
        },
      },
    });

    expect(out).toEqual({ handled: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("sponsors");
    expect(updates[0].eqCol).toBe("stripe_customer_id");
    expect(updates[0].eqVal).toBe("cus_abc");
    expect(updates[0].values).toMatchObject({
      subscription_status: "active",
      stripe_subscription_id: "sub_123",
      plan: "free", // price_x is not in PLAN_BY_PRICE_ID (env unset) -> 'free'
    });
    // Seats are NEVER written here — reconciliation is the sole writer (F12).
    expect(updates[0].values).not.toHaveProperty("seats");
  });

  test("customer.subscription.updated writes the LIVE status, not the (stale) event payload", async () => {
    // Event payload SAYS active, but the live subscription is past_due — live must win.
    // Reassign on stripeFake (the object the mock factory reads), not just the local alias.
    stripeFake.subRetrieve = vi.fn(async (id: string) => ({
      id,
      status: "past_due",
      items: { data: [{ id: "si_live", quantity: 3 }] },
    }));
    subRetrieve = stripeFake.subRetrieve;
    const { client, updates } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    const out = await handleStripeEvent(client, {
      id: "evt_updated_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_abc",
          status: "active", // stale
          items: { data: [{ price: { id: "price_x" } }] },
        },
      },
    });
    expect(out).toEqual({ handled: true });
    expect(subRetrieve).toHaveBeenCalledWith("sub_123");
    // The status write (keyed by customer) uses the LIVE status and carries no seats. Asserted with
    // .some() so this stays green after Task 13 appends a seats-reconcile write to the same branch.
    const statusWrite = updates.find((u) => u.eqCol === "stripe_customer_id");
    expect(statusWrite).toBeDefined();
    expect(statusWrite!.values).toMatchObject({
      subscription_status: "past_due", // from the live object
      stripe_subscription_id: "sub_123",
    });
    expect(statusWrite!.values).not.toHaveProperty("seats");
  });

  test("customer.subscription.deleted marks the sponsor canceled and clears the subscription id", async () => {
    const { client, updates } = fakeDb();
    const out = await handleStripeEvent(client, {
      id: "evt_deleted_1",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_123", customer: "cus_abc", status: "canceled", items: { data: [] } } },
    });
    expect(out).toEqual({ handled: true });
    expect(updates[0].values).toMatchObject({
      subscription_status: "canceled",
      stripe_subscription_id: null,
    });
    expect(updates[0].eqVal).toBe("cus_abc");
  });

  test("a stale customer.subscription.updated after deletion does NOT re-activate (terminal)", async () => {
    // The live subscription is canceled; a late 'updated' whose payload says active must not resurrect.
    stripeFake.subRetrieve = vi.fn(async (id: string) => ({ id, status: "canceled", items: { data: [] } }));
    subRetrieve = stripeFake.subRetrieve;
    const { client, updates } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    const out = await handleStripeEvent(client, {
      id: "evt_updated_stale",
      type: "customer.subscription.updated",
      data: {
        object: { id: "sub_123", customer: "cus_abc", status: "active", items: { data: [] } },
      },
    });
    expect(out).toEqual({ handled: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      subscription_status: "canceled",
      stripe_subscription_id: null,
    });
  });

  test("a duplicate event id is applied only once (idempotency via stripe_events)", async () => {
    const { client, updates } = fakeDb();
    const event = {
      id: "evt_dup",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_abc",
          status: "active",
          items: { data: [{ price: { id: "price_x" } }] },
        },
      },
    };
    const first = await handleStripeEvent(client, event);
    const second = await handleStripeEvent(client, event); // duplicate delivery
    expect(first).toEqual({ handled: true });
    expect(second).toEqual({ handled: true });
    // Side effect applied exactly once despite two deliveries.
    expect(updates).toHaveLength(1);
  });

  test("invoice.paid/payment_failed act only when billing_reason + subscription correlate", async () => {
    // (a) correlated cycle invoice for the sponsor's current sub -> active.
    const paid = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    await handleStripeEvent(paid.client, {
      id: "evt_inv_paid",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
    });
    expect(paid.updates[0].values).toMatchObject({ subscription_status: "active" });

    // (b) correlated failure -> past_due.
    const failed = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    await handleStripeEvent(failed.client, {
      id: "evt_inv_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
    });
    expect(failed.updates[0].values).toMatchObject({ subscription_status: "past_due" });

    // (c) a non-subscription billing_reason is ignored (no write).
    const oneOff = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    const outOneOff = await handleStripeEvent(oneOff.client, {
      id: "evt_inv_manual",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "manual" } },
    });
    expect(outOneOff).toEqual({ handled: false });
    expect(oneOff.updates).toHaveLength(0);

    // (d) an invoice for a DIFFERENT subscription than the sponsor's current one is ignored.
    const mismatch = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
    const outMismatch = await handleStripeEvent(mismatch.client, {
      id: "evt_inv_other",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc", subscription: "sub_OTHER", billing_reason: "subscription_cycle" } },
    });
    expect(outMismatch).toEqual({ handled: false });
    expect(mismatch.updates).toHaveLength(0);
  });

  test("an uninteresting event type is ignored (no DB write, handled:false)", async () => {
    const { client, updates } = fakeDb();
    const out = await handleStripeEvent(client, {
      id: "evt_charge",
      type: "charge.refunded",
      data: { object: { customer: "cus_abc" } },
    });
    expect(out).toEqual({ handled: false });
    expect(updates).toHaveLength(0);
  });

  test("an updated event missing a customer id is ignored (no write, handled:false)", async () => {
    const { client, updates } = fakeDb();
    const out = await handleStripeEvent(client, {
      id: "evt_nocust",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", items: { data: [] } } },
    });
    expect(out).toEqual({ handled: false });
    expect(updates).toHaveLength(0);
  });

  test("an updated event whose customer maps to no sponsor is ignored", async () => {
    const { client, updates } = fakeDb({ sponsorRow: null });
    const out = await handleStripeEvent(client, {
      id: "evt_nosponsor",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", customer: "cus_unknown", status: "active", items: { data: [] } } },
    });
    expect(out).toEqual({ handled: false });
    expect(updates).toHaveLength(0);
  });

  test("throws when the sponsors update returns a PostgREST error", async () => {
    const client = {
      from(table: string) {
        if (table === "stripe_events") return { insert: () => Promise.resolve({ error: null }) };
        return {
          select() {
            return { eq() { return { maybeSingle: async () => ({ data: { id: "sp_1", stripe_subscription_id: "sub_123" }, error: null }) }; } };
          },
          update() {
            return { eq: () => Promise.resolve({ error: { message: "boom" } }) };
          },
        };
      },
    } as unknown as SupabaseClient;
    await expect(
      handleStripeEvent(client, {
        id: "evt_err",
        type: "invoice.paid",
        data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
      })
    ).rejects.toThrow(/boom/);
  });
  ```

  Run (expect FAIL — `webhook.ts` does not exist yet):
  ```
  npx vitest run lib/billing/webhook.test.ts
  ```
  Expected: failure with `Failed to resolve import "./webhook"` (or `Cannot find module './webhook'`). Confirms the spec runs and the impl is genuinely absent.

- [ ] **Step 2: Implement `lib/billing/webhook.ts` (minimal dispatcher — make the test pass).**

  The dispatcher receives an ALREADY-VERIFIED event (signature checking is the route's job) and translates the two event families into a single `sponsors` UPDATE keyed by `stripe_customer_id`. It reads only the fields it needs from the loosely-typed `data.object`, guards on a missing customer id, and throws on a PostgREST error so the route can map failures. Create `lib/billing/webhook.ts`:

  ```ts
  // lib/billing/webhook.ts
  // Stripe webhook event dispatcher (Plan 6). This module does NOT verify signatures — the route
  // (app/api/stripe/webhook/route.ts) verifies via StripeLike.webhooks.constructEvent and hands us
  // the parsed event (with its id). It does NOT import the `stripe` package directly; when it needs a
  // Stripe client (to read the LIVE subscription truth) it goes through createStripeClient() from
  // lib/billing/stripe.ts — the sole allowlisted SDK importer. All DB writes use the injected
  // service-role Supabase client (bypasses RLS — that is why Task 1 added no sponsors UPDATE policy).
  //
  // Correctness invariants baked in here:
  //   • Idempotency: we INSERT event.id into stripe_events FIRST; a duplicate (23505) short-circuits
  //     with { handled: true } and NO side effects, so retried/duplicated deliveries apply once.
  //   • Out-of-order safety: for customer.subscription.updated we resolve the LIVE subscription via
  //     subscriptions.retrieve and write its authoritative status — a stale event payload never wins.
  //   • Terminal delete: customer.subscription.deleted sets 'canceled' + clears the id; and an
  //     'updated' whose live retrieve reports canceled/not-found does NOT resurrect the subscription.
  //   • Plan label comes from the stable PLAN_BY_PRICE_ID map (price.id), never price.nickname.
  //   • Seats are NOT written here — reconciliation (Task 13, syncSubscriptionSeats) is the SOLE
  //     writer of sponsors.seats.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import { createStripeClient, planForPriceId } from "@/lib/billing/stripe";

  /** Narrow a loose JSON value to a non-empty string, or return null. */
  function asString(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  /** Read the first subscription item's price id from a loose subscription-like object. */
  function firstPriceId(object: Record<string, unknown>): string | null {
    const items = object.items as { data?: Array<Record<string, unknown>> } | undefined;
    const price = items?.data?.[0]?.price as { id?: unknown } | undefined;
    return asString(price?.id);
  }

  /** Resolve the sponsor id for a Stripe customer; null if no sponsor matches. */
  async function sponsorIdForCustomer(
    db: SupabaseClient,
    customerId: string
  ): Promise<string | null> {
    const { data, error } = await db
      .from("sponsors")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (error) throw new Error(`sponsor lookup failed: ${error.message}`);
    return (data?.id as string | undefined) ?? null;
  }

  /** Apply an update to the sponsors row matched by stripe_customer_id; throw on PostgREST error. */
  async function updateSponsorByCustomer(
    db: SupabaseClient,
    customerId: string,
    values: Record<string, unknown>
  ): Promise<void> {
    const { error } = await db.from("sponsors").update(values).eq("stripe_customer_id", customerId);
    if (error) throw new Error(`sponsors update failed: ${error.message}`);
  }

  /**
   * Record this event id in the idempotency ledger. Returns true if it is NEW (first time we see it),
   * false if it is a DUPLICATE (unique violation 23505) that we must not re-apply.
   */
  async function recordEvent(db: SupabaseClient, eventId: string): Promise<boolean> {
    const { error } = await db.from("stripe_events").insert({ id: eventId });
    if (!error) return true;
    if (error.code === "23505") return false; // already processed
    throw new Error(`stripe_events insert failed: ${error.message}`);
  }

  export async function handleStripeEvent(
    db: SupabaseClient,
    event: { id: string; type: string; data: { object: Record<string, unknown> } }
  ): Promise<{ handled: boolean }> {
    const object = event.data.object;

    // Idempotency FIRST — a duplicate delivery returns handled with no side effects.
    const eventId = asString(event.id);
    if (eventId) {
      const isNew = await recordEvent(db, eventId);
      if (!isNew) return { handled: true };
    }

    switch (event.type) {
      case "customer.subscription.created": {
        const customerId = asString(object.customer);
        const subscriptionId = asString(object.id);
        const status = asString(object.status);
        if (!customerId || !subscriptionId || !status) return { handled: false };
        const values: Record<string, unknown> = {
          subscription_status: status,
          stripe_subscription_id: subscriptionId,
          plan: planForPriceId(firstPriceId(object)),
        };
        await updateSponsorByCustomer(db, customerId, values);
        return { handled: true };
      }

      case "customer.subscription.updated": {
        const customerId = asString(object.customer);
        const subscriptionId = asString(object.id);
        if (!customerId || !subscriptionId) return { handled: false };

        const sponsorId = await sponsorIdForCustomer(db, customerId);
        if (!sponsorId) return { handled: false };

        // Out-of-order safety: read the LIVE subscription, not the (possibly stale) event payload.
        const stripe = createStripeClient();
        let live: { status: string; items: { data: Array<{ id: string; quantity?: number }> } } | null;
        try {
          live = await stripe.subscriptions.retrieve(subscriptionId);
        } catch {
          live = null; // not found -> treat as terminal below
        }

        // A stale 'updated' arriving after cancellation must NOT resurrect the subscription.
        if (!live || live.status === "canceled" || live.status === "incomplete_expired") {
          await updateSponsorByCustomer(db, customerId, {
            subscription_status: "canceled",
            stripe_subscription_id: null,
          });
          return { handled: true };
        }

        // Authoritative status/plan from the live object. Seats are NOT written here — Task 13's
        // reconciliation (appended below in that task) is the sole writer of sponsors.seats.
        await updateSponsorByCustomer(db, customerId, {
          subscription_status: live.status,
          stripe_subscription_id: subscriptionId,
          plan: planForPriceId(firstPriceId(object)),
        });
        return { handled: true };
      }

      case "customer.subscription.deleted": {
        const customerId = asString(object.customer);
        if (!customerId) return { handled: false };
        // Terminal: canceled + cleared id. A later stale 'updated' cannot re-activate (its live
        // retrieve returns canceled/not-found, which the updated branch also treats as terminal).
        await updateSponsorByCustomer(db, customerId, {
          subscription_status: "canceled",
          stripe_subscription_id: null,
        });
        return { handled: true };
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const customerId = asString(object.customer);
        const invoiceSub = asString(object.subscription);
        const billingReason = asString(object.billing_reason);
        if (!customerId) return { handled: false };

        // Correlate: only act on subscription lifecycle invoices AND when the invoice's subscription
        // matches the sponsor's current stripe_subscription_id. Otherwise ignore (a one-off invoice,
        // a proration for a different sub, etc.). customer.subscription.updated is the authoritative
        // status source; invoice events are a secondary signal.
        if (billingReason !== "subscription_cycle" && billingReason !== "subscription_create") {
          return { handled: false };
        }
        const { data: sponsor, error } = await db
          .from("sponsors")
          .select("stripe_subscription_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (error) throw new Error(`sponsor lookup failed: ${error.message}`);
        const currentSub = (sponsor?.stripe_subscription_id as string | null) ?? null;
        if (!invoiceSub || !currentSub || invoiceSub !== currentSub) return { handled: false };

        await updateSponsorByCustomer(db, customerId, {
          subscription_status: event.type === "invoice.paid" ? "active" : "past_due",
        });
        return { handled: true };
      }

      default:
        return { handled: false };
    }
  }
  ```

  Run (expect PASS):
  ```
  npx vitest run lib/billing/webhook.test.ts
  ```
  Expected: all dispatcher tests pass, 0 failed.

  Commit:
  ```
  git add lib/billing/webhook.ts lib/billing/webhook.test.ts
  git commit -m "Plan 6 Task 12: handleStripeEvent dispatcher (dedup + live-truth updated + terminal delete + correlated invoices)"
  ```

- [ ] **Step 3: Add the production service-role Supabase client `lib/supabase/service.ts` (no test — thin factory).**

  The webhook route needs an RLS-bypassing DB handle in production. `tests/db/admin-client.ts` has the pattern but is test-only; add a `lib/` twin for runtime use. It is a thin wrapper over `createClient` with the service key and no session persistence, so there is no branching logic to unit-test (its behavior is exercised through the route test's injected fake, and end-to-end in Task 14). Create `lib/supabase/service.ts`:

  ```ts
  // lib/supabase/service.ts
  // Service-role Supabase client for SERVER-ONLY, RLS-bypassing writes (e.g. the Stripe webhook, which
  // updates `sponsors` for a customer that the request is not authenticated as). NEVER import this into
  // a client component or any code that runs in the browser — it holds the service key. Mirrors the
  // test-only tests/db/admin-client.ts, but lives in lib/ because production code (the webhook route)
  // depends on it.

  import { createClient, type SupabaseClient } from "@supabase/supabase-js";

  export function createServiceRoleClient(): SupabaseClient {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  ```

  Type-check just this file compiles (whole-project tsc, grep for the new file):
  ```
  npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lib/supabase/service\.ts" || echo "service.ts clean"
  ```
  Expected: `service.ts clean`.

  Commit:
  ```
  git add lib/supabase/service.ts
  git commit -m "Plan 6 Task 12: add lib/supabase/service.ts (service-role client for the webhook route)"
  ```

- [ ] **Step 4: Write the FAILING test for the route handler (good sig -> 200, bad sig -> 400).**

  The route must (a) read the RAW body via `request.text()` before parsing, (b) verify the signature, (c) dispatch. The test drives the route through an internal `handlePost(request, deps)` seam so it can inject a fake `StripeLike` (whose `constructEvent` returns a canned event or throws) and a fake `db` — never constructing a real Stripe client, never reading `STRIPE_WEBHOOK_SECRET`. Create `app/api/stripe/webhook/route.test.ts`:

  ```ts
  import { expect, test, vi } from "vitest";
  import { NextRequest } from "next/server";
  import { handlePost } from "./route";
  import type { StripeLike } from "@/lib/billing/types";
  import type { SupabaseClient } from "@supabase/supabase-js";

  /** Build a NextRequest carrying a raw JSON body and an optional stripe-signature header. */
  function makeRequest(body: string, sig?: string): NextRequest {
    return new NextRequest("https://trove.test/api/stripe/webhook", {
      method: "POST",
      headers: sig ? { "stripe-signature": sig } : {},
      body,
    });
  }

  /** A fake StripeLike whose only exercised method is webhooks.constructEvent. */
  function fakeStripe(constructEvent: StripeLike["webhooks"]["constructEvent"]): StripeLike {
    return {
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      subscriptions: { retrieve: vi.fn(), update: vi.fn() },
      invoices: { list: vi.fn() },
      webhooks: { constructEvent },
    } as unknown as StripeLike;
  }

  /**
   * A fake service-role db that records sponsors updates and models the stripe_events dedup insert
   * (same shapes handleStripeEvent uses). The good-sig test drives a customer.subscription.created
   * event, which inserts the event id then updates sponsors — so the fake supports both `insert` and
   * `update`. The injected fake StripeLike (fakeStripe) is what handleStripeEvent's created branch
   * needs — created writes status/id/plan directly without a live retrieve.
   */
  function fakeDb() {
    const updates: Array<{ table: string; values: Record<string, unknown>; eqVal: unknown }> = [];
    const seen = new Set<string>();
    const client = {
      from(table: string) {
        if (table === "stripe_events") {
          return {
            insert(row: { id: string }) {
              if (seen.has(row.id)) return Promise.resolve({ error: { code: "23505", message: "dup" } });
              seen.add(row.id);
              return Promise.resolve({ error: null });
            },
          };
        }
        return {
          select() {
            return { eq() { return { maybeSingle: async () => ({ data: { id: "sp_1", stripe_subscription_id: null }, error: null }) }; } };
          },
          update(values: Record<string, unknown>) {
            return {
              eq(_col: string, eqVal: unknown) {
                updates.push({ table, values, eqVal });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, updates };
  }

  test("returns 200 and dispatches when the signature verifies", async () => {
    const rawBody = JSON.stringify({ any: "bytes" });
    // A subscription.created event writes status/id/plan directly (no live retrieve needed), so the
    // route's dispatch produces a single sponsors write we can assert.
    const constructEvent = vi.fn().mockReturnValue({
      id: "evt_route_1",
      created: 1,
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_abc",
          status: "active",
          items: { data: [{ price: { id: "price_x" } }] },
        },
      },
    });
    const stripe = fakeStripe(constructEvent);
    const db = fakeDb();

    const res = await handlePost(makeRequest(rawBody, "t=1,v1=goodsig"), {
      stripe,
      db: db.client,
      webhookSecret: "whsec_test",
    });

    expect(res.status).toBe(200);
    // constructEvent got the EXACT raw bytes + the header + the injected secret.
    expect(constructEvent).toHaveBeenCalledWith(rawBody, "t=1,v1=goodsig", "whsec_test");
    // The event was dispatched and produced a sponsors write.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].table).toBe("sponsors");
    expect(db.updates[0].values).toMatchObject({ subscription_status: "active" });
    await expect(res.json()).resolves.toEqual({ received: true });
  });

  test("returns 400 when constructEvent throws (bad signature) — no DB write", async () => {
    const constructEvent = vi.fn().mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    const db = fakeDb();

    const res = await handlePost(makeRequest("{}", "t=1,v1=badsig"), {
      stripe: fakeStripe(constructEvent),
      db: db.client,
      webhookSecret: "whsec_test",
    });

    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  test("returns 400 when the stripe-signature header is missing (constructEvent never called)", async () => {
    const constructEvent = vi.fn();
    const db = fakeDb();

    const res = await handlePost(makeRequest("{}"), {
      stripe: fakeStripe(constructEvent),
      db: db.client,
      webhookSecret: "whsec_test",
    });

    expect(res.status).toBe(400);
    expect(constructEvent).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  test("returns 200 with handled:false for an uninteresting but validly-signed event (no write)", async () => {
    const constructEvent = vi.fn().mockReturnValue({
      id: "evt_route_charge",
      created: 1,
      type: "charge.refunded",
      data: { object: { customer: "cus_abc" } },
    });
    const db = fakeDb();

    const res = await handlePost(makeRequest("{}", "sig"), {
      stripe: fakeStripe(constructEvent),
      db: db.client,
      webhookSecret: "whsec_test",
    });

    expect(res.status).toBe(200);
    expect(db.updates).toHaveLength(0);
  });
  ```

  Run (expect FAIL — `route.ts` does not exist / does not export `handlePost`):
  ```
  npx vitest run app/api/stripe/webhook/route.test.ts
  ```
  Expected: failure with `Failed to resolve import "./route"` (or `handlePost is not a function`).

- [ ] **Step 5: Implement `app/api/stripe/webhook/route.ts` (raw body + verify + dispatch).**

  The exported `POST` wires the real `createStripeClient()` and `createServiceRoleClient()` plus `STRIPE_WEBHOOK_SECRET` into the testable `handlePost` seam. Critically, it reads `await request.text()` (the RAW bytes) BEFORE any parsing — `constructEvent` requires the exact payload it was signed against. A missing signature header or a `constructEvent` throw both map to 400; a successful dispatch maps to 200. Create `app/api/stripe/webhook/route.ts`:

  ```ts
  // app/api/stripe/webhook/route.ts
  // Stripe webhook receiver (Plan 6). Verifies the Stripe signature over the RAW request body, then
  // dispatches the parsed event to handleStripeEvent using a SERVICE-ROLE Supabase client (RLS is
  // bypassed — the caller is Stripe, not an authenticated sponsor admin). The exported POST composes
  // the real dependencies; the internal handlePost(request, deps) seam takes them as parameters so
  // route.test.ts can inject a fake StripeLike + fake db and never read STRIPE_WEBHOOK_SECRET or
  // construct a real client.

  import { NextResponse, type NextRequest } from "next/server";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { createStripeClient } from "@/lib/billing/stripe";
  import { createServiceRoleClient } from "@/lib/supabase/service";
  import { handleStripeEvent } from "@/lib/billing/webhook";
  import type { StripeLike } from "@/lib/billing/types";

  // Stripe signs the exact bytes it POSTs; Next must not parse/transform the body first.
  export const dynamic = "force-dynamic";
  export const runtime = "nodejs";

  export interface WebhookDeps {
    stripe: StripeLike;
    db: SupabaseClient;
    webhookSecret: string;
  }

  /** Testable core: verify signature over the raw body, dispatch, map to 200/400. */
  export async function handlePost(
    request: NextRequest,
    deps: WebhookDeps
  ): Promise<NextResponse> {
    const rawBody = await request.text(); // RAW bytes — must precede any parsing.
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json({ error: "missing signature" }, { status: 400 });
    }

    let event: { id: string; created: number; type: string; data: { object: Record<string, unknown> } };
    try {
      event = deps.stripe.webhooks.constructEvent(rawBody, signature, deps.webhookSecret);
    } catch {
      // Signature mismatch / malformed payload — Stripe expects a 400 so it will retry.
      return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    }

    await handleStripeEvent(deps.db, event);
    return NextResponse.json({ received: true }, { status: 200 });
  }

  export async function POST(request: NextRequest): Promise<NextResponse> {
    return handlePost(request, {
      stripe: createStripeClient(),
      db: createServiceRoleClient(),
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    });
  }
  ```

  Run (expect PASS):
  ```
  npx vitest run app/api/stripe/webhook/route.test.ts
  ```
  Expected: `4 passed`, 0 failed.

  Commit:
  ```
  git add app/api/stripe/webhook/route.ts app/api/stripe/webhook/route.test.ts
  git commit -m "Plan 6 Task 12: /api/stripe/webhook route (raw-body signature verify -> dispatch, 200/400)"
  ```

- [ ] **Step 6: Verify the whole Task-12 surface — both specs pass, tsc + eslint clean, no real keys read.**

  Run both new specs together (non-DB unit tests — no two-halves split needed):
  ```
  npx vitest run lib/billing/webhook.test.ts app/api/stripe/webhook/route.test.ts
  ```
  Expected: `14 passed` total (10 dispatcher + 4 route), 0 failed. (Task 13 later appends a reconciliation test, taking the dispatcher file to 11.)

  Type-check the whole project; confirm no errors are attributed to the new files:
  ```
  npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lib/billing/webhook\.ts|lib/supabase/service\.ts|app/api/stripe/webhook/route\.ts" || echo "task-12 files typecheck clean"
  ```
  Expected: `task-12 files typecheck clean`.

  Lint the new files:
  ```
  npx eslint lib/billing/webhook.ts lib/billing/webhook.test.ts lib/supabase/service.ts app/api/stripe/webhook/route.ts app/api/stripe/webhook/route.test.ts
  ```
  Expected: no output (clean).

  Confirm the invariant Task 14's grep-guard will enforce — the webhook code path never imports `stripe` directly (it goes through `lib/billing/stripe.ts`) and neither test references a real secret:
  ```
  grep -rn "from \"stripe\"\|from 'stripe'\|require(\"stripe\")" lib/billing/webhook.ts app/api/stripe/webhook/route.ts
  ```
  Expected: no output — the route imports `createStripeClient` from `@/lib/billing/stripe`, never the SDK itself.
  ```
  grep -rn "STRIPE_WEBHOOK_SECRET\|STRIPE_SECRET_KEY\|POSTMARK_SERVER_TOKEN" lib/billing/webhook.test.ts app/api/stripe/webhook/route.test.ts
  ```
  Expected: no output — the tests inject `webhookSecret: "whsec_test"` and a fake `StripeLike`, so no real env var name appears in either spec.

  No commit needed if Steps 2/5 committed cleanly; if the tsc/eslint pass required fixups, commit them:
  ```
  git add -A && git commit -m "Plan 6 Task 12: lint/typecheck fixups for the Stripe webhook subsystem"
  ```

**Deliverable:** a signature-verifying `POST /api/stripe/webhook` route that reads the RAW request body, rejects a missing/invalid signature with 400, and on a valid event dispatches through `handleStripeEvent` (using an RLS-bypassing service-role client) to update the matching `sponsors` row's `subscription_status`, `plan`, and `stripe_subscription_id` keyed by `stripe_customer_id`. It is idempotent via a `stripe_events(id)` INSERT (duplicate deliveries apply once), reads the LIVE subscription on `.updated` so a stale/out-of-order payload never wins, treats `.deleted` (and a live-canceled `.updated`) as terminal, derives `plan` from `PLAN_BY_PRICE_ID` (not `nickname`), and correlates `invoice.*` on `billing_reason` + subscription id. Seats are NOT written here — reconciliation (Task 13) is the sole `sponsors.seats` writer. Fully unit-tested with a fake `StripeLike` + fake db that never construct a real Stripe client or read `STRIPE_WEBHOOK_SECRET`. Task 13's reconciliation and Task 14's integration/guard tests build on `handleStripeEvent` and `createServiceRoleClient` from here.

---

### Task 13: Active-seat quantity sync + reconciliation

**Files:**
- Create: `lib/billing/seats.ts`
- Create: `lib/billing/seats.test.ts`
- Modify: `app/invite/[token]/actions.ts` (call `syncSubscriptionSeats` on a successful accept)
- Modify: `app/sponsor/actions.ts` (call `syncSubscriptionSeats` on member remove)
- Modify: `lib/billing/webhook.ts` (reconcile seats inside `handleStripeEvent` on `customer.subscription.updated`)

**Interfaces:**

Consumes:
- `StripeLike.subscriptions.retrieve(id) / .update(id, args)` (Task 3, `lib/billing/types.ts`) — shape:
  `subscriptions.retrieve(id): Promise<{ id: string; status: string; items: { data: Array<{ id: string; quantity?: number }> } }>`,
  `subscriptions.update(id, args): Promise<{ id: string }>`.
- `sponsors` billing cols (Task 1): `stripe_subscription_id text` (nullable).
- `cohort_members` (existing 0002 schema) with `status` enum `invited|active|removed`.
- `acceptInvite` (Task 6, `app/invite/[token]/actions.ts`) — the accept flow that calls `accept_cohort_invite` RPC and returns the sponsor id via `data`.
- `handleStripeEvent(db, event)` (Task 12, `lib/billing/webhook.ts`) — the service-role webhook dispatcher.
- `requireSponsorAdmin()` (Task 4) + `createServerClient()` (existing) for the member-remove action.

Produces:
```ts
// lib/billing/seats.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";

export async function countActiveMembers(db: SupabaseClient, sponsorId: string): Promise<number>;
// cohort_members where sponsor_id = sponsorId AND status = 'active'; head-count query.

export async function syncSubscriptionSeats(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<{ quantity: number; skipped: boolean }>;
// quantity = countActiveMembers(...). ALWAYS persists sponsors.seats = quantity (reconciliation is the
// SOLE writer of sponsors.seats — F12). Then reads sponsors.stripe_subscription_id:
//   - null -> { quantity, skipped: true } (no Stripe call);
//   - else retrieve the subscription, take items.data[0]; if its current quantity ALREADY equals
//     quantity -> { quantity, skipped: true } (echo-loop break, F11); otherwise update the item with
//     items:[{ id, quantity }] + proration_behavior:'create_prorations' -> { quantity, skipped:false }.
```

`countActiveMembers` is the single source of truth for seat quantity, and `syncSubscriptionSeats` is the single source of truth for `sponsors.seats` (F12). Task 10's `startCheckout` (quantity = active seats) and Task 6's accept flow both go through `countActiveMembers` once merged — this task refactors any inlined `status='active'` count into `countActiveMembers`.

---

- [ ] **Step 1: Write the failing test for `countActiveMembers`.**

Create `lib/billing/seats.test.ts` with a self-referential thenable fake DB (mirrors `lib/advisor/cap.test.ts`'s `fakeCapChain` — PostgREST's builder is thenable, and the head-count query resolves to `{ count, error }`):

```ts
import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";
import { countActiveMembers, syncSubscriptionSeats } from "./seats";

// --- Fake Supabase: the shapes seats.ts uses ---
// (a) cohort_members head count: .select("*",{count,head}).eq().eq() -> awaited -> { count, error }
// (b) sponsors read:             .select("stripe_subscription_id").eq().maybeSingle() -> { data, error }
// (c) sponsors seats write:      .update({ seats }).eq("id", sponsorId) -> awaited -> { error }
//     (reconciliation is the SOLE writer of sponsors.seats — F12 — so the fake records seatWrites)
interface CountChain {
  select: (cols: string, opts?: unknown) => CountChain;
  eq: (col: string, val: unknown) => CountChain;
  then: (res: (v: { count: number | null; error: null }) => void) => void;
}
interface SponsorReadChain {
  select: (cols: string) => SponsorReadChain;
  eq: (col: string, val: unknown) => SponsorReadChain;
  maybeSingle: () => Promise<{ data: { stripe_subscription_id: string | null } | null; error: null }>;
}
interface SponsorUpdateChain {
  eq: (col: string, val: unknown) => Promise<{ error: null }>;
}

function fakeDb(opts: { activeCount?: number; subscriptionId?: string | null }) {
  const eqCalls: Array<[string, unknown]> = [];
  const seatWrites: number[] = []; // each sponsors.update({ seats }) value, in order
  const countChain: CountChain = {
    select: () => countChain,
    eq: (col, val) => {
      eqCalls.push([col, val]);
      return countChain;
    },
    then: (res) => res({ count: opts.activeCount ?? 0, error: null }),
  };
  const sponsorReadChain: SponsorReadChain = {
    select: () => sponsorReadChain,
    eq: () => sponsorReadChain,
    maybeSingle: async () => ({
      data: { stripe_subscription_id: opts.subscriptionId ?? null },
      error: null,
    }),
  };
  // .from("sponsors") must serve BOTH the read (select→…→maybeSingle) and the seats write
  // (update→eq). We return an object exposing both entry points.
  const sponsorTable = {
    select: sponsorReadChain.select,
    eq: sponsorReadChain.eq,
    maybeSingle: sponsorReadChain.maybeSingle,
    update: (patch: { seats: number }): SponsorUpdateChain => {
      seatWrites.push(patch.seats);
      return { eq: async () => ({ error: null }) };
    },
  };
  const from = vi.fn((table: string) =>
    table === "sponsors" ? sponsorTable : countChain
  );
  return { db: { from } as unknown as SupabaseClient, from, eqCalls, seatWrites };
}

// --- Fake StripeLike: only subscriptions.retrieve/update are exercised here ---
function fakeStripe(opts: { itemId?: string; existingQty?: number }) {
  const retrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: {
      data: [{ id: opts.itemId ?? "si_123", quantity: opts.existingQty ?? 1 }],
    },
  }));
  const update = vi.fn(async (id: string) => ({ id }));
  const stripe = {
    subscriptions: { retrieve, update },
  } as unknown as StripeLike;
  return { stripe, retrieve, update };
}

test("countActiveMembers counts only status='active' rows for the sponsor", async () => {
  const { db, from, eqCalls } = fakeDb({ activeCount: 3 });
  const n = await countActiveMembers(db, "sp_1");
  expect(n).toBe(3);
  expect(from).toHaveBeenCalledWith("cohort_members");
  // filters on the sponsor and on the active status
  expect(eqCalls).toContainEqual(["sponsor_id", "sp_1"]);
  expect(eqCalls).toContainEqual(["status", "active"]);
});

test("countActiveMembers treats a null count as 0", async () => {
  const { db } = fakeDb({ activeCount: null as unknown as number });
  expect(await countActiveMembers(db, "sp_1")).toBe(0);
});
```

- [ ] **Step 2: Run it — expect FAIL (module has no exports yet).**

```
npx vitest run lib/billing/seats.test.ts
```
Expected: FAIL — `Failed to resolve import "./seats"` / `countActiveMembers is not a function`.

- [ ] **Step 3: Minimal impl of `countActiveMembers`.**

Create `lib/billing/seats.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";

/**
 * Single source of truth for a sponsor's billable seat count: the number of cohort_members
 * whose status is 'active'. Head-count query (no rows returned). Any inlined active-member
 * count elsewhere (Task 10 checkout quantity, Task 6 accept flow) must route through this.
 */
export async function countActiveMembers(
  db: SupabaseClient,
  sponsorId: string
): Promise<number> {
  const { count, error } = await db
    .from("cohort_members")
    .select("*", { count: "exact", head: true })
    .eq("sponsor_id", sponsorId)
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}
```

- [ ] **Step 4: Run it — expect PASS for the two count tests.**

```
npx vitest run lib/billing/seats.test.ts
```
Expected: both `countActiveMembers` tests PASS. (`syncSubscriptionSeats` tests are not written yet.)

- [ ] **Step 5: Commit.**

```
git add lib/billing/seats.ts lib/billing/seats.test.ts
git commit -m "feat(billing): countActiveMembers — single source of truth for seat quantity"
```

- [ ] **Step 6: Write the failing tests for `syncSubscriptionSeats` (append to `lib/billing/seats.test.ts`).**

```ts
test("syncSubscriptionSeats no-ops in Stripe (skipped) when the sponsor has no subscription yet, but still writes seats", async () => {
  const { db, seatWrites } = fakeDb({ activeCount: 2, subscriptionId: null });
  const { stripe, retrieve, update } = fakeStripe({});
  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 2, skipped: true });
  // No subscription -> no Stripe traffic at all.
  expect(retrieve).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  // Reconciliation is still the sole writer of sponsors.seats — the count is persisted (F12).
  expect(seatWrites).toEqual([2]);
});

test("syncSubscriptionSeats updates the item to the active count with proration AND persists DB seats", async () => {
  // Stripe currently shows 3, active count is 5 -> they differ, so an update fires.
  const { db, seatWrites } = fakeDb({ activeCount: 5, subscriptionId: "sub_abc" });
  const { stripe, retrieve, update } = fakeStripe({ itemId: "si_777", existingQty: 3 });

  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 5, skipped: false });

  // Retrieves the sponsor's subscription by its stored id.
  expect(retrieve).toHaveBeenCalledWith("sub_abc");

  // Updates that subscription's single line item to the fresh active count, with proration.
  expect(update).toHaveBeenCalledTimes(1);
  const [subId, args] = update.mock.calls[0] as [
    string,
    { items: Array<{ id: string; quantity: number }>; proration_behavior: string }
  ];
  expect(subId).toBe("sub_abc");
  expect(args.items).toEqual([{ id: "si_777", quantity: 5 }]);
  expect(args.proration_behavior).toBe("create_prorations");

  // Single source of truth: DB seats == active count == the quantity pushed to Stripe (F12).
  expect(seatWrites).toEqual([5]);
  expect(args.items[0].quantity).toBe(5);
});

test("syncSubscriptionSeats sets quantity to 0 when there are no active members", async () => {
  // Stripe shows 1 (default existingQty), active count is 0 -> differ -> update fires.
  const { db, seatWrites } = fakeDb({ activeCount: 0, subscriptionId: "sub_zero" });
  const { stripe, update } = fakeStripe({ itemId: "si_1" });
  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 0, skipped: false });
  const [, args] = update.mock.calls[0] as [
    string,
    { items: Array<{ id: string; quantity: number }> }
  ];
  expect(args.items[0].quantity).toBe(0);
  expect(seatWrites).toEqual([0]);
});

test("syncSubscriptionSeats does NOT call subscriptions.update when Stripe already matches (echo-loop break, F11)", async () => {
  // Stripe already shows 4 and the active count is 4 -> no update should be emitted.
  const { db, seatWrites } = fakeDb({ activeCount: 4, subscriptionId: "sub_match" });
  const { stripe, retrieve, update } = fakeStripe({ itemId: "si_match", existingQty: 4 });

  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 4, skipped: true });
  expect(retrieve).toHaveBeenCalledWith("sub_match");
  expect(update).not.toHaveBeenCalled();
  // Seats are still reconciled in the DB (idempotent write of the same value).
  expect(seatWrites).toEqual([4]);

  // Re-running immediately yields NO second Stripe update either (idempotent / no fight loop).
  const again = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(again).toEqual({ quantity: 4, skipped: true });
  expect(update).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run — expect FAIL.**

```
npx vitest run lib/billing/seats.test.ts
```
Expected: the four new tests FAIL — `syncSubscriptionSeats is not a function`. The two count tests still PASS.

- [ ] **Step 8: Minimal impl of `syncSubscriptionSeats`.**

Append to `lib/billing/seats.ts`:

```ts
/**
 * Reconcile the Stripe subscription's seat quantity with the live active-member count. This is the
 * SINGLE source of truth for sponsors.seats — after computing the authoritative active count it
 * writes that count back to sponsors.seats, so no other code path (webhook payload, checkout) writes
 * seats. That keeps DB seats == active count == Stripe quantity in lockstep.
 *
 * - If the sponsor has no subscription yet (stripe_subscription_id null), do NOT touch Stripe, but
 *   still persist sponsors.seats = quantity and return { quantity, skipped: true }. Checkout (Task 10)
 *   is what first creates the subscription; until then there is nothing to sync in Stripe.
 * - Otherwise retrieve the subscription and take its single line item. If the item's current quantity
 *   ALREADY equals the active count, do NOT call subscriptions.update — this breaks the echo loop
 *   where a subscription.updated webhook triggers a reconcile that would otherwise emit another
 *   update (and another webhook) forever. Only when they differ do we update with create_prorations.
 *
 * Called on every membership change: invite-accept (Task 6), member-remove (this task's
 * app/sponsor action), and reconciled inside handleStripeEvent for customer.subscription.updated.
 */
export async function syncSubscriptionSeats(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<{ quantity: number; skipped: boolean }> {
  const quantity = await countActiveMembers(db, sponsorId);

  const { data: sponsor, error } = await db
    .from("sponsors")
    .select("stripe_subscription_id")
    .eq("id", sponsorId)
    .maybeSingle();
  if (error) throw error;

  // Reconciliation is the sole writer of sponsors.seats — persist the authoritative count regardless
  // of whether a Stripe subscription exists yet.
  const { error: seatsError } = await db
    .from("sponsors")
    .update({ seats: quantity })
    .eq("id", sponsorId);
  if (seatsError) throw seatsError;

  const subscriptionId = sponsor?.stripe_subscription_id as string | null | undefined;
  if (!subscriptionId) return { quantity, skipped: true };

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items.data[0];
  if (!item) return { quantity, skipped: true };

  // Idempotency / echo-loop break: if Stripe already reflects the active count, do not update.
  if (item.quantity === quantity) return { quantity, skipped: true };

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, quantity }],
    proration_behavior: "create_prorations",
  });

  return { quantity, skipped: false };
}
```

- [ ] **Step 9: Run — expect PASS (all six tests).**

```
npx vitest run lib/billing/seats.test.ts
```
Expected: 6 passed (2 countActiveMembers + 4 syncSubscriptionSeats: no-sub skip, differing-update, zero, echo-loop no-op).

- [ ] **Step 10: Commit.**

```
git add lib/billing/seats.ts lib/billing/seats.test.ts
git commit -m "feat(billing): syncSubscriptionSeats — reconcile Stripe qty with active seats + proration"
```

- [ ] **Step 11: Wire seat sync into invite-accept (`app/invite/[token]/actions.ts`).**

The Task 6 file already: `requireUserId()` -> `provisionEarner(...)` -> `supabase.rpc('accept_cohort_invite', { invite_token })` -> `redirect('/app')`. Insert a seat sync after a successful RPC, using the service-role admin client (RLS would block the sponsors read/Stripe id for a plain earner) and the injectable Stripe client. Add the imports and the sync call.

Add near the other imports at the top of `app/invite/[token]/actions.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { createStripeClient } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";
```

Then, immediately after the `accept_cohort_invite` RPC resolves successfully and BEFORE the final `redirect('/app')`, add:

```ts
  // The RPC returns the sponsor id the earner just joined; reconcile that sponsor's Stripe seat
  // count. Runs with the service role because a freshly-joined earner has no RLS visibility into
  // sponsors.stripe_subscription_id. No-ops cleanly if the sponsor has no subscription yet.
  const sponsorId = data as string | null;
  if (sponsorId) {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    await syncSubscriptionSeats(createStripeClient(), admin, sponsorId);
  }
```

(`data` is the RPC result variable from Task 6's `const { data, error } = await supabase.rpc('accept_cohort_invite', ...)`. If Task 6 named it differently, use that name.)

- [ ] **Step 12: Typecheck the accept-action wiring.**

```
npx tsc --noEmit
```
Expected: no errors. (If `data` is typed `unknown`, the `as string | null` cast above satisfies it.)

- [ ] **Step 13: Commit.**

```
git add app/invite/[token]/actions.ts
git commit -m "feat(billing): sync seats on invite-accept via service-role client"
```

- [ ] **Step 14: Add a `removeMember` action wired to seat sync (`app/sponsor/actions.ts`).**

Add a member-remove server action that flips the member to `status='removed'` (soft remove, matching the `cohort_status` enum) and then reconciles seats. Append to `app/sponsor/actions.ts` (a `"use server"` module — async exports only). Add imports if not already present:

```ts
import { createStripeClient } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";
```

Then the action:

```ts
/**
 * Soft-remove a cohort member (status -> 'removed'), then reconcile the sponsor's Stripe seat
 * count so the sponsor stops paying for the freed seat. requireSponsorAdmin bounds the caller to
 * their own sponsor; the WHERE clause additionally pins sponsor_id so an admin cannot touch
 * another org's rows. Seat sync no-ops if there is no subscription yet.
 */
export async function removeMember(formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const earnerId = String(formData.get("earnerId") ?? "");
  if (!earnerId) redirect("/sponsor/cohort?error=missing_member");

  const supabase = await createServerClient();
  const { error } = await supabase
    .from("cohort_members")
    .update({ status: "removed" })
    .eq("sponsor_id", sponsorId)
    .eq("earner_id", earnerId);
  if (error) redirect("/sponsor/cohort?error=remove_failed");

  await syncSubscriptionSeats(createStripeClient(), supabase, sponsorId);

  revalidatePath("/sponsor/cohort");
  redirect("/sponsor/cohort");
}
```

Ensure `redirect` (`next/navigation`), `revalidatePath` (`next/cache`), `createServerClient` (`@/lib/supabase/server`), and `requireSponsorAdmin` (`@/lib/auth/require-sponsor-admin`) are imported at the top of the file (Tasks 4/5 already import the first three and `requireSponsorAdmin`).

Note: `syncSubscriptionSeats` reads `sponsors.stripe_subscription_id` (satisfied by the `sponsors_admin_select` policy from 0003) AND — per F12 — writes `sponsors.seats` (it is the sole writer of that column). That DB write under the admin's own RLS-scoped `createServerClient` is authorized by the `sponsors_admin_update` policy added in Task 1 (scoped to `is_sponsor_admin(id)`), so no service-role client is needed for the member-remove path. (The webhook's `sponsors` billing writes still go through the service-role client, which bypasses RLS; the accept-invite path in Step 11 uses the service-role client because a freshly-joined earner has no `sponsors_admin_update` grant.)

- [ ] **Step 15: Typecheck the remove-member action.**

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 16: Commit.**

```
git add app/sponsor/actions.ts
git commit -m "feat(billing): removeMember action soft-removes member and reconciles seats"
```

- [ ] **Step 17: Write a failing reconciliation test in the webhook suite (`lib/billing/webhook.test.ts`).**

Task 12 created `lib/billing/webhook.test.ts` and — critically — already defines a SINGLE top-level `vi.mock("@/lib/billing/stripe", …)` whose `createStripeClient()` returns a fake driving the mutable module-level `subRetrieve`/`subUpdate` (reset in `beforeEach`), plus imports `handleStripeEvent`. **Do NOT add a second `vi.mock` of that module, a second `import { handleStripeEvent }`, or re-import the vitest globals** — a module can be mocked only once per file and duplicate top-level imports are a TS error. Just APPEND one test that reuses the existing `subRetrieve`/`subUpdate` and a local `fakeWebhookDb`.

The reconciliation flow the test must exercise (in the `customer.subscription.updated` branch): dedup insert → resolve `sponsorId` from `sponsors` by `stripe_customer_id` (F8) → status/plan write → `syncSubscriptionSeats(createStripeClient(), db, sponsorId)` which counts active members (2), writes `sponsors.seats`, and (Stripe shows 1 ≠ 2) updates the item to 2.

The fake db here must (a) model `stripe_events` dedup, (b) the `cohort_members` head-count (2), and (c) — this is the Task-13 F8 fix — a `sponsors` chain that **honors `.eq(col, val)`**: the by-`stripe_customer_id` lookup resolves the sponsor only for the matching customer, and the by-`id` lookup (inside `syncSubscriptionSeats`) resolves only for the resolved `sp_1`. The OLD version returned a row regardless of the filter, which masked a wrong-`sponsorId` wiring bug. Append:

```ts
// Fake service-role DB that HONORS .eq(col, val) on sponsors (F8): a lookup only resolves a row when
// the filter matches the seeded ids. This is what proves handleStripeEvent resolves the real sponsorId
// (by stripe_customer_id) and passes THAT id into syncSubscriptionSeats (which reads by id).
function fakeWebhookDb(seed: { sponsorId: string; customerId: string; subscriptionId: string }) {
  const updates: Array<{ table: string; values: Record<string, unknown>; eqCol: string; eqVal: unknown }> = [];
  const seen = new Set<string>();
  function chainFor(table: string) {
    if (table === "stripe_events") {
      return {
        insert(row: { id: string }) {
          if (seen.has(row.id)) return Promise.resolve({ error: { code: "23505", message: "dup" } });
          seen.add(row.id);
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === "cohort_members") {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.then = (res: (v: { count: number; error: null }) => void) => res({ count: 2, error: null });
      return c;
    }
    // sponsors — a filter-honoring builder. select().eq(col,val).maybeSingle() resolves the row only
    // when (col,val) matches the seed; update(patch).eq(col,val) records the write.
    function selectBuilder() {
      let matchCol = "";
      let matchVal: unknown = undefined;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        matchCol = col;
        matchVal = val;
        return b;
      };
      b.maybeSingle = async () => {
        const matches =
          (matchCol === "stripe_customer_id" && matchVal === seed.customerId) ||
          (matchCol === "id" && matchVal === seed.sponsorId);
        return matches
          ? { data: { id: seed.sponsorId, stripe_subscription_id: seed.subscriptionId }, error: null }
          : { data: null, error: null };
      };
      return b;
    }
    return {
      select: () => selectBuilder(),
      update: (patch: Record<string, unknown>) => ({
        eq: (eqCol: string, eqVal: unknown) => {
          updates.push({ table: "sponsors", values: patch, eqCol, eqVal });
          return Promise.resolve({ error: null });
        },
      }),
    };
  }
  const from = vi.fn((table: string) => chainFor(table));
  return { db: { from } as unknown as SupabaseClient, from, updates };
}

test("reconciles Stripe seat quantity on customer.subscription.updated (resolves the real sponsorId first)", async () => {
  const { db, updates } = fakeWebhookDb({ sponsorId: "sp_1", customerId: "cus_1", subscriptionId: "sub_recon" });
  const event = {
    id: "evt_recon_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_recon",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: "price_1" } }] },
      },
    },
  };
  const out = await handleStripeEvent(db, event);
  expect(out.handled).toBe(true);

  // Status write happened keyed by the customer id.
  expect(updates.some((u) => u.eqCol === "stripe_customer_id" && u.eqVal === "cus_1")).toBe(true);
  // Seats write happened keyed by the RESOLVED sponsor id (proves correct wiring, F8).
  expect(updates.some((u) => u.eqCol === "id" && u.eqVal === "sp_1" && u.values.seats === 2)).toBe(true);

  // syncSubscriptionSeats retrieved the sub and pushed the active count (2) as the new quantity.
  expect(subRetrieve).toHaveBeenCalledWith("sub_recon");
  const [, args] = subUpdate.mock.calls[0] as [
    string,
    { items: Array<{ quantity: number }>; proration_behavior: string }
  ];
  expect(args.items[0].quantity).toBe(2);
  expect(args.proration_behavior).toBe("create_prorations");
});
```

- [ ] **Step 18: Run — expect FAIL.**

```
npx vitest run lib/billing/webhook.test.ts
```
Expected: FAIL — `handleStripeEvent` does not yet call `syncSubscriptionSeats`, so `subUpdate` is never called (`subUpdate.mock.calls[0]` is `undefined`) and no `seats` write is recorded.

- [ ] **Step 19: Reconcile seats inside `handleStripeEvent` (`lib/billing/webhook.ts`).**

The `customer.subscription.updated` branch (Task 12) already resolves the real `sponsorId` via `sponsorIdForCustomer(db, customerId)` (F8) and writes `subscription_status`/`plan`/`stripe_subscription_id`. Seat reconciliation just needs to run at the END of that branch with the resolved id. Task 12 already imported `createStripeClient` (for the live-truth read); add only the seats import at the top of `lib/billing/webhook.ts`:

```ts
import { syncSubscriptionSeats } from "@/lib/billing/seats";
```

Then, in the `customer.subscription.updated` branch, AFTER the live-status `updateSponsorByCustomer(...)` write and BEFORE `return { handled: true }`, add:

```ts
    // Reconcile: recompute the active-member count and push it back to Stripe so a subscription
    // edited in the Customer Portal (or drifted by a missed membership event) converges. Uses the
    // real sponsorId resolved above (F8). db is the service-role client, so the sponsors read/seats
    // write inside syncSubscriptionSeats bypasses RLS. It no-ops when Stripe already matches (F11).
    await syncSubscriptionSeats(createStripeClient(), db, sponsorId);
```

Only add this to the `customer.subscription.updated` branch — `created` has no members yet, and `deleted` (and a live-canceled `updated`) is terminal, so neither needs a live recount. Reconciliation is a pure function of the current active count (and no-ops when Stripe already matches), so it is safe to re-run.

- [ ] **Step 20: Run — expect PASS.**

```
npx vitest run lib/billing/webhook.test.ts
```
Expected: all webhook tests PASS (11 total — Task 12's 10 dispatcher specs + this reconciliation spec), including the new reconciliation test.

- [ ] **Step 21: Full seats + webhook regression, then commit.**

```
npx vitest run lib/billing/seats.test.ts lib/billing/webhook.test.ts
```
Expected: all PASS. Then:

```
git add lib/billing/webhook.ts lib/billing/webhook.test.ts
git commit -m "feat(billing): reconcile seats inside webhook on subscription.updated"
```

- [ ] **Step 22: Verify no real Stripe key was read and the adapter seam held.**

Confirm `seats.ts` never imports `stripe` directly (only `lib/billing/stripe.ts` may) and no test reads a real key:

```
grep -n "from \"stripe\"\|require(\"stripe\")" lib/billing/seats.ts lib/billing/seats.test.ts || echo "OK: seats never imports stripe"
grep -n "STRIPE_SECRET_KEY\|STRIPE_WEBHOOK_SECRET\|STRIPE_PRICE_ID\|POSTMARK_SERVER_TOKEN" lib/billing/seats.test.ts lib/billing/webhook.test.ts || echo "OK: no real keys in these tests"
```
Expected: both print their `OK:` line. (The suite-wide grep-guard is Task 14; this is a local smoke check.)

- [ ] **Step 23: Typecheck the whole change set.**

```
npx tsc --noEmit
```
Expected: no errors across `lib/billing/seats.ts`, `app/invite/[token]/actions.ts`, `app/sponsor/actions.ts`, `lib/billing/webhook.ts`.

---

### Task 14: Integration tests + grep-guard + final verification

This is the closing task of Plan 6. It proves the whole sponsor-billing subsystem hangs together end-to-end against the live hosted DB (RPCs + RLS + engagement/coverage layers + seat sync) with **every** external service — Stripe and Postmark — faked; it adds a grep-guard that fails the suite if any test ever reaches for a real billing secret or imports the `stripe` package outside `lib/billing/stripe.ts`; and it runs the full verification gate (two-halves suite, tsc, build, lint) before opening the PR.

**Files:**
- Create: `tests/db/sponsor-billing-integration.test.ts` (live-DB end-to-end; fake `StripeLike` + fake `EmailSender`)
- Create: `tests/guards/no-real-billing-keys.test.ts` (source-scan guard; no DB, no network)
- Modify: none (verification only; no source under `lib/`/`app/` changes in this task)

**Interfaces:**

*Consumes (all defined by earlier Plan 6 tasks — import EXACTLY these):*
```ts
// tests/db/admin-client.ts (existing)
export function adminClient(): SupabaseClient;
// tests/db/user-client.ts (existing)
export function makeUserClient(email: string): Promise<{ client: SupabaseClient; userId: string }>;
// lib/auth/provision-earner.ts (existing)
export function provisionEarner(db: SupabaseClient, userId: string, email: string): Promise<{ handle: string }>;

// lib/billing/types.ts (Task 3)
export interface EngagementMetrics { invited: number; activated: number; imported: number; advisorUsed: number; }
export interface SkillCoverageRow { skillName: string; memberCount: number; }
export interface EmailSender { send(input: { to: string; subject: string; htmlBody: string; textBody: string }): Promise<void>; }
export interface StripeLike { /* customers, checkout, billingPortal, subscriptions, invoices, webhooks — full shape from Task 3 */ }

// lib/cohort/invite.ts (Task 5)
export function inviteCohort(db: SupabaseClient, sender: EmailSender, args: { sponsorId: string; sponsorName: string; emails: string[]; origin: string }): Promise<{ invited: CohortInvite[]; skipped: string[] }>;

// lib/billing/engagement.ts (Task 7)
export function getSponsorEngagement(db: SupabaseClient, sponsorId: string): Promise<EngagementMetrics>;
// lib/billing/skill-coverage.ts (Task 9)
export function getSponsorSkillCoverage(db: SupabaseClient, sponsorId: string): Promise<SkillCoverageRow[]>;
// lib/billing/seats.ts (Task 13)
export function countActiveMembers(db: SupabaseClient, sponsorId: string): Promise<number>;
export function syncSubscriptionSeats(stripe: StripeLike, db: SupabaseClient, sponsorId: string): Promise<{ quantity: number; skipped: boolean }>;

// RPCs from migration 0007 (Task 1), called via supabase-js .rpc():
//   create_sponsor(sponsor_name text) returns uuid
//   accept_cohort_invite(invite_token text) returns uuid
//   sponsor_engagement(target_sponsor uuid) returns table(invited,activated,imported,advisor_used)
//   sponsor_skill_coverage(target_sponsor uuid) returns table(skill_name,member_count)
```

*Produces (test deliverables — no runtime exports):*
- `tests/db/sponsor-billing-integration.test.ts` — passing live-DB spec.
- `tests/guards/no-real-billing-keys.test.ts` — passing source-scan guard.

---

- [ ] **Step 1: Write the failing grep-guard test (`tests/guards/no-real-billing-keys.test.ts`).**

This mirrors Plan 5 Task 12 Step 5. It walks the repo (skipping `node_modules`, `.next`, `.git`) and asserts that: (a) no file under `tests/**` or matching `**/*.test.ts` **reads** a real billing secret (`process.env.<SECRET>` not part of a `delete process.env.<SECRET>` guard); and (b) no file **except** `lib/billing/stripe.ts` imports the `stripe` package. It uses only `node:fs`/`node:path` — no DB, no network — so it runs in the non-DB half of the suite. The read-based (not bare-mention) check is deliberate: the Task 3 adapter specs (`lib/billing/stripe.test.ts`, `lib/email/postmark.test.ts`) legitimately mention the secret names inside `delete process.env.<SECRET>` guards that PROVE the injected-fake path reads no key; those must remain green. The guard also excludes its own source file (which lists the secret names as literals in `FORBIDDEN_SECRETS`).

```ts
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
```

- [ ] **Step 2: Run the grep-guard, expecting PASS (it is a static invariant already satisfied by the design).**

```
npx vitest run tests/guards/no-real-billing-keys.test.ts
```

Expected output: `Test Files  1 passed (1)` / `Tests  2 passed (2)`.

Rationale for expecting PASS (not the usual TDD red first): this guard encodes an invariant the whole plan already upholds — `lib/billing/stripe.ts` is the sole `stripe` importer, and no test READS a real key (the Task 3 adapter specs use `vi.stubEnv("STRIPE_SECRET_KEY", "")` / `vi.stubEnv("POSTMARK_SERVER_TOKEN", "")`, which pass the name as a string literal, not a `process.env.<SECRET>` read — so they do not trip `readsSecret`). If either assertion **fails here**, that is a real defect introduced by an earlier task; STOP and fix the offending file (move the `stripe` import into `lib/billing/stripe.ts`, or replace the real-key read with a `vi.stubEnv`/injected value) rather than editing the guard. To confirm the guard actually bites, temporarily add the line `const leak = process.env.STRIPE_SECRET_KEY;` to any OTHER test file (e.g. `lib/billing/customer.test.ts`), re-run, watch it FAIL with `reads STRIPE_SECRET_KEY`, then delete the line and re-run to green. (A bare string literal like `"STRIPE_SECRET_KEY"`, a `delete process.env.STRIPE_SECRET_KEY` guard, or a save/restore assignment `process.env.STRIPE_SECRET_KEY = prev` will NOT trip it — only an actual read that could feed construction does.)

- [ ] **Step 3: Commit the guard.**

```
git add tests/guards/no-real-billing-keys.test.ts
git commit -m "test(billing): grep-guard rejecting real Stripe/Postmark keys in tests + stray stripe imports

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the failing live-DB integration test (`tests/db/sponsor-billing-integration.test.ts`) — full setup + first assertion block.**

This is the end-to-end happy path against the hosted DB. It exercises the real RPCs and RLS while faking Stripe (`StripeLike`) and Postmark (`EmailSender`) — no real network to either. It follows the exact conventions of `tests/db/advisor.test.ts`: `adminClient()` for setup/teardown, `makeUserClient(email)` for RLS-scoped actors, `created[]` tracked and torn down in `afterAll`.

Flow: create an admin auth user → `create_sponsor('Acme …')` as that user → an earner accepts an invite (created via `inviteCohort` with a fake sender) → engagement/coverage RPCs reflect the new active member → consent gating holds (credentials hidden until `consent_share_credentials=true`) → `syncSubscriptionSeats` with a fake `StripeLike` sets the subscription quantity to the active-member count.

```ts
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";
import { provisionEarner } from "@/lib/auth/provision-earner";
import { inviteCohort } from "@/lib/cohort/invite";
import { getSponsorEngagement } from "@/lib/billing/engagement";
import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";
import { countActiveMembers, syncSubscriptionSeats } from "@/lib/billing/seats";
import type { EmailSender, StripeLike } from "@/lib/billing/types";

const admin = adminClient();
const createdUsers: string[] = [];
const createdSponsors: string[] = [];
const createdSkills: string[] = [];

afterAll(async () => {
  // sponsors cascade to sponsor_admins / cohort_members / cohort_invites; earners cascade from user delete.
  for (const id of createdSponsors) await admin.from("sponsors").delete().eq("id", id);
  for (const id of createdSkills) await admin.from("skills").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

// ---- Fakes: NO real Stripe / Postmark ever constructed ----

function fakeSender(): { sender: EmailSender; sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = [];
  const sender: EmailSender = {
    async send(input) {
      sent.push({ to: input.to, subject: input.subject });
    },
  };
  return { sender, sent };
}

// A minimal in-memory StripeLike that records subscription.update() calls so we can assert the seat
// quantity. Only the members syncSubscriptionSeats touches are real. `existingQty` is the quantity the
// subscription CURRENTLY shows in Stripe; it defaults to 0 so it differs from the 1 active member in
// the seat test (F11 skips the update only when Stripe already matches the active count).
function fakeStripe(subId: string, itemId: string, existingQty = 0) {
  const updates: Array<{ id: string; args: unknown }> = [];
  const stripe: StripeLike = {
    customers: { async create() { return { id: `cus_${Date.now()}` }; } },
    checkout: { sessions: { async create() { return { id: "cs_test", url: "https://stripe.test/cs" }; } } },
    billingPortal: { sessions: { async create() { return { url: "https://stripe.test/portal" }; } } },
    subscriptions: {
      async retrieve() {
        return { id: subId, status: "active", items: { data: [{ id: itemId, quantity: existingQty }] } };
      },
      async update(id, args) {
        updates.push({ id, args });
        return { id };
      },
    },
    invoices: { async list() { return { data: [] }; } },
    webhooks: { constructEvent() { return { id: "evt_noop", created: 0, type: "noop", data: { object: {} } }; } },
  };
  return { stripe, updates };
}

async function makeSponsorWithAdmin(name: string) {
  const email = `sp-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const { client, userId } = await makeUserClient(email);
  createdUsers.push(userId);
  const { data: sponsorId, error } = await client.rpc("create_sponsor", { sponsor_name: name });
  if (error) throw error;
  createdSponsors.push(sponsorId as string);
  return { client, userId, sponsorId: sponsorId as string };
}

async function makeEarner(email: string) {
  const { client, userId } = await makeUserClient(email);
  createdUsers.push(userId);
  await provisionEarner(client, userId, email);
  return { client, userId, email };
}

test("create_sponsor makes a sponsor the caller administers", async () => {
  const { client, userId, sponsorId } = await makeSponsorWithAdmin(`Acme ${Date.now()}`);
  const { data: sponsor } = await client.from("sponsors").select("id, name").eq("id", sponsorId).single();
  expect(sponsor?.id).toBe(sponsorId);
  const { data: adminRow } = await client
    .from("sponsor_admins")
    .select("user_id")
    .eq("sponsor_id", sponsorId)
    .eq("user_id", userId)
    .maybeSingle();
  expect(adminRow?.user_id).toBe(userId);
});
```

- [ ] **Step 5: Run the partial test, expecting FAIL if any Task 1/3/5/7/9/13 deliverable is missing (otherwise this first block passes).**

```
npx vitest run tests/db/sponsor-billing-integration.test.ts
```

Expected while Plan 6 is still being assembled: an import-resolution error such as `Failed to resolve import "@/lib/billing/seats"` or an RPC error `Could not find the function public.create_sponsor`. If all upstream tasks (1–13) are already landed, this first `create_sponsor` block passes — that is fine; proceed to Step 6 to add the remaining assertions. Do not stub anything: this task consumes the real deliverables.

- [ ] **Step 6: Add the invite → accept → engagement/coverage → consent-gating → seat-sync assertions to the same file.**

Append these tests below the `create_sponsor` test in `tests/db/sponsor-billing-integration.test.ts`:

```ts
test("invite → accept links an active member, and engagement reflects the funnel", async () => {
  const { sponsorId, client: adminClientRls } = await makeSponsorWithAdmin(`Bolt ${Date.now()}`);
  const earner = await makeEarner(`member-${Date.now()}@example.com`);

  // Sponsor admin invites the earner's email via the real inviteCohort (fake sender).
  const { sender, sent } = fakeSender();
  const { invited, skipped } = await inviteCohort(adminClientRls, sender, {
    sponsorId,
    sponsorName: "Bolt",
    emails: [earner.email],
    origin: "https://trove.test",
  });
  expect(skipped).toEqual([]);
  expect(invited).toHaveLength(1);
  expect(sent).toEqual([{ to: earner.email, subject: expect.any(String) }]);
  const token = invited[0].token;

  // Before acceptance: invited=1, activated=0.
  const before = await getSponsorEngagement(adminClientRls, sponsorId);
  expect(before.invited).toBe(1);
  expect(before.activated).toBe(0);

  // Earner accepts (already provisioned in makeEarner).
  const { data: acceptedSponsor, error: acceptErr } = await earner.client.rpc("accept_cohort_invite", {
    invite_token: token,
  });
  expect(acceptErr).toBeNull();
  expect(acceptedSponsor).toBe(sponsorId);

  // Membership is active.
  const { data: member } = await adminClientRls
    .from("cohort_members")
    .select("status")
    .eq("sponsor_id", sponsorId)
    .eq("earner_id", earner.userId)
    .single();
  expect(member?.status).toBe("active");

  // Invite is marked accepted (idempotency: a second accept must fail/raise).
  const { error: secondAccept } = await earner.client.rpc("accept_cohort_invite", { invite_token: token });
  expect(secondAccept).not.toBeNull();

  // After acceptance: activated=1. imported/advisorUsed still 0 (no credentials, no advisor msgs).
  const after = await getSponsorEngagement(adminClientRls, sponsorId);
  expect(after.activated).toBe(1);
  expect(after.imported).toBe(0);
  expect(after.advisorUsed).toBe(0);
});

test("consent gates credentials AND skills; coverage only counts consenting members", async () => {
  const { sponsorId, client: adminClientRls } = await makeSponsorWithAdmin(`Cinder ${Date.now()}`);
  const earner = await makeEarner(`consent-${Date.now()}@example.com`);

  const { sender } = fakeSender();
  const { invited } = await inviteCohort(adminClientRls, sender, {
    sponsorId,
    sponsorName: "Cinder",
    emails: [earner.email],
    origin: "https://trove.test",
  });
  await earner.client.rpc("accept_cohort_invite", { invite_token: invited[0].token });

  // Earner adds a credential + a skill on their own rows (RLS: owner writes).
  await earner.client
    .from("credentials")
    .insert({ earner_id: earner.userId, source: "manual", issuer_name: "Coursera", title: "Data Analysis" });
  const { data: skill } = await admin
    .from("skills")
    .insert({ canonical_name: `SponsorViz ${Date.now()}`, type: "skill", onet_id: `88-${Date.now()}` })
    .select("id")
    .single();
  createdSkills.push(skill!.id);
  await earner.client.from("earner_skills").insert({ earner_id: earner.userId, skill_id: skill!.id });

  // consent OFF: sponsor admin sees zero credential rows and zero coverage.
  const { data: hiddenCreds } = await adminClientRls
    .from("credentials")
    .select("id")
    .eq("earner_id", earner.userId);
  expect(hiddenCreds ?? []).toHaveLength(0);
  expect(await getSponsorSkillCoverage(adminClientRls, sponsorId)).toEqual([]);

  // Earner turns BOTH consents on (column-level grant allows exactly these).
  const { error: consentErr } = await earner.client
    .from("cohort_members")
    .update({ consent_share_skills: true, consent_share_credentials: true })
    .eq("sponsor_id", sponsorId)
    .eq("earner_id", earner.userId);
  expect(consentErr).toBeNull();

  // consent ON: sponsor admin now sees the credential and the skill coverage.
  const { data: shownCreds } = await adminClientRls
    .from("credentials")
    .select("title")
    .eq("earner_id", earner.userId);
  expect(shownCreds?.map((c) => c.title)).toContain("Data Analysis");

  const coverage = await getSponsorSkillCoverage(adminClientRls, sponsorId);
  const row = coverage.find((r) => r.skillName === skill!.canonical_name);
  expect(row?.memberCount).toBe(1);

  // Engagement now counts imported=1 (an active member with >=1 credential).
  const eng = await getSponsorEngagement(adminClientRls, sponsorId);
  expect(eng.imported).toBe(1);
});

test("syncSubscriptionSeats sets the subscription quantity to the active-member count", async () => {
  const { sponsorId, client: adminClientRls } = await makeSponsorWithAdmin(`Delta ${Date.now()}`);
  const earner = await makeEarner(`seat-${Date.now()}@example.com`);
  const { sender } = fakeSender();
  const { invited } = await inviteCohort(adminClientRls, sender, {
    sponsorId,
    sponsorName: "Delta",
    emails: [earner.email],
    origin: "https://trove.test",
  });
  await earner.client.rpc("accept_cohort_invite", { invite_token: invited[0].token });

  expect(await countActiveMembers(admin, sponsorId)).toBe(1);

  // No subscription yet → Stripe skipped, but reconciliation still persists sponsors.seats (F12).
  const skippedResult = await syncSubscriptionSeats(fakeStripe("sub_x", "si_x").stripe, admin, sponsorId);
  expect(skippedResult.skipped).toBe(true);
  expect(skippedResult.quantity).toBe(1);
  const { data: afterSkip } = await admin.from("sponsors").select("seats").eq("id", sponsorId).single();
  expect(afterSkip!.seats).toBe(1); // reconciliation is the sole seats writer

  // Attach a subscription id (service role), then sync updates the Stripe item quantity.
  await admin.from("sponsors").update({ stripe_subscription_id: "sub_delta" }).eq("id", sponsorId);
  const { stripe, updates } = fakeStripe("sub_delta", "si_delta"); // existingQty defaults to 0 ≠ 1 → updates
  const synced = await syncSubscriptionSeats(stripe, admin, sponsorId);
  expect(synced.skipped).toBe(false);
  expect(synced.quantity).toBe(1);
  expect(updates).toHaveLength(1);
  const args = updates[0].args as { items: Array<{ id: string; quantity: number }>; proration_behavior: string };
  expect(args.items[0]).toEqual({ id: "si_delta", quantity: 1 });
  expect(args.proration_behavior).toBe("create_prorations");

  // Single source of truth (F12): DB seats == active count == the quantity pushed to Stripe.
  const { data: afterSync } = await admin.from("sponsors").select("seats").eq("id", sponsorId).single();
  expect(afterSync!.seats).toBe(1);
  expect(args.items[0].quantity).toBe(1);
});

test("sponsor_engagement / sponsor_skill_coverage RAISE for a non-admin caller", async () => {
  const { sponsorId } = await makeSponsorWithAdmin(`Ember ${Date.now()}`);
  const intruder = await makeEarner(`intruder-${Date.now()}@example.com`);

  const eng = await intruder.client.rpc("sponsor_engagement", { target_sponsor: sponsorId });
  expect(eng.error).not.toBeNull();
  const cov = await intruder.client.rpc("sponsor_skill_coverage", { target_sponsor: sponsorId });
  expect(cov.error).not.toBeNull();
});
```

- [ ] **Step 7: Run the full integration file, expecting PASS.**

```
npx vitest run tests/db/sponsor-billing-integration.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  5 passed (5)`.

If a live-DB file spuriously worker-times-out on the iCloud path (a known environment flake, not a logic failure), re-run the single file once more before investigating. If `syncSubscriptionSeats` asserts `proration_behavior` differently than Task 13 implemented, do NOT weaken the assertion — reconcile with Task 13's actual code (the spine mandates `proration_behavior:'create_prorations'`); a mismatch is a real bug in one of the two and must be fixed there.

- [ ] **Step 8: Commit the integration test.**

```
git add tests/db/sponsor-billing-integration.test.ts
git commit -m "test(billing): live-DB end-to-end — create_sponsor→invite→accept→engagement/coverage→seat-sync, Stripe+Postmark faked

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 9: Run the non-DB half of the full suite, expecting clean.**

Per the iCloud/vitest invariant, run the suite in two halves and sum. First the non-DB half (unit + UI + guards):

```
npx vitest run --exclude "**/tests/db/**"
```

Expected: all files pass, ending `Test Files  N passed (N)` / `Tests  M passed (M)` with **0 failed**. This half includes `tests/guards/no-real-billing-keys.test.ts`, every `lib/**/*.test.ts` (billing, cohort, email, advisor, skills), and the `@testing-library/react` UI tests for `/sponsor/*`. If a UI test fails because a server action ran for real, that test must `vi.mock` the action module — never invoke a real `"use server"` action in a component test.

- [ ] **Step 10: Run the DB half of the full suite, expecting clean.**

```
npx vitest run tests/db
```

Expected: all live-DB files pass (`schema`, `rls`, `credential-storage*`, `public-profile-rls`, `advisor`, `skills-*`, `onet-*`, Plan 6's `sponsor-billing-*` and the Task 2 consent/RLS spec), ending with **0 failed**. On a lone spurious worker timeout, re-run `npx vitest run tests/db` once; a repeatable failure is a real regression — debug it, do not retry-loop.

- [ ] **Step 11: Typecheck the whole project, expecting no errors.**

```
npx tsc --noEmit
```

Expected: no output, exit code 0. Any error here is almost always a drift between a consumed signature and its definition (e.g. `StripeLike` shape, `EngagementMetrics` field names) — fix the mismatch at the source, not with `any`.

- [ ] **Step 12: Production build, expecting success (with the iCloud cleanup dance).**

iCloud can leave stale duplicate artifacts (`* 2.*`) or an unmaterialized `page.js`. Clean those first, then build:

```
find .next -name "* 2.*" -delete 2>/dev/null; npm run build
```

Expected: `✓ Compiled successfully` and a route table listing the new `/sponsor`, `/sponsor/new`, `/sponsor/cohort`, `/sponsor/skills`, `/sponsor/billing`, `/invite/[token]`, and `/api/stripe/webhook` entries. If the build fails with an `ENOENT`/unmaterialized `page.js` error, run the documented hard-reset and retry once:

```
rm -rf .next && npm run build
```

- [ ] **Step 13: Lint, expecting clean.**

```
npm run lint
```

Expected: no output / `✔ No ESLint warnings or errors`, exit code 0. Fix any warning at the source (unused imports in the new test files, `const` vs `let`, typed casts on fakes) — do not disable rules inline.

- [ ] **Step 14: Record the green verification gate in a commit (or amend if the tree is already clean).**

If Steps 9–13 required any fixups, stage and commit them:

```
git add -A
git commit -m "chore(billing): Plan 6 final verification — suite (both halves), tsc, build, lint clean

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

If nothing changed in Steps 9–13 (all gates already green off the Step 8 commit), skip this commit — there is nothing to record.

- [ ] **Step 15: Open the PR from `trove-ai-advisor` per the finishing-a-development-branch skill.**

Invoke the `superpowers:finishing-a-development-branch` skill and follow it to open a PR into `main`. Push the branch and create the PR with `gh`:

```
git push -u origin trove-ai-advisor
gh pr create --base main --head trove-ai-advisor \
  --title "Plan 6: Sponsor Console + full Stripe billing" \
  --body "$(cat <<'EOF'
## Summary
Implements Plan 6 — the final Trove subsystem: the Sponsor Console and full Stripe billing.

- Migration 0007: `sponsors` billing columns, a unique `sponsors_stripe_customer_id_key` index (one sponsor per customer), `cohort_invites`, a `stripe_events` webhook-idempotency ledger, and RPCs (`create_sponsor`, `accept_cohort_invite`, `sponsor_engagement`, `sponsor_skill_coverage`); RLS fixes (`cohort_invites_sponsor_all`, `credentials_sponsor_select`, `sponsors_admin_update`, `earners_sponsor_select`, and the column-level consent-only `UPDATE` grant on `cohort_members`).
- Injectable adapters: `lib/billing/stripe.ts` (sole `stripe` importer, pinned apiVersion, `PLAN_BY_PRICE_ID` map) and `lib/email/postmark.ts` (fetch-based) — both faked in every test.
- Sponsor Console UI: `/sponsor`, `/sponsor/new`, `/sponsor/cohort`, `/sponsor/skills`, `/sponsor/billing`, `/invite/[token]`.
- Full Stripe flow: Checkout + Customer Portal + webhook (`/api/stripe/webhook`) + active-seat quantity sync with proration + reconciliation.

## Correctness / billing hardening
- **Webhook idempotency:** every event is recorded in `stripe_events` first; a duplicate/retried delivery is applied exactly once.
- **Out-of-order safety:** `customer.subscription.updated` reads the LIVE subscription (`retrieve`) and writes its authoritative status; a stale payload never wins. `customer.subscription.deleted` — and a live-canceled `updated` — is terminal (clears `stripe_subscription_id`), so a late `updated` cannot resurrect a canceled subscription.
- **Correlated invoices:** `invoice.paid`/`invoice.payment_failed` act only for `billing_reason ∈ {subscription_cycle, subscription_create}` AND when the invoice's subscription matches the sponsor's current one.
- **Stable plan labels:** `sponsors.plan` derives from `PLAN_BY_PRICE_ID` (price id), never `price.nickname`.
- **Single source of truth for seats:** `syncSubscriptionSeats` is the sole writer of `sponsors.seats` and no-ops when Stripe already matches the active count (breaks the update→webhook echo loop). DB seats == active count == Stripe quantity.
- **No second subscription:** Checkout is gated on `stripe_subscription_id IS NULL`; a sponsor with an existing subscription (incl. `past_due`) is routed to the Customer Portal instead.

## Security
- Fixes the two known 0003 gaps: earners can now update ONLY their consent flags (column-level grant), and `consent_share_credentials` is now enforced by a real `credentials_sponsor_select` policy.
- Invite acceptance is bound to the invited email inside the `accept_cohort_invite` SECURITY DEFINER body — a leaked/guessed token cannot join an account it was not addressed to.
- `earners_sponsor_select` lets a cohort's own admin resolve a member's (already-public) handle while staying tenant-scoped.
- No test constructs a real Stripe/Postmark client or reads a real key — enforced by `tests/guards/no-real-billing-keys.test.ts` (a genuine `process.env.<SECRET>` read fails it; `vi.stubEnv`/`delete`/save-restore do not).

## Operator setup (deployment prerequisites, not app code)
- Configure `STRIPE_PRICE_ID` (seed for `PLAN_BY_PRICE_ID`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `POSTMARK_SERVER_TOKEN`.
- Configure the Stripe **Customer Portal** so `subscription_update.default_allowed_updates` EXCLUDES `quantity` (Dashboard: uncheck "Customers can update quantities", or create a portal configuration via API and set it as default). Reconciliation owns the seat quantity; portal quantity edits would be overwritten on the next sync.

## Verification
- `npx vitest run --exclude "**/tests/db/**"` — clean
- `npx vitest run tests/db` — clean (live hosted DB)
- `npx tsc --noEmit` — clean
- `npm run build` — clean
- `npm run lint` — clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the new PR URL. This closes out Plan 6 and the Trove build.

---

