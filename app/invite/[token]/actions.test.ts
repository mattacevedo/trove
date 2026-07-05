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

// The accept action must sync seats through a SERVICE-ROLE client (C1): a freshly-joined earner's
// RLS-scoped `supabase` client cannot read sponsors.stripe_subscription_id or write sponsors.seats
// (migration 0008 revoked authenticated UPDATE on sponsors except stripe_customer_id), and its
// cohort_members SELECT policy only exposes the caller's own row, so countActiveMembers would be
// wrong too. adminClient is a distinct fake object so tests can assert it (not the earner's
// `supabase`) is what gets passed to syncSubscriptionSeats.
const adminClient = { __admin: true };
const createClient = vi.fn((..._a: unknown[]) => adminClient);
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...a: unknown[]) => createClient(...a),
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
  createClient.mockClear();
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
  // C1: seat sync must run through the service-role admin client, never the earner's RLS-scoped
  // `supabase` — the earner has no RLS visibility into sponsors and would 42501 on the seats write.
  expect(syncSubscriptionSeats).toHaveBeenCalledWith(
    { __fake: true },
    adminClient,
    "sponsor-9"
  );
  expect(syncSubscriptionSeats).not.toHaveBeenCalledWith(
    expect.anything(),
    supabase,
    expect.anything()
  );
  expect(redirect).toHaveBeenCalledWith("/app");
});

test("C2/regression: still redirects to /app when syncSubscriptionSeats rejects (Stripe outage must not lose an accepted membership)", async () => {
  requireUserId.mockResolvedValue("user-1");
  getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "new@ex.com" } } });
  provisionEarner.mockResolvedValue({ handle: "new-abcd" });
  rpc.mockResolvedValue({ data: "sponsor-9", error: null });
  syncSubscriptionSeats.mockRejectedValue(new Error("stripe outage"));

  const { acceptInvite } = await import("./actions");
  await expect(acceptInvite(fd("tok-123"))).rejects.toThrow("REDIRECT:/app");

  // The accept RPC result is what drives success — it already committed the membership durably.
  expect(rpc).toHaveBeenCalledWith("accept_cohort_invite", { invite_token: "tok-123" });
  expect(syncSubscriptionSeats).toHaveBeenCalledWith(
    { __fake: true },
    adminClient,
    "sponsor-9"
  );
  // Best-effort: the rejection must be swallowed (caught + logged), never rethrown, and must not
  // prevent the redirect that confirms the already-committed membership to the user.
  expect(redirect).toHaveBeenCalledWith("/app");
});

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
