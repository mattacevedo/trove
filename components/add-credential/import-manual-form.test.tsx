import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ImportManualForm } from "./import-manual-form";

test("renders labelled required title + optional fields", () => {
  render(<ImportManualForm />);
  expect(screen.getByLabelText(/title/i)).toBeRequired();
  expect(screen.getByLabelText(/issuer/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
});

test("blocks submit with an empty title and shows a role=alert message", async () => {
  const user = userEvent.setup();
  render(<ImportManualForm />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));
  expect(screen.getByRole("alert")).toHaveTextContent(/title is required/i);
});
