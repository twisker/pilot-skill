# Quickstart Tutorial: From Install to Your First Itinerary Book

[中文](../zh/tutorial-quickstart.md) | **English**

This tutorial walks through PILOT's main flow end to end: **install → your first trip → conversational editing → export a three-format itinerary book.** The whole thing takes about 30–60 minutes (most of it is PILOT searching and scraping in the background — you just answer a few questions and make some choices along the way).

## 0. Prerequisites

- [Claude Code](https://claude.com/claude-code) installed and working
- Node.js >= 20 (check with `node -v`)
- **macOS, Windows, or Linux** — Windows is supported natively, no WSL required

## 1. Install

**macOS / Linux:**

```bash
git clone https://github.com/twisker/pilot-skill.git ~/.pilot/app
cd ~/.pilot/app && ./install.sh
```

**Windows (PowerShell / cmd):**

```powershell
git clone https://github.com/twisker/pilot-skill.git $env:USERPROFILE\.pilot\app
cd $env:USERPROFILE\.pilot\app
node install.mjs
```

Expected output (excerpt):

```
[pilot-install] checking dependencies ...
[pilot-install] node v24.14.1 / npm 11.16.0 / git OK
[pilot-install] repo is already at the install location /Users/you/.pilot/app, using in place (git pull to update)
[pilot-install] installing tools dependencies (npm install) ...
[pilot-install] downloading playwright chromium (scrape fallback / PDF export, ~150MB first time) ...
[pilot-install] registering Skill: symlink /Users/you/.claude/skills/pilot -> /Users/you/.pilot/app/skill
[pilot-install] install complete. Next steps:
  1) configure the map key ...
  2) export site cookies ...
  3) start using it: open a new Claude Code session and type /pilot ...
```

**Two optional things worth doing now** (both skippable, and you can do them any time later):

```bash
# Map basemap key (free): apply for a "browser-side" app at
# https://console.tianditu.gov.cn/
echo 'TIANDITU_KEY=your-key' >> ~/.pilot/app/.env

# Site cookies (significantly improves travelogue scraping success rate,
# saved locally only)
npx tsx ~/.pilot/app/tools/cookies.ts setup
```

## 2. Your First Trip: Intake

Open a new Claude Code session (any directory) and type:

```
/pilot 6-day family road trip in Yunnan for a long weekend, two adults and a kid
```

PILOT first fills in whatever it doesn't yet know (at most 3 questions per round):

```
PILOT: Sounds great — a Yunnan road trip with a kid! A few things to confirm:
       1. Exact departure and return dates?
       2. Which city are you starting from?
       3. Rough total budget? (fine to skip)
```

Once you answer, PILOT creates the trip and reads back the profile for you to confirm:

```
PILOT: To confirm: Oct 1–6, 6 days total, starting from Kunming,
       2 adults + 1 kid, self-drive, budget ¥15,000, relaxed pace.
       I'll start searching travelogues now if that's right.
```

At the same time it starts the **map companion** (a local page at http://localhost:4870 with three views: timeline / map / reference-travelogue card wall). The browser auto-refreshes every time the itinerary changes.

## 3. Search & Curation (PILOT does this automatically — you just watch the report)

PILOT builds a multi-source search plan, searches each source, picks candidates, fetches full text, hands each travelogue to a sub-agent for structuring, then scores and curates. When it's done it gives you an **honest coverage report**:

```
Coverage report for this round:
- Ctrip travel guides: 10 found -> 6 selected -> 5 fetched successfully
- Zhihu: 15 found -> 8 selected -> 6 fetched successfully
- Mafengwo: 18 found -> 12 selected -> 2 fetched successfully
  (the rest blocked by a slider CAPTCHA)
- Xiaohongshu: could not fetch (needs a login cookie)
- Bilibili: 3 videos queued for the second pass
Travelogues available for structuring: 13.
```

> Some sources getting blocked is **normal, not a bug**. When source material is thin, PILOT will say so plainly — "reference material is a bit sparse this round, itinerary quality will suffer" — and give you three options: continue anyway / export cookies and retry / search again with different terms. See the [cookie guide](guide-cookies.md).

PILOT then shows the top 5 curated travelogues (title + summary + tags + score + day count + source link) and recommends one as the template. You can pick a different one.

## 4. Draft Itinerary & Conversational Editing

Once you confirm a template, PILOT trims and adapts it to your dates/group/budget to produce a day-by-day draft, runs a conflict check automatically, and shows you the result. From there it's just conversation:

```
You: Day 3 feels too rushed, drop one stop
You: Swap day 5 for the route from travelogue #2
You: Add a day in Hemu
```

After every edit PILOT does three things automatically: schema validation → conflict check → shows you exactly which days changed. Conflict rules include: excessively long driving days, an overpacked single day, over-budget totals, and anomalous distances between adjacent coordinates. For warn-level conflicts you can just say "leave it" and PILOT will remember and stop repeating that warning.

Once you're happy with the overall shape, say "the itinerary is set" to move into day-by-day refinement.

## 5. Day-by-Day Refinement

PILOT refines 1–2 days at a time, showing its work as it goes:

- Fills in lodging, daily transport (route segments and estimated duration), worthwhile meals for each day, and admission costs
- **Every coordinate is verified online** (Nominatim / Wikipedia), never filled from memory — if it can't be verified, it doesn't go on the map, no fabrication
- Automatically dials down pace for elderly travelers and shortens drive times when kids are along

## 6. Export

```
You: export the itinerary book
```

PILOT runs one final full conflict check, then exports PDF → Excel → Word in sequence:

```
Itinerary book exported:
~/.pilot/workspace/yunnan-selfdrive-20261001/exports/
├── Yunnan-6-Day-Road-Trip.pdf
├── Yunnan-6-Day-Road-Trip.xlsx   (4 sheets, with cost formulas and an expense-log template)
└── Yunnan-6-Day-Road-Trip.docx
```

See the [export guide](guide-export.md) for the four-section structure and how to use the template sheets.

## 7. Pause & Resume

You can close the session at any time. Next time you type `/pilot`, PILOT detects your previous trip:

```
PILOT: Last time you were working on "yunnan-selfdrive-20261001"
       (curation done, itinerary in editing). Continue that one,
       or start a new trip?
```

All past trips stay in `~/.pilot/workspace/` — starting a new trip never deletes an old one.

## What's Next

- [Cookie export guide](guide-cookies.md) — the first thing to do if scraping success rate is low
- [Configuration reference](guide-config.md) — tune search sources, curation count, map basemap
- [FAQ](faq.md) — common questions
