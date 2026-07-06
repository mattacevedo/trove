import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CohortInvite, EmailSender } from "@/lib/billing/types";
import { generateInviteToken, inviteCohort } from "./invite";

// ---- fakes ----

/** An existing invite row this fake db is pre-seeded with, keyed by "sponsorId:email". */
type ExistingInvite = { id: string; token: string; accepted_at: string | null };

/**
 * A stand-in for the `cohort_invites` table + the `reinvite_cohort_member` RPC covering every path
 * inviteCohort exercises:
 *  - insert(row).select("...").single() -> { data, error }: a pre-seeded key simulates the
 *    UNIQUE(sponsor_id,email) constraint (23505) for that row.
 *  - select("id, token, accepted_at").eq(sponsor_id).eq(email).single(): the CAUSE F 23505 recovery
 *    lookup, returning whichever `ExistingInvite` was seeded for that key.
 *  - db.rpc("reinvite_cohort_member", {target_sponsor, invite_email, new_token}): models migration
 *    0010 — returns [{ token: new_token }] when `opts.reinvitable` includes the email (simulating a
 *    'removed' member the RPC found and rotated), or [] otherwise (still active / no account / no
 *    membership at all). inviteCohort must never touch cohort_members/auth.users directly — that
 *    join lives entirely behind this RPC.
 */
function fakeDb(opts?: {
  existing?: Record<string, ExistingInvite>;
  reinvitable?: Set<string>;
}): {
  db: SupabaseClient;
  inserted: Array<{ sponsor_id: string; email: string; token: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const rows = new Map(Object.entries(opts?.existing ?? {}));
  const inserted: Array<{ sponsor_id: string; email: string; token: string }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const from = vi.fn((table: string) => {
    if (table !== "cohort_invites") throw new Error(`unexpected table ${table}`);
    return {
      insert(row: { sponsor_id: string; email: string; token: string }) {
        const key = `${row.sponsor_id}:${row.email}`;
        return {
          select() {
            return {
              async single() {
                if (rows.has(key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key" } };
                }
                rows.set(key, { id: `id-${inserted.length + 1}`, token: row.token, accepted_at: null });
                inserted.push(row);
                const invite: CohortInvite = {
                  id: rows.get(key)!.id,
                  sponsorId: row.sponsor_id,
                  email: row.email,
                  token: row.token,
                  acceptedAt: null,
                  createdAt: "2026-07-03T00:00:00Z",
                };
                return {
                  data: {
                    id: invite.id,
                    sponsor_id: invite.sponsorId,
                    email: invite.email,
                    token: invite.token,
                    accepted_at: invite.acceptedAt,
                    created_at: invite.createdAt,
                  },
                  error: null,
                };
              },
            };
          },
        };
      },
      // CAUSE F 23505 recovery lookup: select(...).eq(sponsor_id).eq(email).single()
      select(_cols: string) {
        let sponsorId: string | undefined;
        let email: string | undefined;
        const builder = {
          eq(col: string, val: string) {
            if (col === "sponsor_id") sponsorId = val;
            if (col === "email") email = val;
            return builder;
          },
          async single() {
            const row = rows.get(`${sponsorId}:${email}`) ?? null;
            return {
              data: row,
              error: row ? null : { code: "PGRST116", message: "no rows" },
            };
          },
        };
        return builder;
      },
    };
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn !== "reinvite_cohort_member") throw new Error(`unexpected rpc ${fn}`);
    const email = args.invite_email as string;
    if (opts?.reinvitable?.has(email)) {
      return { data: [{ token: args.new_token as string }], error: null };
    }
    return { data: [], error: null };
  });

  return { db: { from, rpc } as unknown as SupabaseClient, inserted, rpcCalls };
}

function fakeSender(): { sender: EmailSender; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { sender: { send }, send };
}

// ---- tests ----

test("generateInviteToken returns a url-safe token with no +, /, or = characters", () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThanOrEqual(32);
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("inserts one invite per email and sends one email each with an /invite/{token} link", async () => {
  const { db, inserted } = fakeDb();
  const { sender, send } = fakeSender();
  const result = await inviteCohort(db, sender, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["a@x.com", "b@x.com"],
    origin: "https://trove.test",
  });

  expect(result.invited.map((i) => i.email)).toEqual(["a@x.com", "b@x.com"]);
  expect(result.skipped).toEqual([]);
  expect(inserted).toHaveLength(2);
  expect(send).toHaveBeenCalledTimes(2);

  const firstCall = send.mock.calls[0][0] as { to: string; subject: string; htmlBody: string; textBody: string };
  expect(firstCall.to).toBe("a@x.com");
  expect(firstCall.subject).toContain("Acme");
  const link = `https://trove.test/invite/${inserted[0].token}`;
  expect(firstCall.htmlBody).toContain(link);
  expect(firstCall.textBody).toContain(link);
});

test("skips an already-invited email whose invite is accepted and not reinvitable (unique collision)", async () => {
  // "dupe@x.com" already has an ACCEPTED invite, and the reinvite_cohort_member RPC finds no
  // 'removed' member to reactivate (opts.reinvitable is empty) — the historical "just skip" behavior.
  const { db } = fakeDb({
    existing: {
      "sp1:dupe@x.com": { id: "inv-dupe", token: "tok-dupe", accepted_at: "2026-06-01T00:00:00Z" },
    },
  });
  const { sender, send } = fakeSender();
  const result = await inviteCohort(db, sender, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["dupe@x.com", "fresh@x.com"],
    origin: "https://trove.test",
  });

  expect(result.invited.map((i) => i.email)).toEqual(["fresh@x.com"]);
  expect(result.skipped).toEqual(["dupe@x.com"]);
  expect(send).toHaveBeenCalledTimes(1);
  expect((send.mock.calls[0][0] as { to: string }).to).toBe("fresh@x.com");
});

