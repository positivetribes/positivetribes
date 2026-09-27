# Family Meals

Mobile-first family meal planner built for Cloudflare Workers + D1.

## V1
- Weekly dinner plan
- Shared meal suggestions
- “Want this” family voting
- 1–5 star ratings and comments
- 4+ star favorites
- Recipe links
- Shared family PIN

## Deploy in Cloudflare
Create a new Worker from the existing GitHub repository and set its root directory to `/family-meals`. The included `wrangler.jsonc` declares the static assets and a D1 binding named `DB`. Add a Worker secret named `FAMILY_PIN` before family use. Do not put the PIN in GitHub.

A custom domain such as `meals.positivetribes.org` can be attached after the Worker is live.

## Starter dinners
On the first authenticated API request after deployment, a new or empty database gets 15 dinner ideas with serving suggestions. Initialization runs automatically; no manual seed command is needed.

Existing meals are left unchanged. The insert and a permanent `app_seeds` marker run in one D1 transaction, preventing duplicates across requests and deployments. Existing nonempty databases are marked as initialized without adding starters. Later edits or deletions do not trigger re-seeding.

## Tests
Run `node --test test/seed.test.mjs` with Node.js 22.13+ (built-in SQLite). Tests execute the Worker SQL against SQLite and cover empty and existing databases, repeat initialization, edits/deletions, authentication, ratings, votes, and planning. No production PIN is needed.
