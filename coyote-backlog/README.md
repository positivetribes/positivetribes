# Project Coyote prototype backlog

A small shared list where Mark, Rainer, and the Positive Tribes team collect feedback on the Project Coyote mange app prototype. Anyone with the passcode can add a suggestion, mark it **Must have**, **Nice to have**, or **Idea for now**, and move items up or down to set the order inside a tier. Items can be edited, marked done, or deleted.

Each item also has a **phase**, which says when it gets built, separate from how much it matters: **To review** (new, not sorted yet), **Prototype** (next prototype round), **Full build** (the real app after approval), or **Later**. New suggestions start as To review. The page can be filtered by phase, and Up and Down reorder within the phase being shown.

This is a separate Cloudflare Worker with its own D1 database, like Family Meals. The main Positive Tribes website and its contact form are not touched.

## Deploy

1. In Cloudflare, create a Worker from this repository with root directory `/coyote-backlog`, build command `npm ci`, and deploy command `npm run deploy`.
2. Let Cloudflare create and bind the D1 database named in the `DB` binding, or bind an empty D1 database yourself.
3. Add a Worker secret named `BACKLOG_PASSCODE` with the passcode to share. Do not put it in GitHub.
4. Share the Worker URL and the passcode with Mark and Rainer. The page is marked noindex so search engines skip it.

Tables are created on the first authenticated request. The first request also adds six starting items from Rainer's feedback, once. Deleted starter items do not come back. Databases created before phases existed get the phase column added automatically, and the six starting items are sorted into phases one time; later edits are never overwritten.

## How it works

- `/api/*` needs the `x-backlog-passcode` header. Requests with a wrong or missing passcode are rejected before the database is touched.
- Changing an item's tier puts it at the bottom of the new tier. Up and down swap an item with its neighbor in the same tier.
- Done items move to a collapsed list under their tier and leave the ordering.
- Names are typed in by each person and are not verified. The passcode is the only access control, so share it only with people who should be able to edit.

## Local development

Use Node.js 22.13+.

```sh
npm ci
npm test
npm run build
npm run dev -- --local --var BACKLOG_PASSCODE:local-test-only
```

The local command uses a disposable local database and a test-only passcode. Do not add `--remote` for testing. The tests run the Worker's real SQL against SQLite and cover the passcode check, seeding, input validation, ordering, tier changes, done items, and edits.

## Visitor tracking

`npm run deploy` first runs `build.mjs`, which adds the Google Analytics 4 tag to the page when the `GA_MEASUREMENT_ID` build variable is set (use the same `G-` ID as the main Positive Tribes site). Add it in Cloudflare under this Worker's **Settings**, then **Build**, then **Variables and secrets**. Without it the page ships with no analytics, and the tag is never committed to GitHub. The page records `backlog_signed_in` and `backlog_item_added` (with the tier only). It never sends the passcode, names, or anything typed into a suggestion. Because both sites are on `positivetribes.org`, a person who visits both counts as one user; use the **Hostname** dimension in GA4 to tell the two apart.