test("escapes HTML in sponsorName within htmlBody but keeps textBody raw", async () => {
  const { db } = fakeDb();
  const { sender, send } = fakeSender();
  const evilName = "Evil <img src=x onerror=alert(1)> Org";
  await inviteCohort(db, sender, {
    sponsorId: "sp1",
    sponsorName: evilName,
    emails: ["a@x.com"],
    origin: "https://trove.test",
  });

  expect(send).toHaveBeenCalledTimes(1);
  const call = send.mock.calls[0][0] as { htmlBody: string; textBody: string };
  expect(call.htmlBody).not.toContain("<img");
  expect(call.htmlBody).toContain("&lt;img");
  expect(call.textBody).toContain(evilName);
});

test("does not send an email if the insert failed for a non-collision reason", async () => {
  // Force a non-23505 error by monkeypatching the chain to reject-shape.
  const send = vi.fn();
  const db = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: null, error: { code: "XXAAA", message: "boom" } }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  await expect(
    inviteCohort(db, { send }, {
      sponsorId: "sp1",
      sponsorName: "Acme",
      emails: ["a@x.com"],
      origin: "https://trove.test",
    })
  ).rejects.toThrow(/boom/);
  expect(send).not.toHaveBeenCalled();
});

// ---- CAUSE F: per-send failure isolation + 23505 resend/re-invite sub-paths ----

/**
 * A richer fake supporting the CAUSE F paths:
 *  - cohort_invites insert: 23505 for pre-seeded (sponsor_id,email) keys, like `fakeDb` above.
 *  - cohort_invites select (by sponsor_id+email): returns the seeded existing invite row (token,
 *    accepted_at), so the 23505 handler can decide between resend (unaccepted) and the RPC path
 *    (accepted).
 *  - rpc("reinvite_cohort_member", ...): models migration 0010 — returns a NEW token when the
 *    matching member's status is 'removed' (seeded via `opts.reinviteReturnsToken`), or an empty
 *    array otherwise (still active / no such member), mirroring the RPC's `returns table` shape.
 *    invite.ts must never touch cohort_members directly — that join lives entirely behind the RPC
 *    (only a SECURITY DEFINER function can resolve an invite's email to an earner via auth.users).
 */
