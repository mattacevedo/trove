import { afterEach, expect, test, vi } from "vitest";

// Mock the server client + redirect so this is a pure unit test (no cookies, no network).
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ auth: { getUser } }),
}));
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

afterEach(() => {
  getUser.mockReset();
  redirect.mockClear();
});

test("returns the user id when authenticated", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-123" } } });
  const { requireUserId } = await import("./require-user");
  await expect(requireUserId()).resolves.toBe("user-123");
  expect(redirect).not.toHaveBeenCalled();
});

test("redirects to /login when there is no user", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  const { requireUserId } = await import("./require-user");
  await expect(requireUserId()).rejects.toThrow("REDIRECT:/login");
  expect(redirect).toHaveBeenCalledWith("/login");
});
