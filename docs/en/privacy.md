# Privacy Statement (Anonymous Statistics)

[中文](https://twisker.github.io/pilot-skill/zh/privacy.html) | **English**

PILOT ships with a set of **anonymous usage statistics** built to answer one question: is anyone actually using this project, and which parts of it get used. This page spells out exactly what is collected, what is never collected, where the data lives, and how to turn it all off with one switch. There is a single governing principle: **statistics describe "what kind of thing happened," never "what you said or who you are."**

## Current status: reporting is enabled

Since v5.0 (2026-09-24, when the project became entirely free), the reporting endpoint in released versions is the **PILOT counting service running on Alibaba Cloud Function Compute (FC)**, so events do leave your machine. Data is stored **in mainland China** (Alibaba Cloud, Hangzhou region). This page describes the contract that is in effect today.

## What is collected

The client (`tools/lib/telemetry.ts`) generates only the following:

| Data | Details |
|------|---------|
| Anonymous install id `install_id` | A random UUID generated locally on first run (stored in `~/.pilot/telemetry.json`). Its **only purpose is de-duplication** — one install counts once no matter how many times it reports. It contains no identity information and is never linked to accounts, email addresses, or device fingerprints |
| Event counts (**3-event** whitelist) | `install` / `trip_created` / `export` (itinerary book exported). As of 2026-09-24 the project is entirely free, and the former recommendation events (`reco_impression` / `reco_dismissed` / `booking_link_shown`) were removed together with the commercial code — **they are no longer collected** |
| Coarse destination | `trip_created` carries the destination string (city/region level, e.g. "Xinjiang") and the trip's day count — nothing else |
| Export format | `export` carries the format name (pdf/xlsx/docx) |

The whitelist is enforced in code: events and fields outside it are **silently dropped**, and every string is truncated to 200 characters — structurally ruling out conversation text or other large blobs. The server side enforces the **same** whitelist as a second filter.

Reporting is an HTTPS POST to the counting endpoint whose body contains only the `install_id` and the queued events. Any network request necessarily reveals the source IP to the other side, so how the server treats IPs is described separately below.

## What the server stores

The counting service writes three tables of **aggregated data only** — there is no per-event behavioural detail:

| Table | Fields stored | Purpose |
|------|------|------|
| `installs` | first 32 hex chars of `sha256(install_id)` (one-way; the original cannot be recovered), first day seen, last day seen | independent install count, activity |
| `counts` | day, event name, number of occurrences that day | event trends. **No per-event timestamps are retained** |
| `ip_guard` | day, first 16 hex chars of `sha256(daily salt + IP)`, requests that day | **rate limiting only** |

The full story on IP addresses:

- **The raw IP is never stored**, and never written to logs;
- The "daily salt" is `sha256(root secret + date)`. The root secret lives only in a server-side environment variable and is never distributed or committed; it is **rotated automatically every day**, so the same IP produces a different hash on different dates and no cross-day trail can be assembled from `ip_guard`;
- If the root secret is not configured server-side, **not even the IP hash is recorded** (and no rate limiting happens);
- Country/region code: recorded only when the edge node supplies it; the current Alibaba Cloud FC deployment does not, so that field stays empty.

## What is never collected

- **Conversation content**: nothing you say to PILOT, no itinerary contents, no reasons you gave for editing or declining something;
- **Identity**: no names, no email addresses, no accounts, no device or browser fingerprints;
- **Precise location**: no GPS or precise coordinates — destinations are city/region-level strings only;
- **Cookies and login state**: `~/.pilot/cookies/` is used on your machine only and never uploaded (see the [cookie guide](https://twisker.github.io/pilot-skill/en/guide-cookies.html));
- **Raw IP addresses**: client-side reporting carries no IP; the server keeps only the daily-salted hash described above, which is not used for counting and is never linked to an `install_id`.

## Why it is collected

For one purpose only: **knowing how many people download, install and use PILOT**, and which export formats get used — to judge whether the project has real users and where to spend effort. No advertising use, no profiling, never sold, never shared with third parties.

## How to opt out (either method disables everything)

```bash
# Option 1: environment variable (add to your shell profile to make it permanent)
export PILOT_TELEMETRY=off

# Option 2: set "enabled": false in ~/.pilot/telemetry.json
```

Once disabled, every statistics call becomes a no-op: no events are generated, queued, or reported.

**What is left on your machine**: `~/.pilot/telemetry.json` (the `install_id` and the on/off flag) and `~/.pilot/telemetry-queue.jsonl` (events not yet sent, capped at 1000). You can open or delete both at any time.

## Deleting data that was already reported

Your `install_id` is in `~/.pilot/telemetry.json` on your own machine. Open an issue at [GitHub Issues](https://github.com/twisker/pilot-skill/issues) with it and we will delete the corresponding install record. Beyond that, the only stored data is daily aggregate counts (`counts`) and the same-day IP hash used for rate limiting (`ip_guard`) — neither contains anything that can identify a person.

## Data residency

Alibaba Cloud Function Compute (FC) plus Alibaba Cloud RDS for PostgreSQL, in the **Hangzhou region of mainland China (cn-hangzhou)**. No data leaves the country.
