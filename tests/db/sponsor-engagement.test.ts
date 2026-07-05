import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";
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

// NOTE (deviation from brief): sponsor_engagement is guarded by is_sponsor_admin(target_sponsor),
// which checks `user_id = auth.uid()` inside the SQL function (0003_rls_policies.sql). auth.uid()
// is NULL under the service-role key regardless of any sponsor_admins row, so the RPC cannot be
// exercised as an authorized admin via `adminClient()` alone — confirmed by the existing
// tests/db/sponsor-rls.test.ts precedent ("sponsor_engagement ... succeed and aggregate for an
// admin"), which calls the RPC through a makeUserClient()-scoped client. We keep the brief's
// deterministic service-role SEEDING, but read via an RLS-scoped admin client for the RPC call.
async function makeSponsorWithAdmin(): Promise<{
  sponsorId: string;
  adminId: string;
  adminDb: Awaited<ReturnType<typeof makeUserClient>>["client"];
}> {
  const email = `spadmin-${uniq()}@example.com`;
  const { client: adminDb, userId: adminId } = await makeUserClient(email);
  createdUsers.push(adminId);
  await admin.from("earners").insert({ id: adminId, handle: `h${uniq().replace(/[^a-z0-9]/gi, "").slice(0, 20)}` });

  const { data, error } = await admin
    .from("sponsors")
    .insert({ name: `Acme ${uniq()}` })
    .select("id")
    .single();
  if (error) throw error;
  const sponsorId = data!.id as string;
  createdSponsors.push(sponsorId);
  await admin.from("sponsor_admins").insert({ sponsor_id: sponsorId, user_id: adminId });
  return { sponsorId, adminId, adminDb };
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
  const { sponsorId, adminDb } = await makeSponsorWithAdmin();

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

  const metrics = await getSponsorEngagement(adminDb, sponsorId);

  // invited = pending invites + ALL cohort_members rows regardless of status (per the
  // sponsor_engagement RPC in 0007_sponsor_billing.sql, whose `invited` term has no status
  // filter on cohort_members — only `activated`/`imported`/`advisor_used` filter to 'active').
  // 2 pending invites + 4 members (3 active + 1 removed) = 6.
  expect(metrics.invited).toBe(6);
  expect(metrics.activated).toBe(3);
  expect(metrics.imported).toBe(1);
  expect(metrics.advisorUsed).toBe(1);
});

test("getSponsorEngagement returns zeros for a sponsor with no cohort", async () => {
  const { sponsorId, adminDb } = await makeSponsorWithAdmin();
  const metrics = await getSponsorEngagement(adminDb, sponsorId);
  expect(metrics).toEqual({ invited: 0, activated: 0, imported: 0, advisorUsed: 0 });
});
