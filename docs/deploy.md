# Trove — Deployment & Operations

## Current production

- **URL:** https://trove-sand-nu.vercel.app (aliases: `trove-mattacevedos-projects.vercel.app`)
- **Vercel project:** `trove` (scope `mattacevedos-projects`), connected to the GitHub repo
  `mattacevedo/trove` — **every push to `main` auto-deploys to production.**
- **Database:** hosted Supabase project `kuhhupacabevjrfeigaj` (same project used by the
  live-DB test suite — see "Known caveats").
- Deployed 2026-07-06.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (prod+preview), `.env.local` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (prod+preview), `.env.local` | RLS-scoped client key |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (prod+preview), `.env.local` | Webhook + privileged writes (server-only) |
| `ANTHROPIC_API_KEY` | Vercel (prod+preview), `.env.local` | AI advisor + LLM skill extraction |
| `NEXT_PUBLIC_SITE_URL` | Vercel (prod+preview), `.env.local` | OTP email redirect base (`/auth/confirm`) |
| `STRIPE_SECRET_KEY` | **not set yet** | Billing (see below) |
| `STRIPE_WEBHOOK_SECRET` | **not set yet** | Webhook signature verification |
| `STRIPE_PRICE_ID` | **not set yet** | Per-seat subscription price |
| `POSTMARK_SERVER_TOKEN` | **not set yet** | Cohort invite emails |

Local secrets live only in git-ignored `.env.local` (includes `VERCEL_TOKEN` and
`SUPABASE_ACCESS_TOKEN` for CLI/Management-API work).

## Domain pivot checklist (trove.io was unavailable — final domain TBD)

The app derives request origins at runtime (invite links, checkout return URLs come from
request headers), so **no code changes** are needed to change domains. Three config steps:

1. **Vercel:** add the new domain to the `trove` project
   (`vercel domains add <domain> --scope mattacevedos-projects` or dashboard) and set the
   DNS records Vercel prescribes (A `76.76.21.21` / CNAME `cname.vercel-dns.com`).
2. **Vercel env:** update `NEXT_PUBLIC_SITE_URL` to `https://<domain>` (prod + preview),
   then redeploy (the var is inlined at build time).
3. **Supabase Auth** (Management API or dashboard → Auth → URL configuration): set
   `site_url` to `https://<domain>` and add `https://<domain>/auth/confirm` to
   `uri_allow_list` (keep the vercel.app entries during transition).

## Stripe go-live checklist (billing is inert until this is done)

1. Create a Product + per-seat recurring Price in Stripe; note the `price_...` id.
2. Set `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID` in Vercel (prod), redeploy.
3. Register the webhook endpoint `https://<domain>/api/stripe/webhook` for events:
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   Set the signing secret as `STRIPE_WEBHOOK_SECRET` in Vercel, redeploy.
4. **Customer Portal configuration: disable subscription quantity editing.** Seat quantity
   is owned by the active-member reconciler; Portal edits would fight it.
5. Until steps 1–3 are done, `/api/stripe/webhook` responds 500 (fail-closed — the Stripe
   client can't construct without its key) and checkout shows `price_not_configured`.

## Postmark go-live checklist (invite emails AND auth emails)

1. Verify a sender domain/signature in Postmark.
2. Set `POSTMARK_SERVER_TOKEN` in Vercel (prod), redeploy — enables cohort invite emails.
3. The invite sender uses `https://api.postmarkapp.com/email` directly (no SDK).
3a. **Free-tier restriction discovered 2026-07-06:** without custom SMTP, Supabase
   rejects BOTH email-template customization AND rate-limit changes ("Email template
   modification is not available for free tier projects using the default email
   provider"). The default templates send PKCE `?code` links; `/auth/confirm` handles
   both that flow and the `token_hash` flow, so sign-in emails WORK today — but the
   `?code` link must be opened in the same browser that requested it, and the 2/hr cap
   applies, until SMTP is configured.
4. **Also configure Supabase Auth SMTP with the same Postmark account** (dashboard →
   Auth → SMTP, or Management API `PATCH /config/auth` with `smtp_host
   smtp.postmarkapp.com`, port 587, user AND pass = the Postmark server token, plus a
   verified `smtp_admin_email` sender). Then raise `rate_limit_email_sent` (e.g. 100/hr).
   **Until this is done, sign-in emails use Supabase's built-in DEV mailer, capped at
   2 emails/hour project-wide** — fine for solo testing, unusable for a pilot. The login
   page surfaces this as a "too many sign-in emails" message (HTTP 429).

## Known caveats

- **Tests share the production database.** The live-DB suite (`tests/db/`) creates and
  deletes auth users/sponsors against the same hosted project that production now uses.
  Fine during pre-pilot; before onboarding a real sponsor, split into separate Supabase
  projects (dev/test vs production) — migrations replay via
  `node scripts/apply-migration.mjs` (0001–0010, in order) plus `scripts/seed-onet.mjs`.
- **Supabase auth rate limits:** repeated full runs of `tests/db/` can hit
  `AuthApiError: Request rate limit reached` on `signInWithPassword`. Wait a few minutes
  or run files individually.
- Deferred hardening items are tracked in the bodies of PRs #3–#6.
