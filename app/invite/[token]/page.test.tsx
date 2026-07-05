import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

// The page renders a <form action={acceptInvite}>; mock the action so the form
// submits to a jest.fn rather than a real "use server" boundary.
vi.mock("./actions", () => ({ acceptInvite: vi.fn() }));

// Narrow pre-accept read: page looks up the sponsor name by invite token.
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ from }),
}));

import InvitePage from "./page";

afterEach(() => {
  maybeSingle.mockReset();
  eq.mockClear();
  select.mockClear();
  from.mockClear();
});

test("shows the sponsor name, a hidden token field, and an accessible accept CTA", async () => {
  maybeSingle.mockResolvedValue({
    data: { accepted_at: null, sponsors: { name: "Acme Health" } },
    error: null,
  });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/acme health/i);
  expect(from).toHaveBeenCalledWith("cohort_invites");
  const cta = screen.getByRole("button", { name: /accept invitation/i });
  expect(cta).toBeInTheDocument();
  const tokenField = cta
    .closest("form")!
    .querySelector('input[name="token"]') as HTMLInputElement;
  expect(tokenField).not.toBeNull();
  expect(tokenField.value).toBe("tok-123");
});

test("shows an error message when ?error=1 is present", async () => {
  maybeSingle.mockResolvedValue({
    data: { accepted_at: null, sponsors: { name: "Acme Health" } },
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
  maybeSingle.mockResolvedValue({ data: null, error: null });

  const ui = await InvitePage({
    params: Promise.resolve({ token: "missing" }),
    searchParams: Promise.resolve({}),
  });
  render(ui);

  expect(screen.getByText(/invitation is no longer valid/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /accept invitation/i })).toBeNull();
});
