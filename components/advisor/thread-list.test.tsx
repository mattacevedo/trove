import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/app/advisor/actions", () => ({ createAdvisorThread: vi.fn() }));
import { ThreadList } from "./thread-list";

test("renders thread titles, a New conversation CTA, and marks the active thread", () => {
  render(
    <ThreadList
      threads={[
        { id: "t1", title: "Nursing path", createdAt: "" },
        { id: "t2", title: "Next steps", createdAt: "" },
      ]}
      activeThreadId="t2"
    />
  );
  expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument();
  expect(screen.getByText("Nursing path")).toBeInTheDocument();
  expect(screen.getByText("Next steps").closest("a")).toHaveAttribute("aria-current", "page");
});
