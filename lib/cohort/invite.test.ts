import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CohortInvite, EmailSender } from "@/lib/billing/types";
import { generateInviteToken, inviteCohort } from "./invite";

// ---- fakes ----

/** A minimal in-memory stand-in for the `cohort_invites` insert chain the code uses:
 *  db.from("cohort_invites").insert(row).select("...").single() -> { data, error }.
 *  A pre-seeded set of (sponsor_id,email) keys simulates the UNIQUE(sponsor_id,email)
 *  constraint by returning a Postgres 23505 error for those rows (=> skip, not throw). */
function fakeDb(existingKeys: string[] = []): {
  db: SupabaseClient;
  inserted: Array<{ sponsor_id: string; email: string; token: string }>;
} {
  const existing = new Set(existingKeys);
  const inserted: Array<{ sponsor_id: string; email: string; token: string }> = [];
  const from = vi.fn((table: string) => {
    if (table !== "cohort_invites") throw new Error(`unexpected table ${table}`);
    return {
      insert(row: { sponsor_id: string; email: string; token: string }) {
        const key = `${row.sponsor_id}:${row.email}`;
        return {
          select() {
            return {
              async single() {
                if (existing.has(key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key" } };
                }
                existing.add(key);
                inserted.push(row);
                const invite: CohortInvite = {
                  id: `id-${inserted.length}`,
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
    };
  });
  return { db: { from } as unknown as SupabaseClient, inserted };
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

test("skips an already-invited email (unique collision) without sending or throwing", async () => {
  const { db } = fakeDb(["sp1:dupe@x.com"]);
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
