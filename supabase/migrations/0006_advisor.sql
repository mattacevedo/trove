-- Plan 5 (AI advisor) schema.
-- 1) occupation_skills: the O*NET occupation -> required-skill relation that closes the
--    CRITICAL DATA GAP (Plan 2 seeded occupations + skills as vocabulary ROWS but not the
--    per-occupation requirement relation the gap math needs). Public vocabulary-derived data,
--    world-readable like `skills` — never earner data. Seeded by scripts/seed-onet.mjs.
-- 2) earners.target_occupation_skill_id: a durable per-earner "target role" the gap math keys off.
--    Covered by the existing earners_self_update policy (0003) — no new policy needed.
-- NOTE: advisor_threads / advisor_messages already exist (0002) and are already owner-scoped by
--    advisor_threads_owner_all / advisor_messages_owner_all (0003). No RLS change needed there.

create table occupation_skills (
  occupation_id uuid not null references skills (id) on delete cascade,
  skill_id uuid not null references skills (id) on delete cascade,
  importance real not null,
  primary key (occupation_id, skill_id)
);
create index occupation_skills_occupation_idx on occupation_skills (occupation_id);

alter table occupation_skills enable row level security;
create policy occupation_skills_read_all on occupation_skills for select using (true);

alter table earners
  add column target_occupation_skill_id uuid references skills (id) on delete set null;
create index earners_target_occupation_idx on earners (target_occupation_skill_id);
