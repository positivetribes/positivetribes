# Intro package kit: a ready-to-send packet for new prospects

One PDF per prospect, so the one-pager is never forgotten again (it was missed in the Outdoor Lab email of 2026-11-15). First used for Mission:Wolf and Wildlife for All, 2026-11-15.

The packet, in order:
1. **Cover page** for this prospect: who it's for, why we reached out, up to four ideas for them (value first), what's inside, and the ask.
2. **The one-pager**: `onesheet/positive-tribes-one-sheet.pdf`, the same file the website serves.
3. **Showcase cases** (optional) from `kits/showcase/`, stamped "Prepared for <name>".

## Make one

1. Write `~/Projects/<Client>/intro/prospect.json` (the prospect's content stays in the client folder, the code stays here):

```json
{
  "name": "Mission:Wolf",
  "for": "Prepared for Kent Weber and the Mission:Wolf team",
  "showcase_for": "Mission:Wolf",
  "headline": "Less time on paperwork, *more time with the wolves.*",
  "why": ["Paragraph about their work and the pain.", "Paragraph about us and the link (who introduced us, a similar build)."],
  "ideas": [{"title": "Volunteers and interns", "text": "One sentence, benefit first."}],
  "ask": "What's one task that keeps your team from the wolves? *Let's talk.*",
  "cases": ["uep", "safe"]
}
```

`*text*` in `headline` and `ask` becomes the rust italic. Up to 4 ideas. Leave `cases` empty for cover plus one-pager only.

2. Build it:

```
~/Projects/PositiveTribes/kits/intro-package/make-intro.sh ~/Projects/<Client>/intro/prospect.json <out>/Positive-Tribes-Intro-<Client>.pdf
```

3. Look at every page in `<out>/pdfprev/`. The cover must fit on one page (the CTA sits at the bottom).
4. Copy the PDF to Drive `My Drive/Customers/<Client>/` (local sync folder: `~/Library/CloudStorage/GoogleDrive-eric@positivetribes.org/My Drive/Customers/`).

Needs Google Chrome and `swift` (both on Eric's Mac), and a connection for the showcase's Google Fonts.

## Email that goes with it

Reply in the existing thread and attach the PDF. Keep it to four short paragraphs:

1. Context: who introduced us, or the last exchange.
2. What's attached, naming their two or three ideas (value first).
3. The one-minute video: `<a href="https://positivetribes.org">positivetribes.org</a>`.
4. The ask: a 20 to 30 minute call, with the booking page `<a href="https://calendar.app.google/fgb6DMgaKrooRoys7">calendar.app.google/fgb6DMgaKrooRoys7</a>`, or "when timing works" if they said they're busy.

End at "Thanks,<br>Eric" with `includeSignature: true`. Use https links only. Eric sends it.

## Rules

- Cover facts about the prospect come from their own site or their emails. Frame ideas as conversation starters, not claims about their problems.
- No prices, and no "free" (pricing comes after the first call).
- Name only clients who agreed (UEP, SAFE, Project Coyote). Never link the Coyote prototype or any backlog.
- After sending: Gmail logs the email to Salesforce. Check it landed on the right record (a packet that mentions Project Coyote can get logged to the Coyote Opportunity, which happened 2026-11-15), add a dated follow-up Task, and for hub clients add the PDF to the hub `documents` table.

## Files

- `cover.html`: cover template (`{{FOR}}`, `{{HEADLINE}}`, `{{WHY}}`, `{{IDEAS}}`, `{{INSIDE}}`, `{{ASK}}`).
- `make-intro.sh`: fills the cover, prints it, adds the one-pager and showcase, merges, renders previews.
- `merge.swift`: merges PDFs with PDFKit (no poppler or pypdf needed).
