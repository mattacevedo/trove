// lib/billing/stripe.ts
// Stripe adapter (impure) — the ONLY module in the codebase allowed to import the `stripe` package
// (a grep-guard in Task 14 enforces this). It wraps the real SDK behind the SDK-free StripeLike
// interface from lib/billing/types, with an injectable `client` so tests build a fake and never
// construct a real client or read STRIPE_SECRET_KEY. Mirrors lib/advisor/llm.ts's AnthropicLike
// injection pattern and pins the apiVersion literal exactly as that file pins ADVISOR_MODEL.

import Stripe from "stripe";
import type { StripeLike } from "./types";

/** Pinned Stripe API version — a real, dated literal so behavior is stable across SDK bumps. */
export const STRIPE_API_VERSION = "2025-06-30.basil";

/**
 * Stable price-id -> plan-name map. The webhook derives sponsors.plan from THIS map keyed by the
 * subscription item's price.id, NOT from price.nickname/lookup_key (both are dashboard-editable and
 * unreliable). Seeded from env so the same code works across Stripe test/live mode:
 *   STRIPE_PRICE_ID       -> "team" (the single seat price used by Checkout)
 * Extend with more entries as plans are added. An unmapped price falls back to 'free' via
 * planForPriceId — the sponsor still gets subscription_status/id, just no recognized plan label.
 */
export const PLAN_BY_PRICE_ID: Record<string, string> = Object.fromEntries(
  [[process.env.STRIPE_PRICE_ID, "team"]].filter(
    (e): e is [string, string] => typeof e[0] === "string" && e[0].length > 0
  )
);

/** Map a Stripe price id to a plan name, defaulting to 'free' when unknown/absent. */
export function planForPriceId(priceId: string | null | undefined): string {
  if (!priceId) return "free";
  return PLAN_BY_PRICE_ID[priceId] ?? "free";
}

/**
 * Returns a StripeLike. When `opts.client` is provided (tests), it is returned as-is and NO real
 * Stripe client is constructed and NO key is read. Otherwise a real client is built from
 * `opts.apiKey ?? process.env.STRIPE_SECRET_KEY`, pinned to STRIPE_API_VERSION, and up-cast to the
 * minimal StripeLike surface the billing helpers depend on.
 */
export function createStripeClient(opts?: { apiKey?: string; client?: StripeLike }): StripeLike {
  if (opts?.client) return opts.client;
  const stripe = new Stripe(opts?.apiKey ?? process.env.STRIPE_SECRET_KEY ?? "", {
    // The installed SDK types `StripeConfig.apiVersion` as a literal equal to ITS OWN latest pinned
    // version (stripe's lib.d.ts: `apiVersion?: LatestApiVersion`), to steer integrators onto the
    // newest version. Stripe's own doc comment on that field says pinning an older version (as we
    // deliberately do here, for behavior stable across SDK bumps) requires widening the type — hence
    // the cast through `unknown` rather than the SDK's (narrower, version-specific) literal type.
    apiVersion: STRIPE_API_VERSION as unknown as NonNullable<
      ConstructorParameters<typeof Stripe>[1]
    >["apiVersion"],
  });
  return stripe as unknown as StripeLike;
}
