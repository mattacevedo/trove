import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DisclaimerBanner } from "./disclaimer-banner";

test("renders the guidance-not-guarantee copy with no dismiss control", () => {
  render(<DisclaimerBanner />);
  expect(screen.getByRole("note")).toHaveTextContent(/not a guarantee/i);
  expect(screen.queryByRole("button")).toBeNull();
});
