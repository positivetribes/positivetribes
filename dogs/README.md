# Dogs

Vaccine, medication and vet-visit tracker for Rosie and Roxy, for Cloudflare Workers + D1. Served at https://dogs.positivetribes.org. The main Positive Tribes site is separate; all application files live in this directory.

## Features

Per-dog summary cards, "Needs attention" (overdue or due within 60 days), "Coming up", and history lists; add, edit and delete records; optionally add the next due record when marking a shot done.

## Data and deployment

- Cloudflare Git integration: deploy `main` with root `/dogs` and `npm run deploy`.
- Create a D1 database named `dogs-db` and add its `database_id` to the `DB` binding in `wrangler.jsonc` (or bind it in the dashboard).
- Set the `DOGS_PIN` Worker secret. Every `/api/*` request must send it as `x-dogs-pin`; the page asks for it once per device. Never commit the PIN.
- The `routes` entry attaches `dogs.positivetribes.org` as a custom domain on the positivetribes.org zone.
- The first authenticated request creates the tables and, only when empty, loads the 25 records from the original spreadsheet once (guarded by an `app_seeds` marker, so deleted records never come back).

## Local development

```sh
npm ci
npm test
npm run build
npm run dev -- --local --var DOGS_PIN:local-test-only
```
