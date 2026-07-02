import { afterAll, expect, test } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];

// A fresh, unauthenticated anon-key client — mirrors lib/supabase/client.ts, no session.
function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("anon cannot read a private earner's profile or credentials, but the owner still can", async () => {
  const owner = await makeUserClient(`pub-${Date.now()}@example.com`);
  created.push(owner.userId);
  const handle = `pp${Date.now()}`;

  // Seed an earner with public_profile_enabled defaulting to false, plus one credential.
  await owner.client
    .from("earners")
    .insert({ id: owner.userId, handle, display_name: "Test Earner" });
  await owner.client
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Private Cred" });

  const anon = anonClient();

  // (1) private: anon sees zero rows on both tables.
  const anonEarner = await anon.from("earners").select("*").eq("handle", handle);
  expect(anonEarner.data).toEqual([]);
  const anonCreds = await anon.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(anonCreds.data).toEqual([]);

  // (1b) ENUMERATION PARITY: an EXISTING-but-disabled handle must be byte-for-byte
  // indistinguishable at the query level from a handle that was never created. Both must
  // return exactly the same zero-row result and no error — otherwise an attacker could tell
  // "opted-out but exists" from "does not exist" (the missing==disabled invariant).
  const neverHandle = `nope${Date.now()}`;
  const anonMissing = await anon.from("earners").select("*").eq("handle", neverHandle);
  expect(anonMissing.error).toBeNull();
  expect(anonEarner.error).toBeNull();
  expect(anonMissing.data).toEqual(anonEarner.data); // both [] — no distinguishing signal

  // (5) additive proof: the OWNER's own self-access is unaffected while private.
  const ownEarner = await owner.client.from("earners").select("*").eq("id", owner.userId);
  expect(ownEarner.data).toHaveLength(1);
  const ownCreds = await owner.client.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(ownCreds.data).toHaveLength(1);

  // (2) flip public_profile_enabled true -> anon can now read both.
  await owner.client
    .from("earners")
    .update({ public_profile_enabled: true })
    .eq("id", owner.userId);

  const anonEarner2 = await anon.from("earners").select("handle, display_name").eq("handle", handle);
  expect(anonEarner2.data).toHaveLength(1);
  expect(anonEarner2.data![0].display_name).toBe("Test Earner");
  const anonCreds2 = await anon
    .from("credentials")
    .select("id, title, raw_json")
    .eq("earner_id", owner.userId);
  expect(anonCreds2.data).toHaveLength(1);
  expect(anonCreds2.data![0].title).toBe("Private Cred");
  // raw_json is readable to anon (present as a key, even if null). The public PAGE query does NOT
  // select it (card fields only); it is read on-demand by the verify action. This assertion documents
  // the accepted policy-level tradeoff (see the migration comment) — the whole row is anon-selectable.
  expect(anonCreds2.data![0]).toHaveProperty("raw_json");

  // (3) toggle back to false -> anon access disappears again (no staleness; EXISTS re-evaluates).
  await owner.client
    .from("earners")
    .update({ public_profile_enabled: false })
    .eq("id", owner.userId);
  const anonEarner3 = await anon.from("earners").select("*").eq("handle", handle);
  expect(anonEarner3.data).toEqual([]);
  const anonCreds3 = await anon.from("credentials").select("*").eq("earner_id", owner.userId);
  expect(anonCreds3.data).toEqual([]);
});

test("anon cannot write to earners or credentials regardless of public_profile_enabled", async () => {
  const owner = await makeUserClient(`pubw-${Date.now()}@example.com`);
  created.push(owner.userId);
  const handle = `ppw${Date.now()}`;
  await owner.client
    .from("earners")
    .insert({ id: owner.userId, handle, public_profile_enabled: true });
  const { data: credRow } = await owner.client
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Owned" })
    .select("id")
    .single();

  const anon = anonClient();

  // A robust "write was denied" assertion: under RLS a disallowed write either returns an error
  // OR returns zero affected rows (PostgREST behavior differs by verb) — both are acceptable, a
  // NON-empty data array is NOT. Pinning to exactly one behavior is brittle (undocumented), so
  // accept either and separately PROVE the row is unchanged via the owner client below.
  const writeDenied = (r: { data: unknown; error: unknown }) =>
    r.error != null || ((r.data as unknown[] | null) ?? []).length === 0;

  // anon UPDATE of verification_status: RLS matches no update policy.
  const upd = await anon
    .from("credentials")
    .update({ verification_status: "verified" })
    .eq("id", credRow!.id)
    .select();
  expect(writeDenied(upd)).toBe(true);

  // Prove the UPDATE did not land: owner still sees the original 'unverified'.
  const { data: afterUpd } = await owner.client
    .from("credentials")
    .select("verification_status")
    .eq("id", credRow!.id)
    .single();
  expect(afterUpd!.verification_status).toBe("unverified");

  // anon INSERT into either table is rejected (no anon insert policy).
  const insCred = await anon
    .from("credentials")
    .insert({ earner_id: owner.userId, source: "manual", title: "Injected" });
  expect(insCred.error).not.toBeNull();
  const insEarner = await anon
    .from("earners")
    .insert({ id: crypto.randomUUID(), handle: `x${Date.now()}` });
  expect(insEarner.error).not.toBeNull();

  // anon DELETE is denied (error or zero rows).
  const del = await anon.from("credentials").delete().eq("id", credRow!.id).select();
  expect(writeDenied(del)).toBe(true);

  // Final confirmation: the row still exists and is untouched after all write attempts.
  const { data: after } = await owner.client
    .from("credentials")
    .select("verification_status")
    .eq("id", credRow!.id)
    .single();
  expect(after!.verification_status).toBe("unverified");
});
