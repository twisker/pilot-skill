# Configuration Reference: config/pilot.json

[中文](../zh/guide-config.md) | **English**

Config file location: `~/.pilot/app/config/pilot.json`. Tools resolve it relative to their own location; you can override with the `PILOT_CONFIG=<absolute-path>` environment variable (this applies to `search.ts` / `distill.ts` / `video.ts`).

Changes take effect immediately (tools read the file on every run) — no reinstall needed.

## Top-level fields

| Field | Default | Description |
|-------|---------|-------------|
| `topN` | `50` | Search candidate cap: total number of candidate entries `search.ts pick` selects across all sources' SERPs (overridable with `--top N` on the command line) |
| `keepN` | `5` | Curation retention count: how many travelogues `distill.ts index --keep N` keeps as itinerary template candidates; also the baseline for "structurable entries < keepN×2" triggering a low-yield disclosure |
| `maxFrames` | `20` | Frame sampling cap per video: the maximum number of frames `video.ts prep` extracts from a video travelogue for a sub-agent to understand |
| `locale` | `"zh"` | Language. V1 only supports `"zh"` |

## sources — search source routing table

```json
"sources": {
  "zh": {
    "travelogue": ["Mafengwo", "Qyer", "Ctrip guides"],
    "community":  ["Xiaohongshu", "Zhihu"],
    "video":      ["Bilibili"],
    "photo":      ["Tuchong", "500px"]
  },
  "en": {}
}
```

Grouped by locale, each group has four categories (`travelogue` for long-form travelogues, `community` for community posts, `video`, `photo` for photo galleries). `search.ts plan` generates query terms for each source from this table. Remove a source name to disable that source.

## query_templates — query term templates

```json
"query_templates": {
  "category_suffixes": {
    "travelogue": ["travelogue", "guide"],
    "community":  ["travelogue", "guide"],
    "video":      ["video guide", "travelogue"],
    "photo":      ["photo travelogue", "photo guide"]
  },
  "transport_keywords": {
    "self-drive": "self-drive",
    "public":     "public transit",
    "mixed":      ""
  }
}
```

- `category_suffixes`: the query suffix for each category. The final query looks like "`<destination> <transport-keyword> <suffix>`" (e.g. "Northern Xinjiang self-drive travelogue" in the original Chinese query terms)
- `transport_keywords`: maps the intake's `transport` value to a query keyword; `mixed` is an empty string, meaning no transport qualifier is added

## pick_quota — candidate quota

```json
"pick_quota": {
  "travelogue": 0.5,
  "community":  0.25,
  "video":      0.15,
  "photo":      0.1
}
```

The proportional quota (summing to 1.0) across the four categories when `search.ts pick` selects candidates. Long-form travelogues carry the highest information density, so they get half.

## preferred_domains — domain weighting

```json
"preferred_domains": {
  "you.ctrip.com": 3,
  "tuchong.com":   2
}
```

When `pick` ranks candidates, it up-weights domains with empirically higher fetch success rates (higher number = ranked higher). This is why Ctrip guides / Tuchong tend to show up near the top of the coverage report — that's expected, not a bug.

## scrape_domains / media_domains — fetch method routing

```json
"scrape_domains": ["mafengwo.cn", "zhihu.com", "ctrip.com", "xiaohongshu.com", "xhslink.com"],
"media_domains": {
  "video":     ["bilibili.com", "b23.tv"],
  "image-set": ["500px.com", "tuchong.com"]
}
```

- `scrape_domains`: entries on these domains go straight to the playwright fetch path (`method=scrape`) instead of trying WebFetch first (they're unfriendly to plain HTTP fetching)
- `media_domains`: maps domains to a media type, which determines an entry's `media_type_guess` (video entries go through the video pass; image-set entries get special short-text handling)

## map — map companion

```json
"map": {
  "tile_url": null
}
```

- `tile_url`: a custom basemap tile URL template. When `null`, PILOT uses Tianditu (requires `TIANDITU_KEY` in `~/.pilot/app/.env`). To switch to OSM or another raster source, provide a template like `https://.../{z}/{x}/{y}.png`

## Related environment variables (`.env` or shell environment)

| Variable | Default | Description |
|----------|---------|-------------|
| `TIANDITU_KEY` | none | Tianditu browser-side key (map basemap). Put it in `~/.pilot/app/.env` |
| `PILOT_HOME` | `~/.pilot` | Data home directory (parent of workspace / cookies / current-trip.json) |
| `PILOT_PORT` | `4870` | Local port for the map companion |
| `AMAP_KEY` | none | AMap web service key (optional geocoding fallback and GCJ-02 correction) |
| `PILOT_CONFIG` | `~/.pilot/app/config/pilot.json` | Override for the config file path |

See the `.env.example` at the repo root for the full template.
