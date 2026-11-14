# Showcase kit: "what have you built?" in 5 minutes

When a prospect asks to see work for other nonprofits, send a PDF made from one source page instead of writing it from scratch. First used for WHES, 2026-11-12 (Kathy Goss asked on the call).

## Make a PDF

```
~/Projects/PositiveTribes/kits/showcase/make-pdf.sh ~/Desktop/PT-Showcase-WHES.pdf --for "WHES" uep safe
```

- `--for` puts "Prepared for <name>" in the top line (optional).
- List case ids to include (`uep`, `safe`); leave them out to include every case.
- It writes the PDF plus page previews in `pdfprev/` next to it. Look at every page before attaching.
- Needs Google Chrome and `swift` (both on Eric's Mac). Fonts load from Google Fonts, so run it online.

## Rules (from CLAUDE.md and memory)

- Name only clients who agreed: UEP, SAFE, Project Coyote (see memory `client-naming-consent`).
- Screens show sample data only. Never real donors, participants, prices or client figures.
- Never name the AI vendor.
- A person approves the email it goes out with. Log the send in Salesforce and, for hub clients, the hub `documents` table.

## Add a case

1. Screenshot the demo with sample data (headless Chrome works: `--headless=new --window-size=1280,1500 --screenshot=...`), crop with PIL, save as JPG in `img/`.
2. Copy a `<section data-case="...">` block in `showcase.html`: challenge, what we built (value first), a status pill, 1–3 figures with alt text and "Sample data" captions.
3. Add the demo link in the closing section and the client to the footer's permission line.
4. Keep the opening line true for any subset of cases (no counts).
5. Run `make-pdf.sh` with all cases and check the previews.

## Files

- `showcase.html`: the source page (also publishable as an artifact; the published copy is https://claude.ai/artifact/KAHfWN9ku4sXj7PxYqG1wY, which is private to Eric).
- `print.css`: Letter layout used only when printing.
- `make-pdf.sh`: filters cases, fills the prospect name, prints, renders previews.
- `render-pages.swift`: PDF pages to PNGs (no poppler needed).
