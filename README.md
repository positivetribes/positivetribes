# Positive Tribes

Static nonprofit technology homepage, deployed from the `positivetribes/positivetribes` GitHub repository through Cloudflare Workers Builds.

## Build

Run `CONTACT_TO=<verified email destination> node build.mjs`. The build copies the homepage, original PulseLift screenshots, and existing image asset into `public/` and generates the existing Workers configuration. Keep the verified `CONTACT_TO` value in Cloudflare build variables; generated files are not committed.

Set the optional `GA_MEASUREMENT_ID` build variable (for example `G-XXXXXXXXXX`) to add the Google Analytics 4 tag to the main pages. It records `generate_lead` when the contact form sends and `contact_email_click` when someone clicks an email link; mark both as key events in GA4 and import them into Google Ads for Ad Grants conversion tracking. The tag is also added to the Coyote prototype at `/coyote/`, which sends `coyote_role_view`, `coyote_report_started`, `coyote_report_submitted`, `coyote_alert_sent`, `coyote_report_approved` and `coyote_save_instructions_opened` with no personal data. Without the variable the pages ship with no analytics. The production GA4 property is the "positivetribes.org" property under eric@positivetribes.org; changing the variable only takes effect on the next build.

The Up ENDing Parkinson's scheduling prototype is at `/uep/` (`uep/index.html`, version 2, one self-contained page with sample data, hidden from search engines). Version 1 stays at `/uep/v1/` with a notice pointing to the current one, and the old `/uep/v2-940dc3/` address redirects to `/uep/`. It gets the same GA4 tag as Coyote but sends no custom events. Its shared backlog of open questions and suggestions is the separate Worker in `uep-backlog/`.

A copy of the same prototype adapted for United Rocks (climbing teams for people with intellectual and developmental disabilities) is at `/unitedrocks/` (`unitedrocks/index.html`, fictional sample data, hidden from search engines). Its shared backlog is the separate Worker in `unitedrocks-backlog/`, served at `unitedrocks.positivetribes.org`.

