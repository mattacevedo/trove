import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub the server action import so the client-boundary form renders in jsdom.
vi.mock("@/app/app/actions", () => ({ updatePublicProfileEnabled: vi.fn() }));

import { PublishProfileCard } from "./publish-profile-card";

test("shows the public URL and a copy button when enabled", () => {
  render(<PublishProfileCard handle="janedoe" publicProfileEnabled={true} />);
  expect(screen.getByText("/u/janedoe")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
  // Current state is communicated as text, not color alone.
  expect(screen.getByText(/public/i)).toBeInTheDocument();
});

test("the toggle submits the OPPOSITE state (enabled=false when currently public)", () => {
  const { container } = render(
    <PublishProfileCard handle="janedoe" publicProfileEnabled={true} />
  );
  const hidden = container.querySelector('input[name="enabled"]') as HTMLInputElement;
  expect(hidden.value).toBe("false"); // currently public -> button makes it private
  expect(screen.getByRole("button", { name: /make private/i })).toBeInTheDocument();
});

test("when private, the toggle submits enabled=true and no URL/copy is shown", () => {
  const { container } = render(
    <PublishProfileCard handle="janedoe" publicProfileEnabled={false} />
  );
  const hidden = container.querySelector('input[name="enabled"]') as HTMLInputElement;
  expect(hidden.value).toBe("true"); // currently private -> button makes it public
  expect(screen.getByRole("button", { name: /publish|make public/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument();
});
