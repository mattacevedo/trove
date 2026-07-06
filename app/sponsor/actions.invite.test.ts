import { expect, test, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above module scope, so a plain top-level `const` mock fn would be
// referenced before initialization. vi.hoisted lifts these alongside the mocks (matching the
// pattern in components/advisor/chat-pane.test.tsx).
const { requireSponsorAdmin, inviteCohortLib, createPostmarkSender, createServerClient, revalidatePath, redirect, headers } =
  vi.hoisted(() => ({
    requireSponsorAdmin: vi.fn(),
    inviteCohortLib: vi.fn(),
    createPostmarkSender: vi.fn(),
    createServerClient: vi.fn(),
    revalidatePath: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    headers: vi.fn(),
  }));

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
  createServerClient.mockResolvedValue({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { name: "Acme" } }) }) }) }),
  });
  createPostmarkSender.mockReturnValue({ send: vi.fn() });
  inviteCohortLib.mockResolvedValue({
    invited: [{ email: "a@x.com" }],
    skipped: [],
    resent: [],
    failed: [],
  });
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

// CAUSE H: the redirect target after a successful send now carries the lib's result counts so the
// cohort page can render "3 invited, 1 skipped..." instead of a bare, silent redirect.
test("CAUSE H: redirects with invited/skipped/resent/failed counts from the lib result", async () => {
  inviteCohortLib.mockResolvedValue({
    invited: [{ email: "a@x.com" }, { email: "b@x.com" }],
    skipped: ["skip@x.com"],
    resent: ["resend@x.com"],
    failed: ["fail@x.com"],
  });
  await expect(inviteCohortAction(fd({ emails: "a@x.com, b@x.com" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?invited=2&skipped=1&resent=1&failed=1"
  );
});

test("CAUSE H: a batch with zero of a bucket still reports 0 explicitly (no silent omission)", async () => {
  inviteCohortLib.mockResolvedValue({
    invited: [{ email: "a@x.com" }],
    skipped: [],
    resent: [],
    failed: [],
  });
  await expect(inviteCohortAction(fd({ emails: "a@x.com" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?invited=1&skipped=0&resent=0&failed=0"
  );
});

test("redirects with an error and does not call lib when no valid emails are supplied", async () => {
  await expect(inviteCohortAction(fd({ emails: "bad, also-bad" }))).rejects.toThrow(
    "REDIRECT:/sponsor/cohort?error=no_valid_emails"
  );
  expect(inviteCohortLib).not.toHaveBeenCalled();
});
