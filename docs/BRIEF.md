# Working brief for agents on this codebase

Read this before touching anything. `docs/SPEC.md` is the authority on
behaviour; this is the authority on how to work.

## What the thing is

One pickleball venue in Chennai — Madras Pickleball — running weekend
tournaments on four courts. About 40 players, two to four categories, a
single organiser with a phone in one hand. Players score their own matches
from a QR code on the net post. Spectators, and the players themselves, read
a public page.

Everyone is outdoors, in sun, on a phone, one-handed, often with a paddle in
the other hand. That is the whole design constraint and it is not decorative.

## The stack

Next.js 16 (App Router, Turbopack, `proxy.ts` not `middleware.ts`, async
`params`/`searchParams`, `PageProps<'/route'>` and `RouteContext<>` globals),
React 19, TypeScript, Tailwind v4 (`@theme` in `src/app/globals.css`),
Drizzle ORM against Postgres.

`app/AGENTS.md` says it plainly: this is not the Next.js in your training
data. Read `node_modules/next/dist/docs/` before reaching for an API you
remember rather than one you have checked.

## Rules that are not negotiable

1. **No network at runtime.** No font CDN, no script CDN, no external image
   host. Fonts are self-hosted and subset in `public/fonts`. Anything that
   needs the network at page load is a layout shift on tournament morning.
2. **No new dependencies** without a concrete reason that cannot be met by
   twenty lines of local code. The install has to work behind a restricted
   egress policy.
3. **Public pages stay cookie-free.** `src/server/public.ts` and everything
   under `src/app/t/` must not read cookies, or the CDN silently stops
   caching them.
4. **Phone numbers are admin-only.** Public reads are built by explicit
   mappers, never spread from a row.
5. **Every server action authorises independently.** A page guard protects a
   page, not an action. A server action's argument is a wire format, not a
   typed object — copy fields out by hand and validate them.
6. **Keep it green.** `npx tsc --noEmit` and `npx vitest run` must pass when
   you finish. Do not run `npm run build` or start a dev server — the
   integrator does that between waves, and concurrent builds collide.

## The design system

It lives in `src/app/globals.css` (`@theme`) and `src/components/ui.tsx`.
Three rules carry the whole look, and breaking them is worse than any
prettiness gained:

1. **Green means one thing: LIVE, right now.** Finished is grey, confirmed
   is ink. A second green destroys both.
2. **Terracotta is the single accent, spent on structure** — the net rule, a
   qualifying position, an idle court's call to action. Never on status,
   never on text below 14px.
3. **Ink is a chrome fill, not body text.** A solid ink band reads as a
   brand; blue-tinted body copy at 15px just reads as generic dark grey.

Two more that came out of the reviews:

4. **Never colour alone.** A status is always a colour *and* a word.
5. **A card is a bounded object; a section is an editorial grouping.** Never
   nest a card in a card — when you want to, you want a `SectionHead` and a
   `Panel` of rows.

Touch targets: 44px minimum, 56px for anything used on court. The `tap`,
`tap-lg` and `tap-xl` utilities exist for this.

## Voice

Every string a person reads is written for someone standing on a court, not
for a developer. Say what happened and what to do about it. Name the person
or the court when you can: "Meera Krishnamurthy is on Court 1" is actionable;
"blocked" is not. No jargon, no exclamation marks, no cheerfulness. British
spelling.

Comments in code explain **why**, especially where the obvious approach was
wrong. Do not narrate what the next line does.

## How to hand work back

Report: the files you changed, what each change does in one line, what you
verified, and anything you found but deliberately did not do. If you touched
a file outside the set you were given, say so loudly — the integrator merges
several agents' work and a surprise edit is what breaks it.
