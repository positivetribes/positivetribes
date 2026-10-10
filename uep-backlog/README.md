# Up ENDing Parkinson's scheduler backlog

A small shared list where Molly at Up ENDing Parkinson's and the Positive Tribes team track open questions and suggested changes for the climber scheduling prototype at [positivetribes.org/uep](https://positivetribes.org/uep/). It is a copy of the Project Coyote backlog with one addition: items are either an **open question** or a **suggested change**.

- **Open questions** have a "who can answer" field and an answer. Their tiers read **Answer first** (the prototype or plan depends on it), **Answer before the full build**, and **Can wait**. Marking one answered moves it to a collapsed list and keeps the answer.
- **Suggested changes** work exactly like the Coyote backlog: **Must have**, **Nice to have**, **Idea for now**.

Each item also has a **phase**, separate from how much it matters: **To review** (new, not sorted yet), **Prototype**, **Full build**, or **Later**. Up and Down reorder within a tier, and questions and changes keep separate orders.

This is a separate Cloudflare Worker with its own D1 database, like the Coyote backlog. The main Positive Tribes website is not touched.

## Deploy

1. In Cloudflare, create a Worker from this repository with root directory `/uep-backlog`, build command `npm ci`, and deploy command `npm run deploy`.
2. The D1 databases already exist and are named in `wrangler.jsonc`: `uep-backlog-db` for the live list and `uep-backlog-preview-db` for pull request previews.
3. Add a Worker secret named `BACKLOG_PASSCODE` with the passcode to share. Do not put it in GitHub.
4. Share the Worker URL and the passcode with Molly. The page is marked noindex so search engines skip it.

Tables are created on the first authenticated request. The first request also adds the 24 open questions from the Oct 9 call and the Gymdesk walkthrough, once. Deleted starter items do not come back.

## How it works

- `/api/*` needs the `x-backlog-passcode` header. Requests with a wrong or missing passcode are rejected before the database is touched.
- Changing an item's tier puts it at the bottom of the new tier. Up and down swap an item with its neighbor of the same kind in the same tier.
- Answered and done items move to a collapsed list under their tier and leave the ordering.
- Names are typed in by each person and are not verified. The passcode is the only access control, so share it only with people who should be able to edit.

## Local development

Use Node.js 22.13+.

```sh
npm ci
npm test
npm run build
npm run dev -- --local --var BACKLOG_PASSCODE:local-test-only
```

The local command uses a disposable local database and a test-only passcode. Do not add `--remote` for testing. The tests run the Worker's real SQL against SQLite and cover the passcode check, seeding, input validation, ordering per kind, tier changes, answers, and edits.

## Visitor tracking

`npm run deploy` first runs `build.mjs`, which adds the Google Analytics 4 tag to the page when the `GA_MEASUREMENT_ID` build variable is set (use the same `G-` ID as the main Positive Tribes site). Without it the page ships with no analytics, and the tag is never committed to GitHub. The page records `backlog_signed_in` and `backlog_item_added` (with the tier and kind only). It never sends the passcode, names, or anything typed into an item.
