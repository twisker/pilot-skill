# FAQ

[中文](../zh/faq.md) | **English**

## Fetching & material

### Scraping got blocked by a CAPTCHA / anti-bot wall — now what?

**This is normal, not a failure.** Mafengwo runs a slider-CAPTCHA WAF, Xiaohongshu rejects unauthenticated access outright, and even playwright can get blocked. PILOT's full fallback chain:

```
WebSearch (free) -> WebFetch direct read -> playwright fallback scrape
-> summary-only supplement -> mark as failed and continue -> honest coverage report
```

When material is thin, PILOT gives you three options and lets you decide:

1. **Continue anyway**: use what's available; low-confidence days are flagged
2. **Export cookies and retry**: see the [cookie guide](guide-cookies.md) — the single biggest lever for improving success rate
3. **Switch sources or rephrase**: adjust the destination granularity or wording and search again

### What does "summary-only supplement" mean in the coverage report?

For entries where the full-text fetch failed but the search snippet has enough information, PILOT generates a low-confidence structured travelogue from just the title + snippet to participate in curation — **counted separately, and never passed off as a successful fetch**. If summary-only entries exceed half the total, PILOT adds an extra note that material quality is on the low side.

### Why do Ctrip guides / Tuchong keep showing up near the top of the coverage report?

The `preferred_domains` setting in the config ranks domains with empirically higher fetch success rates higher (see the [configuration reference](guide-config.md)) — this is expected behavior.

## Map

### What happens without a Tianditu key?

The map view shows a setup prompt (not an error); the timeline and reference-travelogue card wall work normally, and the main itinerary-design flow is completely unaffected. The key is free: [Tianditu console](https://console.tianditu.gov.cn/) → sign up → create a "browser-side" app → put the key into `~/.pilot/app/.env`:

```
TIANDITU_KEY=your-key
```

### The map page won't load?

- Make sure the server is running: PILOT starts it automatically while a trip is in progress; to start it manually:
  `npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id>`
- Port conflict: default is 4870, override with `PILOT_PORT` in `.env`
- If the server fails to start it doesn't block the main flow — you can complete an itinerary book entirely through the terminal conversation

### Some points in my itinerary aren't on the map?

Coordinates must be verified online; any entry whose `geo` couldn't be verified is left empty and doesn't appear on the map — PILOT would rather leave it out than fill in a coordinate from memory.

## Install & updates

### How do I update to a new version?

```bash
cd ~/.pilot/app && git pull && ./install.sh
```

(If you cloned somewhere else, run `git pull && ./install.sh` from that clone directory — the script re-syncs it into `~/.pilot/app`.)
Your data is untouched: trips live in `~/.pilot/workspace/`, cookies in `~/.pilot/cookies/`, and `.env` is preserved too.

### How do I uninstall?

```bash
rm ~/.claude/skills/pilot          # unregister the skill (it's a symlink; on Windows it may be a
                                    # directory junction or a plain copy — check the install log)
rm -rf ~/.pilot/app                # remove the program
rm -rf ~/.pilot                    # (optional) also remove all trip data and cookies
```

Windows (PowerShell) equivalents: `Remove-Item $env:USERPROFILE\.claude\skills\pilot -Recurse -Force` / `Remove-Item $env:USERPROFILE\.pilot -Recurse -Force`.

### It says yt-dlp / ffmpeg are missing for video travelogues?

Video understanding is optional; install it with one command:

```bash
cd ~/.pilot/app/tools && npx tsx setup-video.ts install --yes
```

This downloads official static binaries for macOS/Windows/Linux into `~/.pilot/bin/` — no brew / winget / apt needed, and no python required either. If it's already installed and working it's skipped automatically; use `--force` to force a re-download. If you skip this, PILOT just skips the video pass and works from text and photo-gallery material only — the main flow is unaffected.

On macOS, if the binary gets blocked by Gatekeeper ("cannot verify developer"), run `xattr -d com.apple.quarantine <path-to-binary>` once as the error message suggests, then retry.

### `/pilot` isn't triggering?

- Confirm the skill is registered: `ls -l ~/.claude/skills/pilot` (Windows: `dir %USERPROFILE%\.claude\skills\pilot`) should point to / contain the contents of `~/.pilot/app/skill`
- You need a **new** Claude Code session (the skill list loads at session start)
- Rerunning the install script fixes registration issues: macOS/Linux `~/.pilot/app/install.sh`; Windows `node %USERPROFILE%\.pilot\app\install.mjs`

## Data & privacy

### Does my data get uploaded anywhere?

No. PILOT's toolchain has zero cloud dependency: search and scraping run on your own machine, and trips/material/cookies all live locally under `~/.pilot/`. Your conversation with Claude itself follows your own Claude Code data settings.

### Are cookies safe?

Cookies are saved only under `~/.pilot/cookies/` and never uploaded; we recommend using a secondary account and deleting them whenever you like. See the commitment section in the [cookie guide](guide-cookies.md).

### I want to start a fresh trip from scratch?

Just say "start a new trip" — the old trip stays exactly as it was in `~/.pilot/workspace/`, and you can always come back to it later.
