# Itinerary Book Export Guide

[中文](../zh/guide-export.md) | **English**

PILOT exports three formats from the same source data (the same `itinerary.json` + `intake.json` + reference-travelogue index), all sharing a unified **four-section** structure. Output goes to `~/.pilot/workspace/<trip-id>/exports/`.

| Format | Purpose | Characteristics |
|--------|---------|------------------|
| **Excel** (.xlsx) | Practical on-the-road tool | **The most complete of the three**: 4 sheets, SUM/SUMIF cost formulas, category dropdown validation, cross-sheet references |
| **PDF** | Print / share | Each section starts on its own page, static layout, template sheets leave blank space for handwriting after printing |
| **Word** (.docx) | Further editing | Same structure as the PDF, clean heading hierarchy, easy to keep editing yourself |

## The four sections (Excel's 4 sheets map one-to-one)

### Cover page (outside the four sections, at the very front)

Itinerary title ("`Destination` X-Day `Transport-mode` Itinerary Book"), travel dates, travelers (X adults, X kids, X seniors), departure city, generation info.

### Section 1: Day-by-Day Schedule & Budget

**Main table, one row per day** — day number/date, day summary (that day's stops strung together, e.g. "Sayram Lake → Guozigou Bridge → Yining"), lodging, categorized cost columns (admission / meals / lodging / transport / other, columns built dynamically from whatever categories are actually used), that day's subtotal; a grand total row at the bottom.

- **Budget comparison**: grand total vs. your stated budget, flagged red if over budget; per-person cost = total ÷ number of travelers; a count of unpriced items is surfaced too (so the total doesn't look cheaper than it really is)
- **Notes subsection**: lodging summary (check-in date / name / price / booking link + subtotal), transport summary (long-haul transport + daily segments + self-drive pickup/return notes), meal recommendations (grouped by day)

In the Excel version, the total row in this sheet is a **live formula** (SUM) — edit any cost cell and the total and budget comparison update automatically.

### Section 2: Day-by-Day Detailed Itinerary

One section per day, listing each item in order: time (shows "TBD" if not set), type (sight / meal / lodging / transport / other), name and notes, coordinates (only present if verified), cost, booking link (official direct links only — never fabricated if one can't be found).

### Section 3: Pre-Trip Checklist (template sheet)

**This is a template for you to print and check off by hand.** Items are derived from your trip profile by deterministic rules, not made up on the fly by the AI:

- Basics: ID documents, chargers, medication
- Season-driven: travel month → clothing suggestions (e.g. Xinjiang in July–August: big day/night temperature swings, sun protection, a windbreaker)
- Transport-driven: self-drive → dashcam / tow rope / spare fuel canister reminders
- Group-driven: traveling with kids → kids' supplies; traveling with seniors → regular medication reminders
- Preference-driven: photography → gear checklist

Table columns: Category | Item | Owner (blank) | Before departure ☐ | During the trip ☐, with blank rows at the end for adding more.

**Emergency info** is appended at the end of this section: emergency numbers, destination-specific notes (e.g. Xinjiang: border permits, signal dead zones, distance between gas stations), a placeholder for roadside-assistance info, and the itinerary data backup path.

### Section 4: Expense Log & Reconciliation (template sheet)

**For recording expenses during the trip:**

- **Expense log table**: Date | Item | Category | Amount | Paid by | Notes. The PDF/Word versions leave about 20 blank rows for handwriting; **the Excel version has category dropdown validation**, so you can log expenses right on your phone or laptop
- **Reconciliation table**: Category | Budgeted | Actual | Difference. The "Budgeted" column is a **real value** (cross-referenced from Section 1's category subtotals); "Actual" and "Difference" are left blank to fill in after the trip. In the Excel version, "Actual" uses SUMIF to auto-total from the expense log by category — as long as you log expenses, the reconciliation table fills itself in

### Appendix (at the very end)

Reference travelogue sources: the list of curated travelogues this itinerary book drew from (title/platform/link), so the itinerary is traceable back to its sources.

## Fallback strategy

- If Excel or Word export fails → PDF is still guaranteed to come out, and the failed format is reported honestly
- If PDF also fails → PILOT explains why and offers two options: "retry after fixing" or "here's a Markdown version to tide you over"
