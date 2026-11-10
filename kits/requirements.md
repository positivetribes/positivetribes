# Requirements file (standard for every client project)

**Rule:** every client project gets a requirements file the day its Opportunity is Closed Won. It is the one source of truth for what we agreed to build and the acceptance checklist for each phase. Proposals, hub items, prototypes, test scripts and estimates all point back to it.

**Exception:** a tiny scope (one page, a one-week fix) doesn't need a file. Put a short numbered list inside the proposal and say so in the hub card.

## Why
- A hub item, a prototype screen and a proposal line can each say something different. The file is the one place they are checked against.
- It gives estimates a place to start (is it already in scope? already built?), and acceptance tests a list to cover.
- Money and scope arguments get settled by a dated row, not by memory.

## Where it lives
`docs/requirements.md` in the project's repo (for a project with several parts, one file per part, e.g. `docs/fundraising-requirements.md`). Pick a short ID prefix per file (`R`, `F`, ...). Code, migrations and tests cite the IDs in comments.

## Layout
One table per area. Columns: `ID | Requirement (in the client's words) | Source | Phase | Prototype | Hub` (add a `Status` column once building starts).
- **Source:** where it came from (email, call date, proposal, hub item number).
- **Hub:** the hub item number, so one search finds both.
- A section **Proposed, not decided** for asks nobody has accepted. They get no ID until the client decides, and are then priced as a change (hub estimate).
- A section **Not included** so scope questions have a written answer.
- A **Timeline** block with the agreed dates.

## Keeping it right
When a client or Eric adds, changes or drops something, work through this list in the same task and tell Eric in one line what was updated:
1. The requirements file (new or amended row).
2. The hub item (phase, tier, answer).
3. The prototype, if screens or wording change.
4. UAT scripts or the acceptance tests doc.
5. A dated Salesforce Task for any follow-up, plus a status-log entry. If price or scope changes, flag it to Eric before anything reaches the client.
6. Run the check: `node kits/requirements/check-requirements.mjs --file docs/requirements.md --prefix R` from the repo root (copy the script into the repo's `scripts/`). It fails on an ID cited in code that has no row. Run it before every phase sign-off.

## Seeding a new project
Copy UEP's `scheduler/docs/requirements.md` structure. Start from the signed proposal and the hub's accepted items (one row each), keeping the client's own wording.
