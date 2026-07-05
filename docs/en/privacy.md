# Privacy Statement (Anonymous Statistics)

[中文](https://twisker.github.io/pilot-skill/zh/privacy.html) | **English**

PILOT ships with a set of **anonymous usage statistics** built to answer one question: are the recommendations and the product any good, and where do they fall short. This page spells out exactly what is collected, what is never collected, why, and how to turn it all off with one switch. There is a single governing principle: **statistics describe "what kind of thing happened," never "what you said or who you are."**

## Current status: nothing is uploaded by default

The reporting endpoint in the current release (`telemetry.endpoint` in `config/pilot.json`) is **`null`** — meaning **no data leaves your machine at all right now**. Events are only appended to a local queue file, `~/.pilot/telemetry-queue.jsonl`, which you can open or delete at any time.

If a future release enables reporting, this page will be updated in the same release to name the service provider and where the data lives. Until then, the rest of this page describes the full contract that will apply once enabled.

## What is collected

| Data | Details |
|------|---------|
| Anonymous install id | A random UUID generated locally on first run (stored in `~/.pilot/telemetry.json`); contains no identity information and is never linked to accounts, email addresses, or device fingerprints |
| Event counts (6-event whitelist) | `install` / `trip_created` / `export` (itinerary book exported) / `reco_impression` (a recommendation was shown) / `reco_dismissed` (a recommendation was declined) / `booking_link_shown` (a booking link was presented; short code only) |
| Coarse destination | `trip_created` carries the destination string (city/region level, e.g. "Xinjiang") and the trip's day count — nothing else |
| Export format | `export` carries the format name (pdf/xlsx/docx) |
| Product id and match score | `reco_impression` carries `product_id` and a match score; `reco_dismissed` carries `product_id` only. Both may additionally carry `scope` (`trip` = whole-trip recommendation / `item` = single-item recommendation) and `item_ref` (an itinerary-item locator of the form "day:item name" — nothing more, never conversation content) |

The whitelist is enforced in code (`tools/lib/telemetry.ts`): events and fields outside it are **silently dropped**, and every string is truncated to 200 characters — structurally ruling out conversation text or other large blobs. The server side (once enabled) enforces the same whitelist as a second filter.

## What is never collected

- **Conversation content**: nothing you say to PILOT, no itinerary contents, no reasons you gave for declining a recommendation;
- **Identity**: no names, no email addresses, no accounts, no device fingerprints;
- **Precise location**: no GPS or precise coordinates — destinations are city/region-level strings only;
- **Cookies and login state**: `~/.pilot/cookies/` is used on your machine only and never uploaded (see the [cookie guide](https://twisker.github.io/pilot-skill/en/guide-cookies.html));
- **Raw IP addresses**: client-side statistics contain no IP at all; once the server side is enabled, the link service keeps **only a salted hash** of visitor IPs (sha256 with a salt, truncated to 16 hex characters) — the raw IP value is never stored anywhere, and if no salt is configured, not even the hash is recorded.

## Why it is collected

For one purpose only: **improving recommendation quality and product decisions** — which recommendations get shown but declined, which export formats are used, how many installs exist. No advertising use; never sold, never shared with third parties.

## How to opt out (either method disables everything)

```bash
# Option 1: environment variable (add to your shell profile to make it permanent)
export PILOT_TELEMETRY=off

# Option 2: set "enabled": false in ~/.pilot/telemetry.json
```

Once disabled, every statistics call becomes a no-op: no events are generated, queued, or reported. To wipe historical queue entries, simply delete `~/.pilot/telemetry-queue.jsonl`.

## Data residency

As things stand: the reporting endpoint is not configured, so **all data stays on your machine** — there is nothing to reside anywhere else. If reporting is enabled in the future, this page will state the actual provider and data location for the deployed infrastructure (dual overseas/mainland endpoints), and the opt-out switch above will always remain a one-line exit.
