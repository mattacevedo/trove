// lib/billing/types.ts
// Canonical, SDK-free types for the Sponsor Console + Stripe billing subsystem (Plan 6).
// This is the ONLY billing module that imports nothing external — it mirrors lib/advisor/types.ts
// (pure core, dependency-free, unit-testable by construction). Every other lib/billing/* file and
// every /sponsor/* route imports its shapes from HERE, never from the `stripe` package directly.
// Keeping the `stripe` SDK out of this file is what lets tests build fakes without touching the SDK.

/** A sponsor org row as consumed by billing code (camelCase; snake_case DB cols are mapped at the edge). */
export interface SponsorRow {
  id: string;
  name: string;
  plan: string;
  seats: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string;
}

/** A pending/accepted cohort invite (keyed by EMAIL — the invitee has no earner row until signup). */
export interface CohortInvite {
  id: string;
  sponsorId: string;
  email: string;
  token: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** Privacy-preserving aggregate funnel counts for a sponsor (no per-earner rows ever exposed). */
export interface EngagementMetrics {
  invited: number;
  activated: number;
  imported: number;
  advisorUsed: number;
}

/** One row of consented aggregate skill coverage (member_count across consenting members). */
export interface SkillCoverageRow {
  skillName: string;
  memberCount: number;
}

/** The subset of a sponsor's billing state shown on /sponsor/billing. */
export interface BillingSummary {
  plan: string;
  subscriptionStatus: string;
  seats: number;
  stripeCustomerId: string | null;
}

/** Injectable email boundary. The real impl (lib/email/postmark.ts) POSTs to Postmark; tests fake it. */
export interface EmailSender {
  send(input: { to: string; subject: string; htmlBody: string; textBody: string }): Promise<void>;
}

/**
 * The minimal subset of the Stripe SDK the billing code actually calls. Every billing helper takes a
 * `StripeLike` (never the concrete `Stripe` class) so tests inject a hand-written fake and NEVER
 * construct a real client or read a real key. Mirrors AnthropicLike in lib/advisor/llm.ts.
 */
export interface StripeLike {
  customers: {
    create(args: unknown): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(args: unknown): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(args: unknown): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<{
      id: string;
      status: string;
      items: { data: Array<{ id: string; quantity?: number; price?: { id: string } }> };
    }>;
    update(id: string, args: unknown): Promise<{ id: string }>;
  };
  invoices: {
    list(args: unknown): Promise<{
      data: Array<{
        id: string;
        status: string | null;
        amount_paid: number;
        hosted_invoice_url: string | null;
        created: number;
      }>;
    }>;
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      sig: string,
      secret: string
    ): { id: string; created: number; type: string; data: { object: Record<string, unknown> } };
  };
}
