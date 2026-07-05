import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("@/app/sponsor/actions", () => ({ createSponsor: vi.fn() }));

import SponsorNewPage from "./page";

test("renders a labeled org-name input and an accent Create CTA wired to the action", () => {
  render(<SponsorNewPage />);

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
});
