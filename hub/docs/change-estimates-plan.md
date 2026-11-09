# Change estimates: plan

Status: approved by Eric 2026-11-09, building on branch `change-estimates`.

Decisions: (1) a director's approval in the hub counts as a written change order, and the proposal terms kit gets that line; (2) everyone on the client's hub sees prices; (3) hide "after launch" above 2 hours; (4) add UEP's care plan row (Care tier, 6 credits, status setup); (5) half-hour minimum.

## Why

During a build, out-of-scope asks (Julie Calligaro's #133–#136 for UEP are the first) get settled by email today. The price and the decision never land in the hub or Salesforce, and the client can't see what each extra will cost next to the ask itself. With this feature, a director can see the cost and the schedule effect on the card and decide in one tap. Positive Tribes gets a dated, signed-in record of the decision and a Salesforce Task to bill it. It works for every client, so it's a reusable piece.

## What each person does

**Eric (Positive Tribes)**, on a suggested change, in any project phase:
1. Opens "Estimate" on the card and enters **hours** (in half hours), an optional schedule note ("adds about a week to Phase 2"), and an optional one-line reason it's out of scope.
2. Sees the price the client will see: hours × the client's rate (default $50/h). If the client has a care plan, it also shows the credits (1 credit = 30 minutes, so hours × 2).
3. Saves it as a draft (only Positive Tribes sees it), then taps "Send to client".

**The client.** Everyone on the client's hub sees the estimate on the card: "About 3 hours · $150 · adds about a week to Phase 2". Only the **director** (role `ed`) or the care plan's named contact gets the buttons:
- **Add it now**: "Adds $150 to your next invoice." The item becomes Planned, Full build.
- **After launch, 6 credits**: shown only if the client has a care plan and the estimate is 2 hours or less (4 credits, the largest care-plan size). The item becomes Planned, Later. Above 2 hours the card says "Larger than one care-plan request, so better added now" instead.
- **Not now**: the item stays open on the Wishlist (status Planned, which reads "On the wishlist"; a Must have moves to Idea).

Positive Tribes can never decide for the client (same rule as `canConfirm` in `src/care.js`).

## Rules

- **Hours are the only input.** Price and credits are worked out from them, so they can't drift apart.
- **Snapshots.** Each estimate keeps the rate and price at the moment it's sent. A later change to the client's rate doesn't touch an estimate that's already sent or approved.
- **Re-estimating** a sent estimate bumps its version. An approval names the version it approves, and the server rejects a stale one (409). That way nobody approves a number they didn't see.
- Only `change` items get estimates. Problems are fixes, and care requests already have their own sizing.
- Patch never writes or suggests a price. `reply.js` already throws away drafts with prices, and the estimate is never sent to Patch.

## Data (migration 0026, additive)

```sql
ALTER TABLE clients ADD COLUMN hourly_rate_cents INTEGER NOT NULL DEFAULT 5000 CHECK(hourly_rate_cents BETWEEN 0 AND 100000);

CREATE TABLE change_estimates (
  item_id INTEGER PRIMARY KEY,                 -- one estimate per item; history is in events
  client_id INTEGER NOT NULL REFERENCES clients(id),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 30 AND 12000 AND minutes % 30 = 0),
  rate_cents INTEGER NOT NULL,                 -- snapshot when sent
  price_cents INTEGER NOT NULL,                -- minutes / 60 * rate, snapshot
  credits INTEGER,                             -- minutes / 30, NULL when the client has no care plan
  schedule_note TEXT NOT NULL DEFAULT '',      -- max 200
  scope_note TEXT NOT NULL DEFAULT '',         -- max 200, why it's outside the agreement
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','offered','approved_now','approved_later','not_now','withdrawn')),
  version INTEGER NOT NULL DEFAULT 1,
  offered_at TEXT, decided_at TEXT,
  decided_by_user_id INTEGER REFERENCES users(id),
  decided_version INTEGER,
  sf_task_id TEXT NOT NULL DEFAULT '', sf_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES items(id)
);
```

## API

Positive Tribes only (role `pt`, else 403):
- `PUT /api/admin/items/:id/estimate` `{ hours, schedule_note, scope_note }`: creates or edits the draft. Editing a sent estimate puts it back to draft and bumps the version.
- `POST /api/admin/items/:id/estimate/offer`: draft → offered. Logs an `estimate_offered` event, which rings the client's bell: "Estimate: about 3 hours, $150".
- `POST /api/admin/items/:id/estimate/withdraw`: → withdrawn.
- `PUT /api/admin/clients/:id/rate` `{ rate }`.

Client (the existing Origin check applies to all client writes):
- `POST /api/c/:slug/items/:id/estimate/decide` `{ choice: 'now'|'later'|'not_now', version }`. Allowed for role `ed`, or the care plan's `balance_contact_user_id`, never `pt`. A conditional `UPDATE … WHERE status = 'offered' AND version = ?` does the work, and if no row changes the answer is 409. The item update (status, phase, tier for Not now) and an `estimate_decided` event go in the same batch. That event lands in Positive Tribes' Inbox.

## After a decision

1. **Salesforce.** After the D1 batch, the Worker creates a Task on the project's Opportunity (`projects.salesforce_opportunity_id`): "Change approved by Molly Cupka: <title> (3 h, $150, add now)". It's due in 7 days, as a reminder to bill and schedule it. This uses the Task-write access the hub already has; no new Salesforce permissions. On failure, it stores `sf_error`, and the command center's Today shows "Salesforce Task failed: retry". Nothing fails silently.
2. **Command center Today** gets two short lists: "Estimates waiting for the client" (with days waiting) and "Approved changes to bill or schedule".
3. **Requirements.** For UEP, the checklist in `UEP/CLAUDE.md` turns an approved estimate into an R row (P-rows lose their P number). The hub doesn't touch other repos.
4. **Approved for after launch.** These wait as Planned, Later. When the tool goes live with an active plan, Eric turns each into a care request at its credit size. That step stays manual in version 1, and Today lists them so none get missed.

## Tests (in `test/`)

- Price and credits math, including half hours, the 2-hour cut-off for the credits option, and rate snapshots.
- Who can decide: `ed` yes, named contact yes, `staff` no, `pt` no, another client's user no.
- A stale version is rejected, and a second decision is rejected.
- Not now on a Must have moves it to Idea and leaves it open.
- Events: one per offer and one per decision, with the words the bell shows.
- A Salesforce failure records `sf_error` and doesn't undo the decision.
- Estimates are never included in what Patch is sent.

## Build and rollout

- Migration on a local D1 first (`npm test`, then `wrangler d1 migrations apply --local`). Never test against `hub-db`.
- Code goes in a new `src/estimates.js` (math and rules, no client specifics), routes in `src/index.js` and `src/admin.js`, and the card UI in `public/index.html`. Then update `hub/CLAUDE.md`.
- Deploy, set UEP's rate (the $50 default), then estimate #133 and #134 so Molly can decide on the Nov 18 call.
- Effort: about 5 to 6 hours, most of it the card UI and tests.
- Afterwards: a Build inventory row in the Productization doc, and a pricing experiments row for the first approved estimate.
