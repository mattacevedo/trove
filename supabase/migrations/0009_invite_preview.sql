-- Narrow, unauthenticated-safe preview for an invite link.
--
-- VECTOR: app/invite/[token]/page.tsx must show a real invitee (unauthenticated, or authenticated
-- but not a sponsor admin) the sponsor's name and whether the invite is still open, BEFORE they sign
-- in/up. But the only RLS policy on cohort_invites is cohort_invites_sponsor_all (0007), which is
-- admin-scoped (is_sponsor_admin(sponsor_id)) — a real invitee's SELECT against cohort_invites
-- returns zero rows every time, so the page's "Invitation unavailable" branch was permanently shown
-- in production. Adding a broader RLS policy would leak invite rows (email, token, timestamps)
-- to anyone who can query the table; instead this is a narrow SECURITY DEFINER RPC that returns only
-- the two fields the pre-login preview needs, keyed by the (unguessable, 32-byte) token itself.
--
-- Do NOT add a SELECT policy on cohort_invites — this RPC is the only door.
create or replace function invite_preview(invite_token text)
returns table (sponsor_name text, is_open boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select s.name, (ci.accepted_at is null)
  from cohort_invites ci
  join sponsors s on s.id = ci.sponsor_id
  where ci.token = invite_token;
end;
$$;

-- Matches the established pattern for every other RPC in 0007 (create_sponsor,
-- accept_cohort_invite, sponsor_engagement, sponsor_skill_coverage): none of them carry an explicit
-- `grant execute`, relying on Postgres's default (EXECUTE granted to PUBLIC unless revoked). This
-- grant is added anyway for defense-in-depth and to make the intended callers (anonymous pre-login
-- visitors AND signed-in-but-not-admin users) explicit at the call site, since this is the first RPC
-- in the schema meant to be called by a fully anonymous caller.
grant execute on function invite_preview(text) to anon, authenticated;
