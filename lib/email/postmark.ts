// lib/email/postmark.ts
// Postmark email adapter (impure) — the ONLY module that talks to Postmark. It is fetch-based (NO
// npm dependency): it POSTs to https://api.postmarkapp.com/email with the X-Postmark-Server-Token
// header. Injectable via `fetchImpl` + `token` so tests supply a fake fetch and never read the real
// POSTMARK_SERVER_TOKEN or make a network call. Returns the SDK-free EmailSender from lib/billing/types.

import type { EmailSender } from "@/lib/billing/types";

const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";

/** From-address for all Trove transactional mail. Overridable via env for non-prod senders. */
const FROM_ADDRESS = process.env.POSTMARK_FROM_EMAIL ?? "Trove <no-reply@trove.app>";

export function createPostmarkSender(opts?: {
  token?: string;
  fetchImpl?: typeof fetch;
}): EmailSender {
  const doFetch = opts?.fetchImpl ?? fetch;
  return {
    async send(input) {
      const token = opts?.token ?? process.env.POSTMARK_SERVER_TOKEN ?? "";
      const response = await doFetch(POSTMARK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Postmark-Server-Token": token,
        },
        body: JSON.stringify({
          From: FROM_ADDRESS,
          To: input.to,
          Subject: input.subject,
          HtmlBody: input.htmlBody,
          TextBody: input.textBody,
          MessageStream: "outbound",
        }),
      });

      if (!response.ok) {
        let message = `Postmark send failed (HTTP ${response.status})`;
        try {
          const payload = (await response.json()) as { Message?: string };
          if (payload?.Message) message = payload.Message;
        } catch {
          // Non-JSON error body — keep the HTTP-status message above.
        }
        throw new Error(message);
      }
    },
  };
}
