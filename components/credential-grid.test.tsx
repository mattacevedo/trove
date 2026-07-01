import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CredentialGrid, type WalletCredential } from "./credential-grid";

function cred(id: string, title: string): WalletCredential {
  return { id, title, issuer_name: "I", issued_date: null, verification_status: "unverified" };
}

test("renders one list item per credential", () => {
  render(
    <CredentialGrid credentials={[cred("a", "Alpha"), cred("b", "Beta"), cred("c", "Gamma")]} />
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("Gamma")).toBeInTheDocument();
});
