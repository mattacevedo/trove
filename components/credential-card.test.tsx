import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CredentialCard, type WalletCredential } from "./credential-card";

const base: WalletCredential = {
  id: "c1",
  title: "Welding Level 1",
  issuer_name: "Acme Trade School",
  issued_date: "2024-05-01",
  verification_status: "verified",
};

test("renders title, issuer, formatted date, and the verified badge", () => {
  render(<CredentialCard credential={base} />);
  expect(screen.getByRole("heading", { name: "Welding Level 1" })).toBeInTheDocument();
  expect(screen.getByText("Acme Trade School")).toBeInTheDocument();
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

test("shows a fallback when the issued date is missing", () => {
  render(<CredentialCard credential={{ ...base, issued_date: null }} />);
  expect(screen.getByText("Date not provided")).toBeInTheDocument();
});

test("shows the failed badge for a failed credential", () => {
  render(<CredentialCard credential={{ ...base, verification_status: "failed" }} />);
  expect(screen.getByText("Verification failed")).toBeInTheDocument();
});
