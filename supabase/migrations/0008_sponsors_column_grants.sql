-- Column-scope the authenticated UPDATE grant on sponsors.
--
-- VECTOR: sponsors_admin_update (0007) is a whole-ROW RLS policy — it scopes WHICH sponsor row an
--   admin may update (their own), but RLS cannot restrict WHICH COLUMNS are writable. Supabase's
--   stock `authenticated` role also holds Postgres's table-wide UPDATE privilege on sponsors. Put
--   together, a sponsor admin's normal RLS-scoped client could run:
--     update sponsors set subscription_status='active', plan='pro', seats=999,
--       stripe_subscription_id='sub_fake' where id = <their sponsor>
--   self-granting a paid subscription with no Stripe involved at all.
--
-- MECHANISM: same reasoning 0007 already applies to cohort_members (see its final block) — RLS
--   policies cannot restrict columns, but Postgres column-level privileges can. We revoke the
--   blanket UPDATE and grant it back for exactly the one column a client is allowed to write.
revoke update on sponsors from authenticated;
grant update (stripe_customer_id) on sponsors to authenticated;

-- The sponsors_admin_update RLS policy (0007) still scopes WHICH ROWS an admin may update (their
-- own sponsor). This grant narrows WHICH COLUMNS (stripe_customer_id only — written by
-- ensureStripeCustomer, Task 10). The Stripe webhook (Task 12) writes the entitlement columns
-- (plan, seats, subscription_status, stripe_subscription_id) via the SERVICE-ROLE key, which
-- bypasses both RLS and column privileges, so it is unaffected by this grant.
--
-- Deliberately NO CHECK constraint on subscription_status: the webhook persists live Stripe
-- statuses verbatim, and a constraint enumerating "known" values would make it brittle against
-- new/unknown Stripe statuses. The client-tamper vector this migration closes is column-level
-- write access, not the value domain — with the grant above, no client role can write
-- subscription_status at all.
