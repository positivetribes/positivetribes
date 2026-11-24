# Proposal kit: Care plan section and terms

Reusable section for every Positive Tribes proposal. Copy it in after the build scope and investment, and fill the `{placeholders}`. The vision behind it: https://claude.ai/artifact/8pdk9yLPRkQqxVyrdLzNqE (Tribe Hub Care Plan).

Rules when using it:
- Open with the client's own result (the Monday-to-Friday story), then the cost comparison as proof.
- Sell only what exists. Live in the hub since Nov 5, 2026 (roadmap P1): "Request an improvement" on released tools, each request's size and cost shown before work, confirm-before-work by the director or one named contact, the credit balance and history, and the "shipped this month" count. Live since Nov 7, 2026 (P2a): Patch, an AI helper, suggests how to sort each request and the Tribe Guide decides every one; say "AI helps sort requests, a person decides", and keep the AI-service term in the Terms. Still done by hand: the Tribe Guide posts the preview link and test script, writes the monthly note, and adds boost packs on request (invoiced). Don't promise automatic sorting without review or self-serve boost checkout, and don't give dates for them. (Automatic sorting without review was shelved on Nov 10, 2026.)
- Offer Care and Growth only. Essentials ($300 a month, 2 credits, no help desk) is a retention fallback for a client who would otherwise leave. Never put it on a proposal without Eric's OK.
- Never define a credit in minutes or hours for a client. Credits are sized by scope. Time appears in one place only: the transition note for a client whose signed plan says "up to N hours" (N hours becomes 2N credits).
- Turnaround times are targets in business days, never guarantees.
- Support and outages use the same targets for every client (policy set by Eric 2026-11-24): an outage gets work started within 4 business hours, everything else a reply within 1 business day. Business hours are Monday to Friday, 8am to 6pm Mountain. Never promise faster, 24/7 cover, an uptime percentage or service credits. The phone number goes in proposals and client emails only, not on public web pages. Keep `care.html`, `support.html` and the vision page in step with this section.
- How we keep to them (internal, 2026-11-24): tribe-status emails Eric the minute a client tool is confirmed down, with the start-by time; the hub's support watch emails him when a reply is due within 2 business hours and when it's late, creates the after-outage note Task when a tool comes back, and flags any live project with no uptime check. So every tool gets a check in `status/src/config.js` at launch. Details: `hub/CLAUDE.md` (Support watch). If a target changes, change `hub/src/businesshours.js` with the kit, care.html, support.html and the vision page.
- Every plan gets a monthly note from its first month: what shipped, plus two suggested improvements. Create a recurring Salesforce Task for it when the plan is switched on.
- The help desk is for the client's staff. The people who use a tool (volunteers, members, participants) get a Help page in the tool instead (vision Decision 7, Nov 20, 2026): common questions, questions emailed to the client's own people (never to Positive Tribes) and problem reports to the hub. It is not a hub feature, so promise it only in a build's scope when that build includes it. Don't promise AI answers to users' questions; that step isn't decided.
- Always include "Included / Not included". It is what keeps this a software team and not an IT department.
- Never name the AI vendor or model (Anthropic, Claude) to clients. Say "an AI service", "AI" or "our AI helper".
- Use made-up or the client's own examples. Never name another client's tools or people.
- The plan goes live in the client's hub only after the project is signed off, completed and released. Say so in the proposal.
- Update the pricing experiments table in the Productization Strategy doc each time this offer goes out and when it's won or lost.

---

## Your own software team, without the payroll

{Client story: one sentence in this shape. "{Role} asks for {a change} on Monday. On Thursday {they're} testing it, and by Friday {who benefits} {outcome}."}

Most nonprofits {client name}'s size have no tech staff. With the Care plan, {client name} gets what a tech team would provide: hosting, monitoring, a help desk, fixes, and a tool that keeps getting better every month. It costs a fraction of hiring, because AI does the routine work and a real person at Positive Tribes, your Tribe Guide, makes the decisions.

