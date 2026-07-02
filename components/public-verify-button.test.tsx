import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VerifyResult } from "@/lib/credentials/types";

// vitest 4's vi.fn<T>() takes a single function-type argument (not <Args, Return>).
const publicReverifyCredential = vi.fn<() => Promise<VerifyResult | null>>();
vi.mock("@/app/u/[handle]/actions", () => ({
  publicReverifyCredential: (...args: unknown[]) =>
    (publicReverifyCredential as any)(...args),
}));

import { PublicVerifyButton } from "./public-verify-button";

test("shows the seeded initialStatus before any click", () => {
  render(<PublicVerifyButton handle="alice" credentialId="cred-1" initialStatus="verified" />);
  // The status region reflects the last-known status on first paint (not blank).
  const status = screen.getByRole("status");
  expect(status.textContent ?? "").toMatch(/verified/i);
});

test("renders a Check now button and surfaces the live result in a status region", async () => {
  publicReverifyCredential.mockResolvedValue({
    status: "verified",
    method: "ob2_hosted",
    detail: "hosted assertion matches, not revoked",
  });
  render(<PublicVerifyButton handle="alice" credentialId="cred-1" initialStatus="unverified" />);

  const btn = screen.getByRole("button", { name: /check now/i });
  fireEvent.click(btn);

  // The action is invoked with BOTH the viewed handle and the credential id.
  await waitFor(() =>
    expect(publicReverifyCredential).toHaveBeenCalledWith("alice", "cred-1")
  );
  const status = await screen.findByRole("status");
  await waitFor(() => expect(status.textContent ?? "").toMatch(/verified/i));
});

test("shows a failed result honestly", async () => {
  publicReverifyCredential.mockResolvedValue({
    status: "failed",
    method: "ob2_hosted",
    detail: "hosted fetch 404",
  });
  render(<PublicVerifyButton handle="bob" credentialId="cred-2" initialStatus="verified" />);
  fireEvent.click(screen.getByRole("button", { name: /check now/i }));
  const status = await screen.findByRole("status");
  await waitFor(() => expect(status.textContent ?? "").toMatch(/failed/i));
});
