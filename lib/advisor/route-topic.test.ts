import { expect, test } from "vitest";
import { shouldUseWebSearch } from "./route-topic";

test.each([
  // External / time-sensitive -> ON
  ["What jobs pay well right now near me?", true],
  ["Are there any openings this week?", true],
  ["Who is hiring in my area?", true],
  ["What is the application deadline?", true],
  ["Show me the latest job listings", true],
  ["How much do nurses make near me right now?", true],
  // Evergreen / answerable from context -> OFF (these previously flipped ON under bare
  // salary/pay/currently/today keywords and wasted a billable search)
  ["What does a nurse get paid?", false],
  ["What is the typical salary for a welder?", false],
  ["What am I currently qualified for?", false],
  ["What should I do today to get started?", false],
  ["What skills do I need to become a nurse?", false],
  ["Explain what my RN license qualifies me for", false],
  ["", false],
])("shouldUseWebSearch(%j) === %s", (msg, expected) => {
  expect(shouldUseWebSearch(msg)).toBe(expected);
});