**What a year of tech help costs**

| Option | Yearly cost | Improves with you? |
|---|---|---|
| Freelancer, for the same amount of change ({3 or 6} hrs a month at $125) | ~${4,500 or 9,000}, plus hosting and every fix billed on top | When they're free |
| **Positive Tribes Care plan** | **${monthly × 12}** | **Yes, every month** |
| Off-the-shelf subscription | {client's current tool cost, or $5,000–15,000} | No |
| Agency retainer ($2k–5k a month) | $24,000–60,000 | Yes, in billed hours |
| Full-time developer (salary + benefits) | ~$95,000 | Yes |

*Freelancer, agency and developer figures are typical U.S. estimates. The freelancer row is the like-for-like comparison: a care plan keeps your tool running and adds a few improvements a month. It is not a full-time hire.*

**How changes work**

1. Ask for a fix or an improvement in your hub, in plain words.
2. Usually within one business day, we tell you whether it's a fix (always free), an improvement (with its size and cost, shown before any work starts), or a bigger project (quoted separately, nothing used).
3. You test it on a safe copy with sample data, following a short test script.
4. Need a tweak? Say so. Tweaks that fix what you asked for are always free.
5. Once you sign off, your Tribe Guide reviews it and puts it live.
6. Each month you get a short note: what shipped, plus one or two ideas worth considering.

**Plans**

| | Care | Growth |
|---|---|---|
| Monthly | $500 | $750 |
| Hosting, backups, monitoring | ✓ | ✓ |
| Fixes to our code | Free | Free |
| AI help desk | ✓ | ✓ |
| Credits a month | 6 | 12 |
| Target: built within 3 business days of confirming |  | ✓ |
| Quarterly Salesforce health review (for clients on Salesforce) |  | ✓ |

Sizes: a small change (one change on one screen) is 1 credit, a medium one (a few related changes) is 2, and a large one (a change across several screens of one feature) is 4. Wording, label, typo and image changes are free.

Growth also includes a quarterly Salesforce health review by a Salesforce Certified Administrator: permissions, licenses, data quality and reports, with a short written summary. It is on top of the monthly credits. Any change the review recommends is sized and paid in credits like any other improvement. Only offer it to clients whose records live in Salesforce (it is a manual review by Eric, not a hub feature).

**Our promises**
- Fixes are always free.
- You see the cost before any work starts.
- Unused credits roll over for one month.
- Running out never blocks you. Extra requests wait for next month at no cost, or you can add an optional boost pack (6 credits for $300, good for 12 months).
- Every month you hear from us: what shipped, and what we'd suggest next.

**Support and outages**

We watch your tools so you don't have to: uptime checks every few minutes, alerts when a scheduled job fails, and daily backups. Your hub's home page shows each tool's live status and its uptime for the last 90 days.

| What's happening | How to reach us | Our target |
|---|---|---|
| **Outage:** the tool is down or can't be used (it won't load, nobody can sign in, or data isn't saving) | We're usually alerted first. If you notice it, call or text 720-762-0570, then report it in your hub | Work starts within 4 business hours, with updates in your hub until it's back |
| **A scheduled job fails** (for example, a weekly check or a nightly sync) | We're alerted automatically | Fixed the same business day where we can, and always before its next run |
| **Problem:** something isn't working as it should, but you can keep working | Report a problem in your hub | A reply within 1 business day; most fixes done within 3 business days |
| **Question or improvement** | Ask in your hub | A reply within 1 business day, with the size and cost of any improvement |

After any outage, you get a short note in your hub within 2 business days: what happened, how we fixed it, and what we changed so it doesn't happen again.

Business hours are Monday to Friday, 8am to 6pm Mountain time. These are targets, not guarantees, and fixes never use credits.

**Included / Not included**

| Included | Not included |
|---|---|
| The tools Positive Tribes built, with hosting, backups and monitoring | Laptops, phones, printers and Wi-Fi |
| Their connections (your CRM, texting, email) | Email accounts, passwords, Microsoft 365 or Google Workspace admin |
| The data inside those tools, kept separate for {client name} | Security for systems Positive Tribes doesn't run |
| A help desk for your staff's questions about those tools | Salesforce licenses and Salesforce's own support; other vendors' software |
| Fixes, courtesy edits and monthly improvements | |
| Salesforce Nonprofit Cloud setup and improvements for clients on Salesforce, sized and paid in credits (Eric is a Salesforce Certified Platform Administrator I and II, Platform App Builder, and Agentforce Sales and Service Consultant) | |

---

## Terms (monthly plan)

Replace the older "up to N hours a month, unused hours do not carry over" wording with:

- The Care plan starts when the project is signed off, completed and released. It appears in {client name}'s hub at that point, not before.
- The plan includes {credits} credits a month. Each improvement is sized by its scope (small 1, medium 2, large 4). The size is shown before work starts and credits are only used once {client name} confirms it.
- Fixes to problems in Positive Tribes' own code, and tweaks needed to deliver what was confirmed, never use credits. A fix is anything the tool should already do under the signed requirements for the project.
- Courtesy edits (wording, labels, typos, images; no change to logic or data) are free within reasonable use. If they become frequent, Positive Tribes will propose a way for {client name} to make those changes directly.
- The Growth plan includes a quarterly Salesforce health review (permissions, licenses, data quality and reports) with a short written summary. It does not use credits. Changes the review recommends are sized and use credits like any other improvement.
- Unused monthly credits roll over for one month, then expire. Boost pack credits (6 credits for $300) last 12 months and are used after monthly credits.
- Requests beyond the available credits wait for the next month at no cost, unless {client name} buys a boost pack.
- Changes needed because another service changes (for example a CRM's API or texting rules) use credits when small or medium. Larger ones are quoted before any work starts.
- New screens, modules, integrations and user roles, and changes to sign-in or payments, are new projects, quoted separately. Any request that touches personal or health data is reviewed by a person at Positive Tribes before it is sized.
- Every change is tested by {client name} on a test copy with sample data. Nothing goes live until {client name} signs off and Positive Tribes reviews it. A request with no reply for 14 days is paused with its credits held. After 60 days paused it is closed and its credits are returned to {client name}'s balance.
- Support targets: when a tool built by Positive Tribes is down or can't be used, work starts within 4 business hours; problems, questions and improvement requests get a reply within 1 business day. Business hours are Monday to Friday, 8am to 6pm Mountain time. After an outage, Positive Tribes posts a short note in the hub within 2 business days on what happened and what changed. These are targets, not guarantees: there is no uptime percentage or service credit. Fixes never use credits.
- Turnaround times are targets in business days, not guarantees. Positive Tribes tells {client name} ahead of planned time away and when work resumes.
- To answer faster, Positive Tribes uses an AI service to help sort requests. Only the request's own words are sent, with email addresses and phone numbers removed. Requests that mention sign-in, payments, permissions, or personal or health data are never sent. Under the service's commercial terms, this data is not used to train its models. A person at Positive Tribes reviews every decision before {client name} sees it.
- The monthly price may be adjusted once a year with 60 days' notice. Either side can end the plan with 60 days' notice, and {client name} always gets a full export of its data. Boost pack credits can be used until the plan's last day and are not refunded after it.

---

## Terms (changes during the build)

Add to the build agreement or proposal terms:

- Changes outside the signed scope are estimated in hours before any work starts, at {hourly rate} an hour, with the effect on the schedule shown. {client name}'s director (or the person named in the hub) chooses to add the change now, to do it after launch with care-plan credits, or not to do it.
- A change that {client name}'s director approves in the hub, with its price, becomes part of this agreement, the same as a signed change order. Positive Tribes does not start it before then and never approves on {client name}'s behalf.
