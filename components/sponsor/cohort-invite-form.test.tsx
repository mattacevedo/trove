import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/sponsor/actions", () => ({ inviteCohort: vi.fn() }));
import { CohortInviteForm } from "./cohort-invite-form";

test("renders a labeled emails textarea and a submit button wired to the action", () => {
  render(<CohortInviteForm />);
  const textarea = screen.getByLabelText(/email addresses/i);
  expect(textarea).toBeInTheDocument();
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea).toHaveAttribute("name", "emails");
  expect(screen.getByRole("button", { name: /send invites/i })).toBeInTheDocument();
});
