-- Trove Plan 4: anonymous public-profile read path.
-- Applied via the Management API: node scripts/apply-migration.mjs supabase/migrations/0005_public_profile_rls.sql
--
-- Two ADDITIVE `for select` policies. Postgres OR's permissive policies together, so these
-- ONLY add anon/public visibility for earners who opted in (public_profile_enabled = true);
-- they never narrow the owner's own access (earners_self_select / credentials_owner_all from
-- 0003 remain in force). No `to` role clause => applies to `public` (all roles), which is what
-- we want: an anonymous visitor AND a logged-in non-owner viewing a friend's page both work.
-- No insert/update/delete policy is added, so anon writes stay RLS-denied by default.

-- Public read: an opted-in earner exposes their row (handle/display_name/id/created_at/flag)
-- to anyone. None of those columns is sensitive; a row-level policy is sufficient (no view needed).
create policy earners_public_select on earners
  for select using (public_profile_enabled = true);

-- Public read: credentials belonging to an opted-in earner. The EXISTS subquery re-checks the
-- parent earner's flag live on every row read, so flipping public_profile_enabled off takes
-- effect immediately with no staleness window.
-- KNOWN TRADEOFF (not a settled fact): this grants anon `select` on the WHOLE credential row,
-- including raw_json. The public PAGE query deliberately selects only card fields; the verify
-- action reads raw_json on-demand for one credential. But an anon client CAN still request
-- raw_json directly. raw_json is the full imported OB2/VC assertion, which per the Open Badges
-- spec MAY carry a `recipient` identity/email, `evidence` URLs, or issuer-internal metadata not
-- shown on the card. Exposing it is ACCEPTED here because it is the same document the badge
-- itself already publishes and is required by the on-demand verify affordance (spec §5) — it is
-- NOT claimed to be non-sensitive. FOLLOW-UP before broad production rollout: audit real OB2
-- `recipient`-field shapes in the pilot issuer set; if PII is present, add a redacted projection
-- or move verify behind a `security definer` RPC so raw_json need not be anon-readable.
create policy credentials_public_select on credentials
  for select using (
    exists (
      select 1 from earners e
      where e.id = credentials.earner_id
        and e.public_profile_enabled = true
    )
  );
