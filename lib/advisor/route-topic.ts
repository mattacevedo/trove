// Pure, deterministic decision: should this message enable Anthropic's web_search tool?
// Web search costs extra, so it is OFF by default and only turned on for clearly time-sensitive
// or external questions (design doc §6.4). No LLM call is used to decide this.

// Signals that a question is genuinely EXTERNAL/time-sensitive and worth the extra billable
// web_search call. Deliberately narrow: bare "salary"/"pay"/"currently"/"today" are DROPPED
// because they fire on common evergreen questions ("what does a nurse get paid?", "what am I
// currently qualified for?") that the model answers from the provided context — turning search on
// for those undercuts the "web search only when external" cost control. We require phrasing that
// implies live external data: job listings, local scoping, explicit recency, or deadlines.
const WEB_SEARCH_SIGNALS: RegExp[] = [
  /\bopenings?\b/i,
  /\bhiring\b/i,
  /\bjob (post|listing|opening)/i,
  /\bwho('?s| is) hiring\b/i,
  /\bnear me\b/i,
  /\bin my area\b/i,
  /\bthis (week|month|year)\b/i,
  /\bright now\b/i,
  /\blatest\b/i,
  /\bdeadlines?\b/i,
  /\bapplication (window|period|deadline)\b/i,
  /\bhow much (do|does|are) .*\b(pay|paid|make|earn)\b.*\b(now|today|currently|this year|near me|in my area)\b/i,
];

export function shouldUseWebSearch(userMessage: string): boolean {
  return WEB_SEARCH_SIGNALS.some((re) => re.test(userMessage));
}