function causeFFakeDb(opts: {
  existingInvites: Array<{
    sponsor_id: string;
    email: string;
    id: string;
    token: string;
    accepted_at: string | null;
  }>;
  reinviteReturnsToken?: string | null;
}): {
  db: SupabaseClient;
  inserted: Array<{ sponsor_id: string; email: string; token: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const inserted: Array<{ sponsor_id: string; email: string; token: string }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const invites = new Map(
    opts.existingInvites.map((inv) => [`${inv.sponsor_id}:${inv.email}`, { ...inv }])
  );

  const from = vi.fn((table: string) => {
    if (table !== "cohort_invites") throw new Error(`unexpected table ${table}`);
    return {
      insert(row: { sponsor_id: string; email: string; token: string }) {
        const key = `${row.sponsor_id}:${row.email}`;
        return {
          select() {
            return {
              async single() {
                if (invites.has(key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key" } };
                }
                const invite = {
                  id: `id-${inserted.length + 1}`,
                  sponsor_id: row.sponsor_id,
                  email: row.email,
                  token: row.token,
                  accepted_at: null,
                };
                invites.set(key, invite);
                inserted.push(row);
                return { data: { ...invite, created_at: "2026-07-05T00:00:00Z" }, error: null };
              },
            };
          },
        };
      },
      select() {
        return {
          eq(_c1: string, sponsorId: string) {
            return {
              eq(_c2: string, email: string) {
                return {
                  async single() {
                    const row = invites.get(`${sponsorId}:${email}`) ?? null;
                    return { data: row, error: row ? null : { code: "PGRST116", message: "no rows" } };
                  },
                };
              },
            };
          },
        };
      },
    };
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "reinvite_cohort_member") {
      const token = opts.reinviteReturnsToken;
      return { data: token ? [{ token }] : [], error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });

  return { db: { from, rpc } as unknown as SupabaseClient, inserted, rpcCalls };
}

test("CAUSE F: a per-address send failure is caught, recorded in `failed`, and does not abort the batch", async () => {
  const { db } = fakeDb();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("postmark 500"))
    .mockResolvedValueOnce(undefined);
  const result = await inviteCohort(db, { send }, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["fails@x.com", "ok@x.com"],
    origin: "https://trove.test",
  });

  // Both rows were inserted (the DB write succeeded for both); only the SEND failed for the first.
  expect(result.invited.map((i) => i.email)).toEqual(["fails@x.com", "ok@x.com"]);
  expect(result.failed).toEqual(["fails@x.com"]);
  expect(result.skipped).toEqual([]);
  expect(send).toHaveBeenCalledTimes(2);
});

test("CAUSE F 23505-a: an existing UNACCEPTED invite is RESENT with its stored token (not skipped silently)", async () => {
  const { db, rpcCalls } = causeFFakeDb({
    existingInvites: [
      { sponsor_id: "sp1", email: "pending@x.com", id: "inv-1", token: "tok-original", accepted_at: null },
    ],
  });
  const send = vi.fn().mockResolvedValue(undefined);
  const result = await inviteCohort(db, { send }, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["pending@x.com"],
    origin: "https://trove.test",
  });

  // Resend uses the ORIGINAL token (no rotation for a still-open invite) — the RPC is never called.
  expect(rpcCalls).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(1);
  const call = send.mock.calls[0][0] as { to: string; htmlBody: string };
  expect(call.to).toBe("pending@x.com");
  expect(call.htmlBody).toContain("https://trove.test/invite/tok-original");
  // Honest bookkeeping: not silently skipped, and not double-counted as a fresh insert.
  expect(result.skipped).toEqual([]);
  expect(result.resent).toEqual(["pending@x.com"]);
});

test("CAUSE F 23505-b: an accepted invite whose member was REMOVED is re-invited via the reinvite_cohort_member RPC", async () => {
  const { db, rpcCalls } = causeFFakeDb({
    existingInvites: [
      {
        sponsor_id: "sp1",
        email: "rejoin@x.com",
        id: "inv-2",
        token: "tok-old",
        accepted_at: "2026-06-01T00:00:00Z",
      },
    ],
    reinviteReturnsToken: "tok-rotated",
  });
  const send = vi.fn().mockResolvedValue(undefined);
  const result = await inviteCohort(db, { send }, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["rejoin@x.com"],
    origin: "https://trove.test",
  });

  // The RPC was called with the sponsor + email (and a freshly generated candidate token) — the join
  // from email -> earner -> cohort_members lives entirely behind it (0010).
  expect(rpcCalls).toHaveLength(1);
  expect(rpcCalls[0].fn).toBe("reinvite_cohort_member");
  expect(rpcCalls[0].args.target_sponsor).toBe("sp1");
  expect(rpcCalls[0].args.invite_email).toBe("rejoin@x.com");
  expect(typeof rpcCalls[0].args.new_token).toBe("string");

  // The email link uses the RPC's returned (rotated) token, not the stale original.
  expect(send).toHaveBeenCalledTimes(1);
  const call = send.mock.calls[0][0] as { to: string; htmlBody: string };
  expect(call.to).toBe("rejoin@x.com");
  expect(call.htmlBody).toContain("https://trove.test/invite/tok-rotated");
  expect(call.htmlBody).not.toContain("tok-old");
  expect(result.skipped).toEqual([]);
  expect(result.resent).toEqual(["rejoin@x.com"]);
});

test("CAUSE F 23505-c: an accepted invite whose member is still ACTIVE (RPC returns no row) is skipped as today", async () => {
  const { db, rpcCalls } = causeFFakeDb({
    existingInvites: [
      {
        sponsor_id: "sp1",
        email: "active@x.com",
        id: "inv-3",
        token: "tok-active",
        accepted_at: "2026-06-01T00:00:00Z",
      },
    ],
    reinviteReturnsToken: null, // RPC found no 'removed' member -> empty result set
  });
  const send = vi.fn().mockResolvedValue(undefined);
  const result = await inviteCohort(db, { send }, {
    sponsorId: "sp1",
    sponsorName: "Acme",
    emails: ["active@x.com"],
    origin: "https://trove.test",
  });

  expect(rpcCalls).toHaveLength(1); // still attempted — the RPC itself is the authority on eligibility
  expect(send).not.toHaveBeenCalled();
  expect(result.skipped).toEqual(["active@x.com"]);
  expect(result.resent ?? []).toEqual([]);
});
