import { afterEach, expect, test, vi } from "vitest";

// Mock the server client + redirect so this is a pure unit test (no cookies, no network).
const getUser = vi.fn();
const order = vi.fn();

function makeClient() {
  return {
    auth: { getUser },
    from: (table: string) => {
      if (table !== "sponsor_admins") throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string) => ({
          order: (_col: string, _opts: unknown) => order(),
        }),
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => makeClient(),
}));

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`); // mimic Next's control-flow throw
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

afterEach(() => {
  getUser.mockReset();
  order.mockReset();
  redirect.mockClear();
});

test("returns userId + first sponsorId when the user administers a sponsor", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({
    data: [{ sponsor_id: "sp-A" }, { sponsor_id: "sp-B" }],
    error: null,
  });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).resolves.toEqual({
    userId: "user-1",
    sponsorId: "sp-A",
  });
  expect(redirect).not.toHaveBeenCalled();
});

test("redirects to /login when unauthenticated", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/login");
  expect(redirect).toHaveBeenCalledWith("/login");
});

test("redirects to /sponsor/new when the user administers no sponsor", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({ data: [], error: null });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/sponsor/new");
  expect(redirect).toHaveBeenCalledWith("/sponsor/new");
});

test("redirects to /sponsor/new when the query errors", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  order.mockResolvedValue({ data: null, error: { message: "boom" } });
  const { requireSponsorAdmin } = await import("./require-sponsor-admin");
  await expect(requireSponsorAdmin()).rejects.toThrow("REDIRECT:/sponsor/new");
  expect(redirect).toHaveBeenCalledWith("/sponsor/new");
});
