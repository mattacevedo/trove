import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ReverifyButton } from "./reverify-button";

test("renders a re-verify control carrying the credential id", () => {
  render(<ReverifyButton credentialId="c-123" />);
  const button = screen.getByRole("button", { name: /verify/i });
  expect(button).toBeInTheDocument();
  const hidden = button
    .closest("form")!
    .querySelector('input[name="credential_id"]') as HTMLInputElement;
  expect(hidden.value).toBe("c-123");
});
