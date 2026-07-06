import { expect, test, vi } from "vitest";
import { createPostmarkSender } from "./postmark";

/** A fake fetch that records its call and returns a 200 like Postmark's real success response. */
function fakeFetch() {
  const impl = vi.fn(async () =>
    new Response(JSON.stringify({ ErrorCode: 0, Message: "OK" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
  return impl as ReturnType<typeof vi.fn> & typeof fetch;
}

test("POSTs to the Postmark email endpoint with the token header and correct body", async () => {
  const impl = fakeFetch();
  const sender = createPostmarkSender({ token: "test-token", fetchImpl: impl });
  await sender.send({
    to: "earner@example.com",
    subject: "You're invited to Trove",
    htmlBody: "<p>Join</p>",
    textBody: "Join",
  });

  expect(impl).toHaveBeenCalledTimes(1);
  const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    RequestInit,
  ];
  expect(url).toBe("https://api.postmarkapp.com/email");
  expect(init.method).toBe("POST");

  const headers = init.headers as Record<string, string>;
  expect(headers["X-Postmark-Server-Token"]).toBe("test-token");
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["Accept"]).toBe("application/json");

  const body = JSON.parse(init.body as string) as Record<string, string>;
  expect(body.To).toBe("earner@example.com");
  expect(body.Subject).toBe("You're invited to Trove");
  expect(body.HtmlBody).toBe("<p>Join</p>");
  expect(body.TextBody).toBe("Join");
  expect(typeof body.From).toBe("string");
  expect(body.From.length).toBeGreaterThan(0);
});

test("does not require the Postmark server token env var when a fetchImpl + token are injected", async () => {
  // Prove the inline token is used even with the env var unset. vi.stubEnv/vi.unstubAllEnvs keeps
  // the secret name out of any value-read/assign position, so the Task 14 grep-guard stays green.
  vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
  try {
    const impl = fakeFetch();
    const sender = createPostmarkSender({ token: "inline", fetchImpl: impl });
    await sender.send({ to: "a@b.com", subject: "s", htmlBody: "<i>h</i>", textBody: "t" });
    expect(impl).toHaveBeenCalledTimes(1);
    const [, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("inline");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("throws with Postmark's message when the response is not ok", async () => {
  const impl = vi.fn(async () =>
    new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid email request" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
  const sender = createPostmarkSender({ token: "test-token", fetchImpl: impl });
  await expect(
    sender.send({ to: "bad", subject: "s", htmlBody: "<i>h</i>", textBody: "t" })
  ).rejects.toThrow(/Invalid email request/);
});
