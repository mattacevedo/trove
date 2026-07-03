import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi, beforeEach } from "vitest";

// vi.mock is hoisted above module scope, so the factory can't close over a plain top-level
// const. vi.hoisted lifts the mock fn alongside it (matching the indirection in
// public-verify-button.test.tsx, which never lets a test touch the real Server Action).
const { sendAdvisorMessage } = vi.hoisted(() => ({ sendAdvisorMessage: vi.fn() }));
vi.mock("@/app/app/advisor/actions", () => ({ sendAdvisorMessage }));

import { ChatPane } from "./chat-pane";

beforeEach(() => sendAdvisorMessage.mockReset());

test("submitting renders the user bubble, the assistant reply, and a flagged occupation card", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: true,
    message: {
      id: "m1",
      threadId: "t1",
      role: "assistant",
      content: "You may qualify for nursing roles.",
      tokenCost: 10,
      createdAt: "",
    },
    // An OccupationCard payload (gap + reliesOnUnverified). The card's amber unverified flag must
    // render, proving the flag is wired end-to-end (not a structurally-dead prop).
    occupationCards: [
      {
        gap: {
          occupationId: "A",
          occupationName: "Registered Nurse",
          haveSkillIds: ["s1"],
          missingSkillNames: ["Critical Thinking"],
          haveCount: 1,
          totalCount: 3,
          coveragePct: 33,
        },
        reliesOnUnverified: true,
      },
    ],
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.type(screen.getByLabelText(/message the advisor/i), "what next?");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText("what next?")).toBeInTheDocument();
  expect(await screen.findByText(/you may qualify for nursing roles/i)).toBeInTheDocument();
  expect(await screen.findByText(/unverified credential/i)).toBeInTheDocument();
  expect(sendAdvisorMessage).toHaveBeenCalledWith("t1", "what next?");
});

test("a rate_limited result shows an inline notice and no assistant bubble", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: false,
    reason: "rate_limited",
    retryAt: "2026-07-03T00:00:00Z",
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.type(screen.getByLabelText(/message the advisor/i), "one more");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/today's advisor limit/i);
});

test("starter prompts show when empty and submit through the same action path", async () => {
  sendAdvisorMessage.mockResolvedValue({
    ok: true,
    message: { id: "m", threadId: "t1", role: "assistant", content: "ok", tokenCost: 1, createdAt: "" },
    occupationCards: [],
  });
  render(<ChatPane threadId="t1" initialMessages={[]} />);
  await userEvent.click(screen.getByRole("button", { name: "What jobs fit my skills?" }));
  expect(sendAdvisorMessage).toHaveBeenCalledWith("t1", "What jobs fit my skills?");
});
