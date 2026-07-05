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
