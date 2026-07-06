// CAUSE B live-DB coverage: the invite_preview RPC (migration 0009) is the ONLY way a real invitee
// (unauthenticated, or authenticated but not that sponsor's admin) can resolve an invite's sponsor
// name + open/accepted state pre-login — the only RLS policy on cohort_invites
// (cohort_invites_sponsor_all, 0007) is admin-scoped and returns zero rows for everyone else.
import { afterAll, expect, test } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const createdUsers: string[] = [];
const createdSponsors: string[] = [];

// A fresh, unauthenticated anon-key client — mirrors lib/supabase/client.ts and
// tests/db/public-profile-rls.test.ts's anonClient(), no session at all.
function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

afterAll(async () => {
  for (const id of createdSponsors) await admin.from("sponsors").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

test("invite_preview resolves for a non-admin authenticated caller even though the direct table SELECT returns zero rows", async () => {
  const owner = await makeUserClient(`ip-owner-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
    sponsor_name: "Preview Co",
  });
  createdSponsors.push(sponsorId as string);

  const token = `ip-tok-${Date.now()}`;
  const inviteeEmail = `ip-invitee-${Date.now()}@example.com`;
  const { error: inviteErr } = await owner.client.from("cohort_invites").insert({
    sponsor_id: sponsorId as string,
    email: inviteeEmail,
    token,
  });
  expect(inviteErr).toBeNull();

  // A fresh earner, NOT a sponsor admin of "Preview Co".
  const stranger = await makeUserClient(`ip-stranger-${Date.now()}@example.com`);
  createdUsers.push(stranger.userId);

  // (a) invite_preview resolves the token for this non-admin caller.
  const preview = await stranger.client.rpc("invite_preview", { invite_token: token });
  expect(preview.error).toBeNull();
  expect(preview.data).toEqual([{ sponsor_name: "Preview Co", is_open: true }]);

  // (b) but a DIRECT table SELECT for the same caller/token returns zero rows — proving the RPC is
  // doing real work the RLS policy alone does not provide (this is the bug invite_preview fixes).
  const direct = await stranger.client
    .from("cohort_invites")
    .select("token")
    .eq("token", token);
  expect(direct.data).toEqual([]);
});

test("invite_preview resolves for a fully anonymous (unauthenticated) caller", async () => {
  const owner = await makeUserClient(`ip-owner2-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
    sponsor_name: "Anon Preview Co",
  });
  createdSponsors.push(sponsorId as string);

  const token = `ip-anon-tok-${Date.now()}`;
  const { error: inviteErr } = await owner.client.from("cohort_invites").insert({
    sponsor_id: sponsorId as string,
    email: `ip-anon-invitee-${Date.now()}@example.com`,
    token,
  });
  expect(inviteErr).toBeNull();

  const anon = anonClient();
  const preview = await anon.rpc("invite_preview", { invite_token: token });
  expect(preview.error).toBeNull();
  expect(preview.data).toEqual([{ sponsor_name: "Anon Preview Co", is_open: true }]);

  // Direct table access for the same anon caller also returns zero rows.
  const direct = await anon.from("cohort_invites").select("token").eq("token", token);
  expect(direct.data).toEqual([]);
});

test("invite_preview reflects accepted_at: is_open flips to false once accepted", async () => {
  const owner = await makeUserClient(`ip-owner3-${Date.now()}@example.com`);
  createdUsers.push(owner.userId);
  const { data: sponsorId } = await owner.client.rpc("create_sponsor", {
    sponsor_name: "Accepted Preview Co",
  });
  createdSponsors.push(sponsorId as string);

  const inviteeEmail = `ip-invitee3-${Date.now()}@example.com`;
  const token = `ip-tok3-${Date.now()}`;
  await owner.client.from("cohort_invites").insert({
    sponsor_id: sponsorId as string,
    email: inviteeEmail,
    token,
  });

  const invitee = await makeUserClient(inviteeEmail);
  createdUsers.push(invitee.userId);
  await invitee.client.from("earners").insert({ id: invitee.userId, handle: `ipacc${Date.now()}` });
  const { error: acceptErr } = await invitee.client.rpc("accept_cohort_invite", {
    invite_token: token,
  });
  expect(acceptErr).toBeNull();

  const anon = anonClient();
  const preview = await anon.rpc("invite_preview", { invite_token: token });
  expect(preview.error).toBeNull();
  expect(preview.data).toEqual([{ sponsor_name: "Accepted Preview Co", is_open: false }]);
});

test("invite_preview returns an empty array (not an error) for an unknown/garbage token", async () => {
  const anon = anonClient();
  const preview = await anon.rpc("invite_preview", { invite_token: "totally-made-up-token" });
  expect(preview.error).toBeNull();
  expect(preview.data).toEqual([]);
});
