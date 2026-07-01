import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { VerificationBadge } from "./verification-badge";

test("verified badge shows text label, not color alone", () => {
  render(<VerificationBadge status="verified" />);
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

test("failed badge communicates failure in words", () => {
  render(<VerificationBadge status="failed" />);
  expect(screen.getByText("Verification failed")).toBeInTheDocument();
});

test("unverified badge icon is decorative (aria-hidden)", () => {
  const { container } = render(<VerificationBadge status="unverified" />);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

test("unverified badge shows text label", () => {
  render(<VerificationBadge status="unverified" />);
  expect(screen.getByText("Unverified")).toBeInTheDocument();
});
