import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

// vi.mock factories hoist above top-level consts; vi.hoisted lifts the mocks alongside
// (established repo pattern — see chat-pane.test.tsx / actions tests).
const { verifyOtp, exchangeCodeForSession, getUser, provisionEarner } = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  provisionEarner: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    auth: { verifyOtp, exchangeCodeForSession, getUser },
  }),
}));
vi.mock("@/lib/auth/provision-earner", () => ({ provisionEarner }));

import { GET } from "./route";

afterEach(() => {
  verifyOtp.mockReset();
  exchangeCodeForSession.mockReset();
  getUser.mockReset();
  provisionEarner.mockReset();
});

function req(qs: string) {
  return new NextRequest(`https://trove.example/auth/confirm${qs}`);
}

test("token_hash flow: verifies, provisions, redirects to /app", async () => {
  verifyOtp.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.co" } } });
  provisionEarner.mockResolvedValue({ handle: "a-1234" });

  const res = await GET(req("?token_hash=th_abc&type=email"));
  expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "th_abc" });
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
  expect(res.headers.get("location")).toBe("https://trove.example/app");
});

test("code flow (default Supabase email template): exchanges, provisions, redirects to /app", async () => {
  exchangeCodeForSession.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: { id: "u2", email: "c@d.co" } } });
  provisionEarner.mockResolvedValue({ handle: "c-5678" });

  const res = await GET(req("?code=pkce_code_123"));
  expect(exchangeCodeForSession).toHaveBeenCalledWith("pkce_code_123");
  expect(verifyOtp).not.toHaveBeenCalled();
  expect(provisionEarner).toHaveBeenCalled();
  expect(res.headers.get("location")).toBe("https://trove.example/app");
});

test("failed code exchange redirects to /login?error=1 and never provisions", async () => {
  exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });

  const res = await GET(req("?code=stale"));
  expect(res.headers.get("location")).toBe("https://trove.example/login?error=1");
  expect(provisionEarner).not.toHaveBeenCalled();
});

test("no recognized params redirects to /login?error=1", async () => {
  const res = await GET(req(""));
  expect(verifyOtp).not.toHaveBeenCalled();
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
  expect(res.headers.get("location")).toBe("https://trove.example/login?error=1");
});
