// CAUSE F live-DB coverage: reinvite_cohort_member (migration 0010) is the only join path from a
// cohort_invites row's EMAIL to the corresponding cohort_members row's STATUS (the two tables share
// no FK; the email -> earner_id mapping lives only on auth.users, readable only inside this
// SECURITY DEFINER function). This proves the RPC's three outcomes against the real schema/RLS.
import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const createdUsers: string[] = [];
const createdSponsors: string[] = [];

afterAll(async () => {
  for (const id of createdSponsors) await admin.from("sponsors").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

test("reinvite_cohort_member rotates the token and clears accepted_at for a REMOVED member", async () => {
  const owner = await makeUserClient(`re-owner-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", { sponsor_name: "Rejoin Co" });
  createdSponsors.push(sponsorId as string);

  // Member signs up, accepts, then is removed.
  const memberEmail = `re-member-${Date.now()}@example.com`;
  const member = await makeUserClient(memberEmail);
  createdUsers.push(member.userId);
  await member.client.from("earners").insert({ id: member.userId, handle: `re${Date.now()}` });

  const token = `re-tok-${Date.now()}`;
  await owner.client.from("cohort_invites").insert({
    sponsor_id: sponsorId as string,
    email: memberEmail,
    token,
  });
  const { error: acceptErr } = await member.client.rpc("accept_cohort_invite", { invite_token: token });
  expect(acceptErr).toBeNull();

  // Sponsor removes the member (service-role write, mirroring removeMember's real path).
  await admin
    .from("cohort_members")
    .update({ status: "removed" })
    .eq("sponsor_id", sponsorId as string)
    .eq("earner_id", member.userId);

  // The owner re-invites: the RPC should find the removed member and rotate the invite.
  const newToken = `re-tok-new-${Date.now()}`;
  const { data: rows, error } = await owner.client.rpc("reinvite_cohort_member", {
    target_sponsor: sponsorId as string,
    invite_email: memberEmail,
    new_token: newToken,
  });
  expect(error).toBeNull();
  expect(rows).toEqual([{ token: newToken }]);

  const { data: inviteRow } = await admin
    .from("cohort_invites")
    .select("token, accepted_at")
    .eq("sponsor_id", sponsorId as string)
    .eq("email", memberEmail)
    .single();
  expect(inviteRow!.token).toBe(newToken);
  expect(inviteRow!.accepted_at).toBeNull();

  // The reopened invite can be accepted again, reactivating membership end-to-end.
  const { data: reacceptedSponsor, error: reacceptErr } = await member.client.rpc(
    "accept_cohort_invite",
    { invite_token: newToken }
  );
  expect(reacceptErr).toBeNull();
  expect(reacceptedSponsor).toBe(sponsorId);
  const { data: memberRow } = await admin
    .from("cohort_members")
    .select("status")
    .eq("sponsor_id", sponsorId as string)
    .eq("earner_id", member.userId)
    .single();
  expect(memberRow!.status).toBe("active");
});

test("reinvite_cohort_member returns zero rows and does NOT touch the invite when the member is still ACTIVE", async () => {
  const owner = await makeUserClient(`re-owner2-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", { sponsor_name: "Active Co" });
  createdSponsors.push(sponsorId as string);

  const memberEmail = `re-active-${Date.now()}@example.com`;
  const member = await makeUserClient(memberEmail);
  createdUsers.push(member.userId);
  await member.client.from("earners").insert({ id: member.userId, handle: `reac${Date.now()}` });

  const token = `re-active-tok-${Date.now()}`;
  await owner.client.from("cohort_invites").insert({
    sponsor_id: sponsorId as string,
    email: memberEmail,
    token,
  });
  await member.client.rpc("accept_cohort_invite", { invite_token: token });

  const { data: rows, error } = await owner.client.rpc("reinvite_cohort_member", {
    target_sponsor: sponsorId as string,
    invite_email: memberEmail,
    new_token: "should-not-be-used",
  });
  expect(error).toBeNull();
  expect(rows).toEqual([]);

  const { data: inviteRow } = await admin
    .from("cohort_invites")
    .select("token")
    .eq("sponsor_id", sponsorId as string)
    .eq("email", memberEmail)
    .single();
  expect(inviteRow!.token).toBe(token); // untouched
});

test("reinvite_cohort_member returns zero rows for an email with no auth.users account", async () => {
  const owner = await makeUserClient(`re-owner3-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", { sponsor_name: "NoAccount Co" });
  createdSponsors.push(sponsorId as string);

  const { data: rows, error } = await owner.client.rpc("reinvite_cohort_member", {
    target_sponsor: sponsorId as string,
    invite_email: `nobody-${Date.now()}@example.com`,
    new_token: "unused-token",
  });
  expect(error).toBeNull();
  expect(rows).toEqual([]);
});

test("reinvite_cohort_member RAISES for a non-admin caller (is_sponsor_admin gate)", async () => {
  const owner = await makeUserClient(`re-owner4-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", { sponsor_name: "Gated Co" });
  createdSponsors.push(sponsorId as string);

  const stranger = await makeUserClient(`re-stranger-${Date.now()}@example.com`);
  createdUsers.push(stranger.userId);

  const { error } = await stranger.client.rpc("reinvite_cohort_member", {
    target_sponsor: sponsorId as string,
    invite_email: `whoever-${Date.now()}@example.com`,
    new_token: "unused-token",
  });
  expect(error).not.toBeNull();
});
