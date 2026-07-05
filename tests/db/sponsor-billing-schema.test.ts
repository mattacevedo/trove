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

test("a sponsor admin cannot update billing/entitlement columns, only stripe_customer_id", async () => {
  const owner = await makeUserClient(`bill-owner-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
    sponsor_name: "Billing Co",
  });
  createdSponsors.push(sponsorId as string);

  // Attempting to self-grant entitlement columns is REJECTED by the column-level grant (0008).
  const tamperUpd = await owner.client
    .from("sponsors")
    .update({
      subscription_status: "active",
      plan: "pro",
      seats: 999,
      stripe_subscription_id: "sub_fake",
    })
    .eq("id", sponsorId as string);
  expect(tamperUpd.error?.code).toBe("42501");

  // Entitlement columns are unchanged.
  const { data: unchangedRow } = await admin
    .from("sponsors")
    .select("plan, seats, subscription_status, stripe_subscription_id")
    .eq("id", sponsorId as string)
    .single();
  expect(unchangedRow!.plan).toBe("free");
  expect(unchangedRow!.seats).toBe(0);
  expect(unchangedRow!.subscription_status).toBe("inactive");
  expect(unchangedRow!.stripe_subscription_id).toBeNull();

  // stripe_customer_id is the one column the client IS allowed to write.
  const custUpd = await owner.client
    .from("sponsors")
    .update({ stripe_customer_id: "cus_test_123" })
    .eq("id", sponsorId as string);
  expect(custUpd.error).toBeNull();

  const { data: updatedRow } = await admin
    .from("sponsors")
    .select("stripe_customer_id")
    .eq("id", sponsorId as string)
    .single();
  expect(updatedRow!.stripe_customer_id).toBe("cus_test_123");
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
