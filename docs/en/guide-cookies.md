# Cookie Export Guide

[中文](https://twisker.github.io/pilot-skill/zh/guide-cookies.html) | **English**

## Why you need cookies

Sites like Mafengwo and Xiaohongshu (Chinese travelogue platforms) apply strong anti-bot measures to unauthenticated automated access (slider CAPTCHAs, login walls). Without a logged-in session, scraping success on these sources is low — PILOT won't crash because of it, but you'll have less reference material and the resulting itinerary book quality will suffer.

Exporting your own login cookies lets PILOT's playwright-based scraper carry your logged-in session, which noticeably improves the success rate.

## Commitment (please read first)

- Cookies are saved **only on your own machine**, under `~/.pilot/cookies/` (playwright `storageState` JSON format)
- PILOT **never uploads cookies to any server** — the entire toolchain has zero cloud dependency; all scraping happens on your machine
- A cookie is equivalent to your login credential — **do not** send the files under `~/.pilot/cookies/` to anyone or commit them to git
- You can delete them at any time: `rm ~/.pilot/cookies/<site>.json` invalidates it immediately

## Full flow: `cookies.ts setup`

```bash
# Walk through all sites in one go (recommended for first-time setup)
npx tsx ~/.pilot/app/tools/cookies.ts setup

# Handle a single site only
npx tsx ~/.pilot/app/tools/cookies.ts setup --site xhs
```

For each site, the flow is:

1. The tool opens a **visible Chromium window** and navigates to that site's login page
2. You log in normally in the window (QR code / SMS / password, whatever the site offers)
3. The tool polls for a login signal every 2 seconds:
   - **Zhihu / Xiaohongshu / Bilibili**: detecting a marker cookie (`z_c0` / `web_session` / `SESSDATA`) auto-confirms success
   - **Mafengwo / Qyer**: no stable marker cookie exists, so it falls back to "cookie count increased noticeably + you press Enter to confirm"
4. Once confirmed, it saves the `storageState` to `~/.pilot/cookies/<site>.json` and moves to the next site
5. Per-site timeout is 5 minutes: it skips that site and continues (you can retry it later with `--site`)

At the end, stdout prints a per-site result JSON (for a record you can keep), while progress goes to stderr.

## Per-site notes

| Site | `--site` value | Cookie file | Login signal | Notes |
|------|----------------|-------------|---------------|-------|
| Mafengwo | `mafengwo` | `mafengwo.json` | none (Enter-to-confirm fallback) | Even with a cookie, you may still hit a slider CAPTCHA and need to solve it manually once |
| Zhihu | `zhihu` | `zhihu.json` | `z_c0` | Auto-detected |
| Qyer | `qyer` | `qyer.json` | none (Enter-to-confirm fallback) | Login entry point is the forum (bbs.qyer.com) |
| Xiaohongshu | `xhs` | `xhs.json` | `web_session` | **This source is skipped outright without a cookie** (marked failed, reason `no-cookie`) |
| Bilibili | `bilibili` | `bilibili.json` | `SESSDATA` | Used for downloading video travelogues (yt-dlp) |

## Checking status: `cookies.ts status`

```bash
npx tsx ~/.pilot/app/tools/cookies.ts status
```

Prints a table per site: whether the cookie file exists, whether the marker cookie is present, and the earliest expiry time. Once a cookie expires, just rerun `setup --site <site>`.

## FAQ

**I logged in successfully but the tool didn't detect it?**
Mafengwo and Qyer don't have a stable marker cookie, so the tool will ask you to press Enter after logging in. For Zhihu/Xiaohongshu/Bilibili, if auto-detection fails, wait a few seconds (the poll interval is 2 seconds) or rerun.

**Mafengwo still blocks me with a CAPTCHA after exporting cookies?**
Yes, that can happen — Mafengwo's slider CAPTCHA is independent of login state. PILOT will honestly report how many entries were blocked; you can choose to solve the slider manually and retry, or accept material from other sources instead.

**Worried about security?**
We recommend logging in with a secondary account and deleting `~/.pilot/cookies/` when you're done. The tooling is open source and auditable (`tools/cookies.ts`, `tools/lib/sites/cookies.ts`).
