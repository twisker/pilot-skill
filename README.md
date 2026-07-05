**English** | [中文](README.zh.md)

[![CI](https://github.com/twisker/pilot-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/twisker/pilot-skill/actions/workflows/ci.yml)

# PILOT — Conversational Travel Itinerary Design (Claude Code Skill)

> Built by **Lutu AI** (路途智能).

> **PILOT** is a Claude Code Skill that designs travel itineraries through conversation: it searches real travelogues across the web in real time, structures and curates the best ones, drafts a day-by-day itinerary you can edit by talking, checks it against deterministic conflict rules, and exports a print-ready itinerary book in Excel / PDF / Word — with a live read-only map view in your browser. Chinese-source-first (V1) since its search sources are Chinese travel platforms, but the Skill conversation itself works in any language your Claude Code session uses. Runs entirely on your own machine.

Type one line into Claude Code, and PILOT turns a trip from "an idea" into "an itinerary book you can actually take on the road."

```
/pilot 6-day family road trip in Yunnan, two adults and a kid
```

## What it is

PILOT isn't "have the AI make up an itinerary from nothing." Its main flow is:

**Conversational intake → real-time search across real travelogues → structure each one → curate a template → generate the itinerary → edit it by conversation → day-by-day refinement (with coordinate verification) → deterministic conflict checks → export in three formats.**

Every day of the itinerary traces back to a specific day in a specific real travelogue (tracked via `source_ref`); coordinates must be verified online, never filled from memory; and coverage is reported honestly — PILOT never pretends it had more material than it did.

## Highlights

- **Real-time search of real travelogues**: multi-source search across Mafengwo / Qyer / Ctrip guides / Zhihu / Xiaohongshu / Bilibili / Tuchong / 500px, with a playwright scraping fallback; video travelogues on Bilibili are understood via frame sampling
- **Structured curation**: every travelogue is normalized into a shared schema, then double-ranked by a machine score (completeness / granularity / media richness / freshness) and a taste score; after de-duplication, the top 5 become template candidates
- **Conversational editing**: "swap day 3 for the route from travelogue #2," "add a day in Hemu" — cross-travelogue splicing and day-by-day refinement all happen in conversation, with every edit automatically passing schema validation and conflict rules (excessively long drives, overpacked days, over-budget totals, anomalous coordinate distances, etc.)
- **Map companion**: a local read-only page (timeline / map / reference-travelogue card wall) that auto-refreshes in the browser (via SSE) whenever the itinerary file changes, using a Tianditu basemap
- **Three-format itinerary book**: Excel (4 sheets, with cost formulas and an expense-log template) / PDF / Word, structured to match how experienced travelers actually use a paper itinerary book on the road
- **Fully local**: all data is written to `~/.pilot/workspace/`, cookies stay on your machine only, zero cloud dependency
- **Transparent anonymous statistics with a one-switch opt-out**: event counts and coarse destinations only — never conversation content or identity, and nothing is uploaded by default (`PILOT_TELEMETRY=off` disables it globally) — see the [privacy statement](docs/en/privacy.md)

## Requirements

| Dependency | Requirement |
|------------|-------------|
| [Claude Code](https://claude.com/claude-code) | Required (PILOT is a Claude Code Skill) |
| Node.js | >= 20 |
| git | any recent version |
| yt-dlp + ffmpeg | Optional, only needed for understanding video travelogues — **you don't need to install these yourself**: answer "yes" during install, or run `npx tsx tools/setup-video.ts install --yes` any time afterward for a one-command setup (cross-platform static binaries, see "One-command video dependency setup" below) |
| OS | **macOS / Windows / Linux all supported** (Windows works natively, no WSL required) |

## Install in three steps

**macOS / Linux:**

```bash
# 1. Clone to the fixed install location (recommended; cloning elsewhere also
#    works, install.sh will copy it over automatically)
git clone https://github.com/twisker/pilot-skill.git ~/.pilot/app

# 2. Run the installer (checks dependencies -> npm install -> downloads
#    playwright chromium -> registers the skill)
cd ~/.pilot/app && ./install.sh

# 3. Open a new Claude Code session and start talking
#    /pilot 6-day family road trip in Yunnan, two adults and a kid
```

**Windows (native PowerShell / cmd, no WSL / Git Bash needed):**

```powershell
# 1. Clone to the fixed install location
git clone https://github.com/twisker/pilot-skill.git $env:USERPROFILE\.pilot\app

# 2. Run the installer (the same install.mjs, identical cross-platform logic;
#    run directly with node on Windows)
cd $env:USERPROFILE\.pilot\app
node install.mjs

# 3. Open a new Claude Code session and start talking
#    /pilot 6-day family road trip in Yunnan, two adults and a kid
```

The installer will ask whether to also install the video dependencies (yt-dlp/ffmpeg) — answer "yes," or use `--with-video --yes` for a non-interactive one-shot install. Skipping it doesn't affect the main text-travelogue flow, and you can always add it later (see below).

Optional post-install configuration (see [docs/](docs/index.md) for details):

- **Tianditu key** (map basemap): put `TIANDITU_KEY=<key>` in `~/.pilot/app/.env`, [apply for free](https://console.tianditu.gov.cn/) (choose the "browser-side" app type)
- **Site cookies** (significantly improves scraping success rate): `npx tsx ~/.pilot/app/tools/cookies.ts setup`
- **One-command video dependency setup** (for understanding Bilibili video travelogues; skipping this doesn't affect the main flow):

  ```bash
  cd ~/.pilot/app/tools && npx tsx setup-video.ts install --yes
  ```

  Automatically downloads official static binaries of yt-dlp + ffmpeg/ffprobe into `~/.pilot/bin/` (single-file official builds for macOS/Windows/Linux — no brew / winget / apt needed, and no python required either). If it's already installed and working, it's skipped automatically; add `--force` to force a re-download. On macOS, if the binary gets blocked by Gatekeeper ("cannot verify developer"), run the `xattr -d com.apple.quarantine <path>` command shown in the error message once, then retry.

## Quickstart: a sample conversation

```
You: /pilot 6-day family road trip in Yunnan, two adults and a kid

PILOT: Sounds great! A few things to confirm: exact departure/return dates?
       Which city are you starting from? Rough budget?

You: Oct 1 to 6, starting from Kunming, budget around $2,000

PILOT: (creates the trip -> builds a search plan -> searches each source for
       travelogues -> fetches -> structures -> curates)
      Coverage report for this round:
      - Ctrip guides: 10 found -> 6 selected -> 5 fetched successfully
      - Zhihu: 15 found -> 8 selected -> 6 fetched successfully
      - Mafengwo: 18 found -> 12 selected -> 2 fetched successfully
        (the rest blocked by a slider CAPTCHA)
      ...
      Curated 5 reference travelogues, recommending "Dali-Lijiang Loop, 6 Days"
      (score 7.1, 6 days) as the template ...

You: Sounds good. Day 3 is too rushed, add an extra night in Dali

PILOT: (edits -> validates -> runs conflict check) Updated: two nights in
      Dali on Day 3-4 ...
      Conflict check: Day 5's Lijiang -> Lugu Lake drive is about 300km
      in one day (warn) — split it into two days?

You: Leave it, let's export

PILOT: (day-by-day refinement -> coordinate verification -> final conflict
      check -> export)
      Itinerary book exported: ~/.pilot/workspace/yunnan-selfdrive-20261001/exports/
      ├── itinerary.pdf  ├── itinerary.xlsx  └── itinerary.docx
```

Full walkthrough: [docs/en/tutorial-quickstart.md](docs/en/tutorial-quickstart.md).

## Documentation

`docs/` is the documentation site (GitHub Pages), available in both Chinese and English. To enable it as a maintainer: repo **Settings → Pages → Source → branch `main`, folder `/docs`**, save, and it's live.

| Doc | Contents |
|-----|----------|
| [docs/index.md](docs/index.md) | Documentation index (bilingual entry point) |
| [docs/en/tutorial-quickstart.md](docs/en/tutorial-quickstart.md) | Full walkthrough: install → first trip → edit → export |
| [docs/en/guide-cookies.md](docs/en/guide-cookies.md) | Full cookie-export flow and per-site notes |
| [docs/en/guide-config.md](docs/en/guide-config.md) | Full field reference for `config/pilot.json` |
| [docs/en/guide-export.md](docs/en/guide-export.md) | The itinerary book's four-section structure and template sheets |
| [docs/en/faq.md](docs/en/faq.md) | Frequently asked questions |
| [docs/en/privacy.md](docs/en/privacy.md) | Privacy statement: what the anonymous statistics collect / never collect / how to opt out |

中文文档在 [docs/zh/](docs/zh/)（与英文版内容一一对应，非摘要翻译）。

## FAQ (at a glance)

**Why do I need cookies?**
Sites like Mafengwo and Xiaohongshu apply anti-bot measures to unauthenticated access (CAPTCHAs, login walls). PILOT provides a guided tool to export cookies after you log in through a local browser window — **saved only on your machine at `~/.pilot/cookies/`, never uploaded to any server**. PILOT works without exporting cookies too, just with a lower fetch success rate on those sources — it reports this honestly and degrades gracefully. See [docs/en/guide-cookies.md](docs/en/guide-cookies.md).

**How do I get a Tianditu key?**
Sign up for free at the [Tianditu console](https://console.tianditu.gov.cn/) and create a "browser-side" app to get a key. Without a key, the map view shows a setup prompt and the main itinerary-design flow is unaffected.

**What if fetching fails?**
Some sources getting blocked by anti-bot measures is normal. PILOT's fallback chain: WebSearch → WebFetch direct read → playwright fallback → summary-only supplement → honest coverage report with options (continue / export cookies and retry / rephrase and search again) — it never pretends it had enough material. See [docs/en/faq.md](docs/en/faq.md).

## License

Copyright (c) 2026 twisker. **All rights reserved.**

Personal, non-commercial use is permitted; commercial use and redistribution require prior written permission. See [LICENSE](LICENSE).
