# Positive Tribes financials

This folder is for running Positive Tribes' money as a 501(c)(3): choosing and using the books, recording client and donor income, and staying compliant with the IRS and Colorado. Claude's job here is to be a careful, plain-spoken finance advisor and bookkeeper's assistant for Eric, who is the founder and is not an accountant.

## Organization facts

- Positive Tribes, 501(c)(3) public charity, EIN 99-2221407, based in Golden, Colorado.
- Mission: builds technology that small, grassroots nonprofits could never otherwise afford ("technology for healthier communities").
- Donations come in through Stripe Checkout on positivetribes.org (`../donations.mjs`) and are recorded in Salesforce Nonprofit Cloud. Clients are tracked in Salesforce and the command center at positivetribes.org/admin.
- Personal finances are in Quicken Classic Deluxe for Mac (Quicken ID traveleric@gmail.com). That stays personal.
- The org banks at Wells Fargo, in an account in its own name. All client and donor money goes there, and Stripe donation payouts deposit into it.

Facts still to confirm and record here when known: fiscal year end, IRS determination letter date and public charity basis (509(a)(1) or 509(a)(2)), accounting software chosen, board members and officers, CPA or bookkeeper, Colorado charitable solicitation registration number.

## Decisions so far

- **Do not run Positive Tribes in Quicken.** Quicken Classic Deluxe is a personal-finance tool: no invoicing, no accounts receivable, no class or fund tracking, no nonprofit reports, and CPAs can't log in to it. Keeping org money in the personal Quicken file would also blur the line between Eric's money and the charity's, which is exactly what the IRS and Colorado look for. Quicken keeps doing personal finances only.
- **Recommended books: QuickBooks Online**, bought at the nonprofit discount through TechSoup. It handles client invoices and payments, has a Stripe connection, works with Salesforce, and nearly every nonprofit CPA knows it. Use Classes for functional expenses (Program / Management & General / Fundraising) and Locations or Tags for restricted grants.
  - Alternative: **Aplos**, if restricted grants become a large share of revenue, because it does true fund accounting. Choose Aplos only for that reason.
  - **Chosen (Oct 29, 2026): QuickBooks Online Plus via TechSoup.** Purchase waits until the org receives its first payment (client fee or donation). **When a first payment comes up, remind Eric to buy QBO before recording it.** Payroll is deferred until the board approves a salary.

## Ground rules Claude should keep reinforcing

1. **Separate everything.** The org has its own bank account in the org's name and under its EIN. Every client and donor payment goes there, and nothing personal is paid from it. If Eric pays an org expense personally, he submits a reimbursement with the receipt (an accountable plan), and doesn't just "even it out" later.
2. **Eric can't simply take money out.** Net earnings can never go to an insider (private inurement). Paying Eric means a board-approved, documented, reasonable salary run through payroll (W-2 with withholding) or documented reimbursements. Flag any transfer to Eric that isn't one of those. Large or unusual payments to insiders can trigger excess-benefit penalty taxes under IRC 4958.
3. **Every client relationship needs a written agreement**, and every payment needs an invoice in the books. Client fees are *program service revenue* when the work advances the mission.
4. **Watch for unrelated business income.** Work for clients that doesn't advance the mission is unrelated business income. One example would be general tech consulting for for-profit companies. If gross unrelated income reaches $1,000 in a year, it needs Form 990-T and may owe tax. If it becomes a substantial part of activity, it can put the exemption at risk. When a new client or offering appears, ask: is this client a nonprofit or community group, and does the work serve the mission? Record the answer.
5. **Donations aren't client fees.** Gifts get a written acknowledgment for any gift of $250 or more, saying whether goods or services were provided. The site's receipt language already does this for online gifts. If a donor gets something worth more than $75 in return, a quid-pro-quo disclosure is needed. If a "donation" from an organization comes with deliverables, it is really a fee and should be booked as one.
6. **Track restrictions.** Money given for a specific purpose or time period is *with donor restrictions* and must be spent on that purpose. Everything else is *without donor restrictions*. Keep the grant letter with the record.
7. **Pay contractors properly.** Collect a W-9 before paying anyone. Issue a 1099-NEC to contractors paid at or above the IRS threshold, which is $2,000 for payments made in 2026 and later. Confirm the current figure before filing.
8. **Keep receipts and records for at least 7 years.** That includes bank statements, invoices, receipts, board minutes approving pay, and donor acknowledgments.

## Compliance calendar (confirm dates against the fiscal year)

- **IRS Form 990 series**, due the 15th day of the 5th month after fiscal year end (May 15 for a calendar year). An automatic 6-month extension is available with Form 8868.
  - 990-N (e-Postcard) if gross receipts are normally $50,000 or less.
  - 990-EZ if gross receipts are under $200,000 and total assets are under $500,000.
  - Full 990 above those limits. The full 990 requires functional expense reporting, so tag every expense by function from day one.
  - Missing three years in a row automatically revokes exemption.
- **Form 990-T** if gross unrelated business income is $1,000 or more.
- **Public support test**: as a new charity, Positive Tribes is treated as a public charity for its first five years. After that it must show broad public support on Schedule A. Too much revenue from a single client or donor can hurt this, so watch concentration.
- **Colorado**:
  - Charitable solicitation registration with the Secretary of State before soliciting donations, renewed every year, with financial info reported.
  - Nonprofit corporation periodic report with the Secretary of State every year, in the month the org was formed.
  - Colorado sales tax exemption certificate (Department of Revenue) for purchases.
- **Payroll** (once Eric is paid): federal 941s quarterly, W-2s and W-3 by January 31, Colorado withholding. Use a full-service payroll provider instead of doing it by hand. For one employee in Colorado, the 2026 costs were about $42/month for Patriot Full Service, $55 for Gusto Simple or OnPay, and $50–57 for QuickBooks Payroll Core. All of them sync with QuickBooks Online. 501(c)(3)s are exempt from federal unemployment tax (FUTA), but not from Colorado unemployment insurance or FAMLI.
- **1099-NEC** to contractors by January 31.

## Monthly routine to guide Eric through

1. Reconcile the org bank account and Stripe payouts in the books. Stripe deposits are net of fees, so book the gross gift and the fee separately.
2. Make sure every client payment matches an invoice and every donation matches a Salesforce gift record.
3. Tag each expense with its function (Program / M&G / Fundraising) and, if restricted, its grant.
4. File receipts.
5. Review a one-page Statement of Activities (income vs. expenses) and Statement of Financial Position (what the org has and owes). Share them with the board at least quarterly.

## How Claude should work in this folder

- Explain in plain language, give the reason behind each rule, and point to the IRS or Colorado source (IRS Pub 557, Form 990 instructions, Colorado Secretary of State) when a rule matters.
- Tax thresholds and form rules change. Verify current figures with a web search before giving a number Eric will act on, and say when something should be checked with a CPA. Recommend engaging a nonprofit CPA for the first 990 that isn't a 990-N, and before Eric is first paid.
- Never commit financial data to git. Bank exports, statements, receipts, donor or client details and anything with account numbers stay out of the repo (`.gitignore` here allows only this file). Keep source documents in Google Drive or the accounting system and refer to them by name.
- Don't move money, send payments, file forms or email anyone on the org's behalf without Eric's explicit go-ahead.
- When Eric makes a decision (software, fiscal year, bank, CPA, compensation), update the "Organization facts" and "Decisions so far" sections above.
