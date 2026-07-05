import { afterEach, expect, test, vi } from "vitest";

// --- mocks (declared before importing the module under test) ---
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const requireSponsorAdmin = vi.fn();
vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: () => requireSponsorAdmin(),
}));

// The RLS-scoped client is used only for the DELETE/UPDATE write via the service-role client below —
// createServerClient must NOT be the thing that writes cohort_members.status (migration 0007 revoked
// UPDATE on cohort_members from `authenticated` except the two consent columns; that grant binds ALL
// authenticated users including sponsor admins, so a write under this client would 42501).
const createServerClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createServerClient: () => createServerClient() }));

// removeMember must perform the status='removed' write through the SERVICE-ROLE client (bypasses RLS
// and the column-privilege revoke), only AFTER requireSponsorAdmin() has authorized the caller.
const eq2 = vi.fn();
const eq1 = vi.fn(() => ({ eq: eq2 }));
const update = vi.fn(() => ({ eq: eq1 }));
const from = vi.fn(() => ({ update }));
const adminClient = { from, __admin: true };
const createServiceRoleClient = vi.fn(() => adminClient);
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

const syncSubscriptionSeats = vi.fn();
vi.mock("@/lib/billing/seats", () => ({
  syncSubscriptionSeats: (...a: unknown[]) => syncSubscriptionSeats(...a),
}));

const createStripeClient = vi.fn(() => ({ __fake: "stripe" }));
vi.mock("@/lib/billing/stripe", () => ({
  createStripeClient: () => createStripeClient(),
}));

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

afterEach(() => {
  vi.clearAllMocks();
});

test("removeMember gates on requireSponsorAdmin, soft-removes via the service-role client scoped to sponsor+earner, syncs seats, and redirects", async () => {
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "sp_1" });
  eq2.mockResolvedValue({ error: null });
  syncSubscriptionSeats.mockResolvedValue({ quantity: 1, skipped: false });

  const { removeMember } = await import("./actions");
  await expect(removeMember(fd({ earnerId: "earner-9" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort"
  );

  expect(requireSponsorAdmin).toHaveBeenCalledOnce();

  // The write happened through the SERVICE-ROLE client, never the RLS-scoped createServerClient.
  expect(createServiceRoleClient).toHaveBeenCalledOnce();
  expect(from).toHaveBeenCalledWith("cohort_members");
  expect(update).toHaveBeenCalledWith({ status: "removed" });
  // Scoped to both the admin's own sponsor AND the target earner (defense in depth: an admin cannot
  // touch another org's rows even though the service-role client bypasses RLS).
  expect(eq1).toHaveBeenCalledWith("sponsor_id", "sp_1");
  expect(eq2).toHaveBeenCalledWith("earner_id", "earner-9");

  // Seat sync runs best-effort through the same service-role client (mirrors the accept-flow
  // pattern), never the earner/admin RLS-scoped client.
  expect(syncSubscriptionSeats).toHaveBeenCalledWith(
    { __fake: "stripe" },
    adminClient,
    "sp_1"
  );

  expect(revalidatePath).toHaveBeenCalledWith("/sponsor/cohort");
  expect(redirect).toHaveBeenCalledWith("/sponsor/cohort");
});

test("removeMember redirects with an error and does not write when earnerId is missing", async () => {
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "sp_1" });

  const { removeMember } = await import("./actions");
  await expect(removeMember(fd({}))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?error=missing_member"
  );

  expect(update).not.toHaveBeenCalled();
  expect(syncSubscriptionSeats).not.toHaveBeenCalled();
});

test("removeMember redirects with an error when the removal write fails, and does not sync seats", async () => {
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "sp_1" });
  eq2.mockResolvedValue({ error: { message: "boom" } });

  const { removeMember } = await import("./actions");
  await expect(removeMember(fd({ earnerId: "earner-9" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?error=remove_failed"
  );

  expect(syncSubscriptionSeats).not.toHaveBeenCalled();
});

test("removeMember still redirects to /sponsor/cohort when syncSubscriptionSeats rejects (best-effort: seat-sync failure must never break the remove flow)", async () => {
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "sp_1" });
  eq2.mockResolvedValue({ error: null });
  syncSubscriptionSeats.mockRejectedValue(new Error("stripe outage"));

  const { removeMember } = await import("./actions");
  await expect(removeMember(fd({ earnerId: "earner-9" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort"
  );

  expect(syncSubscriptionSeats).toHaveBeenCalledOnce();
  expect(revalidatePath).toHaveBeenCalledWith("/sponsor/cohort");
  expect(redirect).toHaveBeenCalledWith("/sponsor/cohort");
});
