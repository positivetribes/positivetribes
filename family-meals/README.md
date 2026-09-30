# Family Meals

Mobile-first family dinner planner for Cloudflare Workers + D1. The main Positive Tribes site is separate; all application files live in this directory.

## V2

- **History / last made:** Meal cards show the most recent past planned dinner and an expandable list of past dates. Today's and future plans are excluded using the device's local calendar date. This is inferred from the plan, not a confirmation that the meal was cooked. Use the previous-week arrow to correct an old plan.
- **Tags:** Add or edit comma-separated tags on a meal, then filter Meal Ideas by tag or search its name, notes, and tags. Tags are normalized to lowercase.
- **Plan My Week:** Preview suggestions for empty nights from today onward. Existing dinners, notes (including “eating out”), and past nights are preserved. Change a meal manually or use Swap, then Accept week to save all seven days atomically. Cancel leaves the saved plan untouched. Swap also works on a saved dinner and changes only that day after Save dinner.
- **Groceries:** Add one ingredient per line on each meal, including the amount for one family dinner. The selected week's saved dinners generate the list automatically. Identical lines are grouped; “× 2 meals” means that amount is needed twice, not that units have been converted. Different amounts/units remain separate. Meals without ingredients are flagged with an edit shortcut. Add manual items, check items off, or remove manual items. **Stores:** tap “+ Store” on any item (generated or manual), or type a store when adding a manual item, to record where to buy it (for example Costco, Target, Whole Foods). Once any item has a store, a filter appears above the list to show one store's items or items with no store yet. Store names are case-insensitive: the first spelling used wins. Like checkmarks, store assignments are stored per week and shared across devices. Lists and checks are stored in D1 per week and shared across devices. Refresh retrieves changes made on another device.
- **Who's home:** Each night can show who can make dinner. Tap a night, then tap a person's circle in *Who's home?* to mark them out; everyone starts as home, so the week list only says "All home" or names who is out, and a slim summary counts the nights everyone is home. Marks are saved to D1 right away and shared across devices. Anyone can mark anyone (handy for kids without a phone), and your own circle is shown first with a ring. The family list starts from names already on ratings and votes, and each person who saves a profile name is added automatically. Use *+ Add* to add someone without a phone, and *Edit family* to remove a person (their in/out marks are cleared; ratings and votes stay). The list needs at least two people to appear. Renaming yourself in Profile adds the new name; remove the old one with *Edit family*.
- Existing Edit/Delete, family voting, ratings/comments, favorites, recipe links, and family PIN remain available. Deleting a meal retains the original behavior: it removes ratings/votes and clears its meal reference from all plans, including past plans. Notes and manual groceries remain.

## Suggestion rules

The planner runs locally with no AI service, API key, or paid dependency. The same meals, ratings, votes, dates, and plan produce the same result.

1. Keep planned nights and avoid using a meal twice within the selected week.
2. Prefer meals at least 14 days from other planned occurrences outside that week (past or future). If none qualify, try 7 days, then relax the limit and explain the recent repeat.
3. Rank by family ratings (smoothed toward 3 until more ratings exist), votes, distance from other plans, and tag variety. Repeated tags and adjacent-day tag matches reduce the score. Meal ID breaks ties deterministically.
4. If there are no unused alternatives, leave the night empty with an explanation; a family member can still choose manually.

A plan revision prevents an accepted preview from overwriting another family member's intervening plan edits. On a conflict, cancel the preview and generate it again from the refreshed plan.

## Data and deployment

The existing Cloudflare Git integration should deploy `main` with root `/family-meals` and `npm run deploy`. Keep the existing `DB` binding and `FAMILY_PIN` Worker secret. Do not put the PIN in GitHub or change the binding to a new database.

Schema initialization runs only after successful PIN authentication. V2 adds `meal_details`, `grocery_items`, `grocery_checks`, `grocery_stores`, `family_members`, `dinner_absences`, `plan_revision`, and a grocery index using `CREATE ... IF NOT EXISTS` and `INSERT OR IGNORE`. It does not drop/recreate existing tables, rewrite family meals, or reseed a populated database. No separate production migration command is needed; the first authenticated request initializes the new tables. Existing tags and ingredient lists start empty.

All `/api/*` requests require the unchanged `x-family-pin` authentication. Inputs are validated and SQL values are bound. Recipe links are limited to HTTP(S). API failures never return SQL errors or secrets.

Grocery generation follows the current saved plan without deleting manual items. Checkmarks are keyed by week and normalized ingredient text; unchanged items keep their checks as the plan changes, and removed generated items disappear. Checkmarks are not automatically reset when the number of planned servings increases, so review amounts after changing a checked list.

Rollback: reverting the app commit leaves additive V2 tables in D1; V1 ignores them. Do not delete those tables during a rollback.

## Local development and verification

Use Node.js 22.13+ (Node 24 recommended):

```sh
npm ci
npm test
npm run build
npm run dev -- --local --var FAMILY_PIN:local-test-only
```

The build command bundles the Worker and static assets without deploying. The local command uses a disposable local database and an explicitly test-only PIN; it does not modify the Cloudflare secret or remote D1 data. Never add `--remote` for these tests.

Automated tests execute actual Worker SQL with SQLite and cover old-data preservation, idempotent initialization, Edit/Delete, tags/ingredients, PIN enforcement, transactional week saves, stale previews, grocery generation/checks/week isolation, deterministic ranking, recency, variety, and date boundaries.

Browser smoke checklist against the local app:

1. Add/edit a meal with tags and ingredients; filter it; rate and vote.
2. Put it on yesterday's plan and confirm “Last made: yesterday.” Verify a future plan does not count as history.
3. Preview next week, swap a day, cancel or accept. Swap a saved day and verify other days remain unchanged.
4. Open groceries, add and check a manual item, refresh, and verify its state persists. Swap a meal and verify generated ingredients change while the manual item remains.
5. Check phone widths (320px and 390px), long names, empty states, and missing-ingredient prompts.

## Starter dinners

The first authenticated request on an empty database adds 15 starter dinner ideas once. Inserts and the permanent `app_seeds` marker run together in a D1 transaction. Existing nonempty databases are marked initialized without adding starters. Later edits/deletions never trigger reseeding.
