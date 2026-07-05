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
