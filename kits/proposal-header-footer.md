# Proposal kit: header and footer

Every proposal (Google Doc and the PDF sent to the client) carries the same header and footer. Copy them from the UEP Climb Scheduler proposal PDF.

**Header (every page):** the client's logo on the left, the Positive Tribes logo (with tagline) on the right, and a thin terracotta rule underneath. For UEP it is one image: `brand/proposal-header-uep.png`, served at https://positivetribes.org/brand/proposal-header-uep.png. For a new client, make the same image with their logo and `brand/positive-tribes-logo-horizontal.png`, and save it as `brand/proposal-header-{client}.png`.

**Footer (every page):** small gray text, a thin rule above it:
`Positive Tribes · Technology for healthier communities · positivetribes.org · eric@positivetribes.org` on the left, and `Page X of N` on the right.

**How to add it to a Google Doc:** header image through the Docs API (`createHeader`, then `insertInlineImage` into the header, 468 pt wide), footer through `createFooter` and text. The API cannot insert page-number fields: ask Eric to use Insert > Page numbers > Page X of Y in the footer, or confirm the footer already has it. Then download as PDF (File > Download > PDF) and check page 1 shows both.

**Rules:** the title, date line and body start below the header; use https links only; do not put Salesforce or another client's name in a client's header.
