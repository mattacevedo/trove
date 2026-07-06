-- CAUSE F (sub-path ii-b): re-inviting a REMOVED cohort member.
--
-- cohort_invites is keyed by EMAIL (invitees have no earner row until they sign up), but resolving
-- "which earner does this accepted invite's email belong to" requires joining through auth.users,
-- which is only readable inside a SECURITY DEFINER function (see accept_cohort_invite, 0007) — no
-- RLS-scoped client, not even the sponsor admin's own, has a join path from an invite's email to a
-- cohort_members row. Without this RPC, lib/cohort/invite.ts could not tell "accepted, member still
-- active" apart from "accepted, member was removed and should be re-invited", so BOTH cases were
-- skipped identically, permanently blocking a legitimate re-invite of someone who left and should be
-- able to rejoin.
--
-- reinvite_cohort_member: sponsor-admin-gated, atomic check-then-rotate in one SECURITY DEFINER call
-- (no window between "check status" and "rotate token" for a concurrent accept/removal to race
-- against). Resolves the invited email to an earner via auth.users, and — ONLY if that earner's
-- cohort_members row for this sponsor is 'removed' — rotates the invite's token to the caller-supplied
-- `new_token` (token generation stays in application code, alongside generateInviteToken()) and clears
-- accepted_at, returning the new token so the caller knows the write happened and can send a fresh
-- invite email. Returns zero rows (no side effect) when: no auth.users account exists for that email
-- yet, or a cohort_members row exists but is NOT 'removed' (still active — nothing to reopen).
-- accept_cohort_invite's existing on-conflict upsert (`do update set status = 'active'`) already
-- reactivates the cohort_members row itself once the invitee accepts again — this RPC only needs to
-- reopen the INVITE side.
create or replace function reinvite_cohort_member(target_sponsor uuid, invite_email citext, new_token text)
returns table (token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_earner_id uuid;
begin
  if not is_sponsor_admin(target_sponsor) then
    raise exception 'not a sponsor admin';
  end if;

  select u.id into v_earner_id from auth.users u where u.email = invite_email;
  if v_earner_id is null then
    return; -- no account for this email yet -> nothing to reactivate
  end if;

  if not exists (
    select 1 from cohort_members cm
    where cm.sponsor_id = target_sponsor
      and cm.earner_id = v_earner_id
      and cm.status = 'removed'
  ) then
    return; -- member still active, or no membership row at all -> nothing to reopen
  end if;

  update cohort_invites
  set token = new_token, accepted_at = null
  where sponsor_id = target_sponsor
    and email = invite_email;

  return query select new_token;
end;
$$;

-- Matches 0009's convention: called by an authenticated sponsor admin only, so grant explicitly to
-- `authenticated` for defense-in-depth/clarity. Not granted to `anon` — is_sponsor_admin() requires
-- auth.uid() to resolve to a real admin, so an anonymous caller would always fail the gate anyway.
grant execute on function reinvite_cohort_member(uuid, citext, text) to authenticated;
