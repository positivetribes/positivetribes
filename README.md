# Positive Tribes

Static nonprofit technology homepage, deployed from the `positivetribes/positivetribes` GitHub repository through Cloudflare Workers Builds.

## Build

Run `CONTACT_TO=<verified email destination> node build.mjs`. The build copies the homepage, original PulseLift screenshots, and existing image asset into `public/` and generates the existing Workers configuration. Keep the verified `CONTACT_TO` value in Cloudflare build variables; generated files are not committed.

Set the optional `GA_MEASUREMENT_ID` build variable (for example `G-XXXXXXXXXX`) to add the Google Analytics 4 tag to the main pages. It records `generate_lead` when the contact form sends and `contact_email_click` when someone clicks an email link; mark both as key events in GA4 and import them into Google Ads for Ad Grants conversion tracking. The tag is also added to the Coyote prototype at `/coyote/`, which sends `coyote_role_view`, `coyote_report_started`, `coyote_report_submitted`, `coyote_alert_sent`, `coyote_report_approved` and `coyote_save_instructions_opened` with no personal data. Without the variable the pages ship with no analytics. The production GA4 property is the "positivetribes.org" property under eric@positivetribes.org; changing the variable only takes effect on the next build.

The existing `contact-worker.mjs` serves static assets and handles `/api/contact`, including validation, origin checks, rate limiting, and email delivery. This redesign preserves that integration and requires no new dependencies or hosting configuration.

## Preview

Run `python3 -m http.server 8765 --bind 127.0.0.1` and open http://127.0.0.1:8765. This previews the static homepage; email delivery requires Cloudflare bindings. The contact dialog and browser validation can be checked locally. Do not use the static server to test real email delivery.

Project examples describe potential partnerships, not completed client work. Organization and developer contact details remain available at `#developer`.

## Donations

`donate.html` is a Stripe Checkout donation page (one-time and monthly gifts). `donations.mjs` handles `/api/donate`, which opens a Checkout session, and `/api/stripe-webhook`, which records each paid gift in Salesforce Nonprofit Cloud as a Gift Transaction on the donor's Person Account (matched by email, created if new). The Stripe payment or invoice id is stored in `ProcessorReference`, so webhook retries never create duplicates. Each newly recorded gift is also emailed to `CONTACT_TO` with a link to the Gift Transaction.

With `GA_MEASUREMENT_ID` set, the thank-you page sends a GA4 `donation_complete` event with the gift amount as `value` (USD), `frequency`, and the Checkout session id as `transaction_id` so Google Ads counts each gift once. Mark it as a key event and import it into Google Ads to use gift value as the conversion value. `begin_checkout` fires when a donor opens checkout.

The `DONATIONS` build variable controls it:

- `off` (default): the page is not published, `/donate` redirects home and `/api/donate` is closed.
- `preview`: the page is published at `/donate.html` but not linked from the menu and hidden from search engines. Use it with a Stripe test key to try the full flow.
- `on`: also adds Donate to the menu and the donations paragraph (`<!--donations-->` block) to the privacy page.

The page and API also stay closed unless these Worker secrets are set in Cloudflare (Settings > Variables and Secrets, type Secret):

- `STRIPE_SECRET_KEY`: Stripe secret key (`sk_test_…` for testing, `sk_live_…` for real gifts).
- `STRIPE_WEBHOOK_SECRET`: signing secret of a Stripe webhook endpoint pointing at `https://positivetribes.org/api/stripe-webhook`, sending `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `invoice.paid`.
- `SF_DOMAIN`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`: Salesforce My Domain URL and an External Client App with the OAuth client credentials flow enabled (run-as user needs the Fundraising Access permission set, not just the license). Until these are set, each gift is emailed to `CONTACT_TO` instead of being written to Salesforce. If a Salesforce write fails, the gift is also emailed and Stripe retries the webhook.
