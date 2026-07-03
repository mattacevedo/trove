"use server";

import { createServerClient } from "@/lib/supabase/server";
import { verifyCredential } from "@/lib/credentials/verify";
import type { VerifyResult, CredentialSource } from "@/lib/credentials/types";
import { boundedFetch } from "./bounded-fetch";

// NOTE: the SSRF-bounded fetch (`makeBoundedFetch` / `boundedFetch` / `isBlockedLiteralIp`) lives in
// ./bounded-fetch, NOT here. A "use server" module may only export async Server Actions, so the
// non-async fetch helpers must not be exported from this file (doing so breaks `next build` with
// "Server Actions must be async functions"). This module exports exactly one thing: the async action.

/**
 * READ-ONLY on-demand re-verify for anonymous public-profile viewers (spec §5). Re-loads raw_json
 * through the anon-RLS path (credentials_public_select, 0005 — inherits the public_profile_enabled
 * gate), JOINED to the viewed handle so a viewer can only re-verify credentials on the profile they
 * are on (defense-in-depth; shrinks the SSRF trigger set). Runs the unmodified verifyCredential with
 * the bounded fetch and RETURNS the transient result for display. It NEVER calls .update()/.upsert():
 * anon has no write policy, and persisting a viewer-triggered status would be wrong. Returns null
 * when no matching row is visible (private, nonexistent, or belongs to a different handle).
 */
export async function publicReverifyCredential(
  handle: string,
  credentialId: string
): Promise<VerifyResult | null> {
  const supabase = await createServerClient();
  // The embedded !inner join filters credentials to those whose parent earner has this handle;
  // combined with credentials_public_select (0005), only published credentials on THIS profile match.
  const { data: cred } = await supabase
    .from("credentials")
    .select("id, source, raw_json, earners!inner(handle)")
    .eq("id", credentialId)
    .eq("earners.handle", handle)
    .maybeSingle();
  if (!cred) return null;

  return verifyCredential(
    { source: cred.source as CredentialSource, raw_json: cred.raw_json ?? null },
    { fetchImpl: boundedFetch }
  );
}
