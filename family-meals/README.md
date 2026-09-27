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