The Sober AF Entertainment (SAFE) homepage concept is at `/soberafe/` (`soberafe/index.html`). Its chapters prototype is at `/soberafe/chapters/` (`soberafe/chapters/index.html`, one self-contained page with sample data saved only in the visitor's browser, hidden from search engines). It walks through how SAFE could grow nationwide: people apply to host, complete five training modules, sign a host agreement and waiver, shadow an event and get certified by their chapter lead; certified hosts submit events that go public only after SAFE or the chapter lead approves them and the venue signs a host site waiver. A "Viewing as" switcher shows the visitor, applicant, host, chapter lead and SAFE admin views, and `#/guide` has a demo script. Training and waiver text is draft language for SAFE to replace. Its shared backlog of open questions and suggestions is the separate Worker in `soberafe-backlog/`, served at `soberafe.positivetribes.org`.

The existing `contact-worker.mjs` serves static assets and handles `/api/contact`, including validation, origin checks, rate limiting, and email delivery. This redesign preserves that integration and requires no new dependencies or hosting configuration.

## Preview

Run `python3 -m http.server 8765 --bind 127.0.0.1` and open http://127.0.0.1:8765. This previews the static homepage; email delivery requires Cloudflare bindings. The contact dialog and browser validation can be checked locally. Do not use the static server to test real email delivery.

The homepage "What we're building" section describes current work in progress with nonprofit partners (names left out until a partner agrees to share); the "Ideas we'd like to explore" list on the Our projects page is potential partnerships, not completed client work. PulseLift and Volunteer Connect live under "From our lab" on that page. The "Free apps" section lists Climb Partners (https://climbpartners.positivetribes.org, its own Worker in `../ClimbPartners`), offered free worldwide; joining still takes an invite, so its "Request an invite" button opens the contact form at `/?reason=climbpartners` ("Joining Climb Partners"), and Eric replies with a personal invite link. List no prices on the site. Organization and developer contact details remain available at `#developer`.

## Contact form and Salesforce

When the Salesforce secrets below (`SF_DOMAIN`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`) are set, every contact form message is saved as a Lead with Lead Source `Web`, and the reason the person picked ("What's this about?") is written at the top of the Lead description. If that email already has an open (unconverted) Lead, the new message is added to it instead of creating a duplicate. Messages with the reason "Testing PulseLift" are also added to the `PulseLift Testers` campaign (status Responded); the campaign is found by name, so keep that name. Messages from the Volunteer page are sent with the reason "Volunteering" and join the `Volunteers` campaign (status Responded) the same way; the help choice (Build, Test or advise, Connect, Something else) is the first line of the message and is also saved in the campaign member's `Volunteer_Role__c` picklist, whose values must match the form's options exactly. Track each volunteer with the campaign statuses Responded, Contacted, Matched, Active and Inactive. The notification email still goes out every time, with a link to the Lead, or a note if Salesforce could not be reached so the message can be added by hand.

The "Join the testing" button on the homepage and the `/?reason=pulselift` link open the form with "Testing PulseLift" already chosen.

## Support requests (Get help)

`support.html` is the "Get help" page for tools Positive Tribes built or supports. `support.mjs` handles `/api/support`: each request becomes a Salesforce Case with Origin `Web`, Status `New`, Type from the request kind (Problem, Question or Feature Request), Priority from the impact (Low, Medium or High), the tool in the Subject (for example `[PulseLift] …`), and the name, email and organization in the Web fields. If the email matches an existing Contact, the Case is linked to that Contact and their Account. An optional PNG or JPG screenshot (up to 5 MB, checked by its file signature) is attached to the Case as a file. It uses the same Salesforce secrets as the contact form and the `SUPPORT_LIMIT` rate limit (3 a minute per visitor).

A notification email goes to `CONTACT_TO` every time with a link to the Case, marked "(urgent)" when the person chose "We can't work". If Salesforce can't be reached, the email says so and the request should be entered by hand. Cloudflare can only email the verified `CONTACT_TO` address, so the person gets their case number on screen, not by email. Link straight to a tool with `/support.html?tool=pulselift` (or `climb-partners`, `volunteer-connect`, `partner-tool`, `other`).

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

## Admin command center

`/admin/` is Eric's private view of every client: what happened, where things stand and what's next. `admin/index.html` is the page and `admin.mjs` is its API under `/api/admin/`. Both are refused unless Cloudflare Access has signed the visitor in. The Worker checks the Access token again on every request, so if Access is missing or misconfigured the admin area is closed rather than open.

- **Today** shows three lists. *Needs attention* has overdue steps and Salesforce tasks, open Cases, new Leads from the last 30 days, opportunities past their target close date, and active clients with no contact in 21 days or no next step. *Coming up* covers the next 14 days and *Recent* the last 14.
- **Clients** has a card for each business Account in Salesforce (every Account except Positive Tribes itself), with the stages of its open opportunities, the last contact and the next step. A client counts as active while it has an open opportunity.
- **A client page** shows a timeline split at "now", next steps, opportunities, people, links, and the email domains, addresses and keywords the daily sync uses to recognize that client.

Salesforce is read live and never written. Notes, next steps, links, pins and synced activity are stored in the `ADMIN_DB` D1 database (`positivetribes-admin-db`; pull request previews use `positivetribes-admin-preview-db`). Tables are created on the first request.

### Setup

1. In Cloudflare Zero Trust > Access > Applications, add a self-hosted application for `positivetribes.org/admin` and `positivetribes.org/api/admin`. Give it an Allow policy for eric@positivetribes.org, signing in with Google or a one-time PIN. Add a Service Auth policy for a service token named `command-center-sync`.
2. Set two build variables, which are not secret: `ACCESS_TEAM_DOMAIN` (for example `positivetribes.cloudflareaccess.com`) and `ACCESS_AUD` (the application's Audience tag). The build output says "admin sign-in configured" once both are set.
3. Optional: set the Worker variable `ADMIN_EMAILS` (comma-separated) to let more people in. It defaults to eric@positivetribes.org. Each person also has to be allowed by the Access policy.

It uses the same Salesforce secrets as the contact form.

### Daily activity sync

A weekday Claude routine reads Gmail, Google Calendar and Fathom, then posts what it finds to the command center. Each run follows these steps:

1. `GET /api/admin/match` returns every client with the contact emails, email domains (taken from Contacts and the Account website, plus any extras saved on the client page) and keywords used to recognize it.
2. The routine posts to `POST /api/admin/activity` with `{ note, items: [...], steps: [...] }`:
   - **items** (up to 200): `{ external_id, account_id, kind: "email" | "meeting" | "calendar", occurred_at, title, summary, url }`. Use a stable `external_id` such as `gmail:<thread id>`, `gcal:<event id>` or `fathom:<recording id>`. Sending an item again updates it, and `{ external_id, cancelled: true }` removes it, for example a cancelled meeting.
   - **steps** (up to 50): `{ external_id, account_id, title, due_date }`. These are suggested next steps, such as action items from a meeting. Each one is added only once, and one Eric has dismissed does not come back.

The routine signs in with the `command-center-sync` service token, sending the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. A service token can call only those two endpoints. The page warns when the last sync is more than 36 hours old.

### Backlog inbox

**Inbox** lists what clients changed in their shared backlogs: Up ENDing Parkinson's (`uep-backlog/`), Project Coyote (`coyote-backlog/`) and Sober AF (`soberafe-backlog/`). Each backlog logs every add, answer, done mark, priority or phase change, edit and delete with the name the person typed. The site reads those logs through the D1 bindings `UEP_BACKLOG_DB`, `COYOTE_BACKLOG_DB` and `SOBERAFE_BACKLOG_DB`, which `build.mjs` adds (previews read the backlogs' preview databases). It never writes to them. The backlogs and their client accounts are listed in `BACKLOGS` in `admin.mjs`.

- Each item that changed appears once, showing its latest change, for 60 days. Changes made under your own name are left out. The Worker variable `BACKLOG_OWN_NAMES` (comma-separated first names) sets which names count as yours and defaults to `eric`.
- **Clear** hides the row, and the clear is saved in `ADMIN_DB`. A later change to the same item brings it back. **Add next step** adds a next step to that client and clears the row.
- A backlog with no change log yet says "No change log yet". Its table is created the first time someone opens the backlog after it is redeployed. The other backlogs still load. Deploy the backlog Workers before the site.

### Local development and tests

Run `node --test test/*.test.mjs`. The tests check the Access token, run the real SQL against SQLite, and cover the Today rules. To try the page locally without Access, run `node build.mjs`, then `npx wrangler dev --local --var ADMIN_DEV:1` and open `http://localhost:8787/admin/`. The bypass works only on localhost. Never set `ADMIN_DEV` in Cloudflare. Without Salesforce secrets the page lists no clients.
