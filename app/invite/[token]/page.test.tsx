import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

// The page renders a <form action={acceptInvite}>; mock the action so the form
// submits to a jest.fn rather than a real "use server" boundary.
vi.mock("./actions", () => ({ acceptInvite: vi.fn() }));

// CAUSE B: the page now resolves the pre-accept preview via the invite_preview SECURITY DEFINER RPC
// (works identically for anon and authenticated callers) instead of a direct cohort_invites SELECT,
// which only ever returned rows for a sponsor admin (cohort_invites_sponsor_all is admin-scoped) and
// so showed "Invitation unavailable" to every real invitee in production.
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ rpc }),
}));

import InvitePage from "./page";

afterEach(() => {
  rpc.mockReset();
});

test("shows the sponsor name, a hidden token field, and an accessible accept CTA", async () => {
  rpc.mockResolvedValue({
    data: [{ sponsor_name: "Acme Health", is_open: true }],
    error: null,
  });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/acme health/i);
  expect(rpc).toHaveBeenCalledWith("invite_preview", { invite_token: "tok-123" });
  const cta = screen.getByRole("button", { name: /accept invitation/i });
  expect(cta).toBeInTheDocument();
  const tokenField = cta
    .closest("form")!
    .querySelector('input[name="token"]') as HTMLInputElement;
  expect(tokenField).not.toBeNull();
  expect(tokenField.value).toBe("tok-123");
});

test("shows an error message when ?error=1 is present", async () => {
  rpc.mockResolvedValue({
    data: [{ sponsor_name: "Acme Health", is_open: true }],
    error: null,
  });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve({ error: "1" }),
  });
  render(ui);

  expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t accept/i);
});

test("shows an invalid-invite message when the token matches no open invite", async () => {
  rpc.mockResolvedValue({ data: [], error: null });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "missing" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByText(/invitation is no longer valid/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /accept invitation/i })).toBeNull();
});

test("shows an invalid-invite message when the invite exists but is already accepted (is_open: false)", async () => {
  rpc.mockResolvedValue({ data: [{ sponsor_name: "Acme Health", is_open: false }], error: null });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-accepted" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByText(/invitation is no longer valid/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /accept invitation/i })).toBeNull();
});
