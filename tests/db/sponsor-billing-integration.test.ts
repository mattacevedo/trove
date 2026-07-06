// Live-DB end-to-end spec for the Sponsor Console + billing subsystem (Plan 6, Task 14).
//
// This exercises the REAL RPCs/RLS/schema against the hosted Supabase project while faking every
// external service — Stripe (StripeLike) and Postmark (EmailSender) — so no test here ever spends
// real money or sends real email (enforced separately by tests/guards/no-real-billing-keys.test.ts).
//
// Scope note: individual RPCs/RLS policies already have dedicated live-DB coverage
// (tests/db/sponsor-rls.test.ts, sponsor-engagement.test.ts, sponsor-skills.test.ts,
// sponsor-billing-schema.test.ts). This file's job is the END-TO-END SEAM: create_sponsor ->
// inviteCohort (lib) -> accept_cohort_invite (RPC) -> engagement/coverage (lib) -> consent gating ->
// syncSubscriptionSeats (lib) against the live DB with a fake Stripe — the full funnel driven through
// the actual library functions the app calls, not raw RPC calls in isolation. In particular,
// syncSubscriptionSeats has previously only been unit-tested against a fully faked Supabase client
// (lib/billing/seats.test.ts); here it runs against the real schema/RLS for the first time.
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

  // Before acceptance: activated=0 (invited count includes all cohort_members regardless of status
  // per the sponsor_engagement RPC — see tests/db/sponsor-engagement.test.ts — but no member row
  // exists yet at all, so invited counts only the pending cohort_invites row here).
  const before = await getSponsorEngagement(adminClientRls, sponsorId);
  expect(before.invited).toBe(1);
  expect(before.activated).toBe(0);

  // Earner accepts (already provisioned in makeEarner). accept_cohort_invite is EMAIL-BOUND: the
  // invite was addressed to earner.email, and this earner's auth user shares that exact email.
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
  const skillName = `SponsorViz ${Date.now()}`;
  const { data: skill } = await admin
    .from("skills")
    .insert({ canonical_name: skillName, type: "skill", onet_id: `88-${Date.now()}` })
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
  const row = coverage.find((r) => r.skillName === skillName);
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
