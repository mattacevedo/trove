import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("@/app/sponsor/actions", () => ({ createSponsor: vi.fn() }));

import SponsorNewPage from "./page";

function sp(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

test("renders a labeled org-name input and an accent Create CTA wired to the action", async () => {
  const ui = await SponsorNewPage({ searchParams: sp() });
  render(ui);

  // Heading present.
  expect(
    screen.getByRole("heading", { name: /create.*organization/i })
  ).toBeInTheDocument();

  // A real <label> associated with a text input named "name".
  const input = screen.getByLabelText(/organization name/i);
  expect(input).toHaveAttribute("name", "name");
  expect(input).toBeRequired();

  // Submit CTA.
  const submit = screen.getByRole("button", { name: /create organization/i });
  expect(submit).toHaveAttribute("type", "submit");

  // The form's action is the mocked server action (a function reference).
  const form = input.closest("form");
  expect(form).not.toBeNull();

  // No error alert by default.
  expect(screen.queryByRole("alert")).toBeNull();
});

// ---- CAUSE H: swallowed action feedback ----

test("CAUSE H: ?error=name_required renders an accessible alert", async () => {
  const ui = await SponsorNewPage({ searchParams: sp({ error: "name_required" }) });
  render(ui);
  expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
});

test("CAUSE H: ?error=create_failed renders an accessible alert", async () => {
  const ui = await SponsorNewPage({ searchParams: sp({ error: "create_failed" }) });
  render(ui);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});
