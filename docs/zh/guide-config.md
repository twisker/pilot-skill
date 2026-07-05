# 配置参考：config/pilot.json

**中文** | [English](../en/guide-config.md)

配置文件位置：`~/.pilot/app/config/pilot.json`。工具按「相对自身位置」解析该文件，也可用环境变量 `PILOT_CONFIG=<绝对路径>` 覆盖（对 `search.ts` / `distill.ts` / `video.ts` 生效）。

改完即生效（工具每次运行时读取），无需重装。

## 顶层字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `topN` | `50` | 搜索候选上限：`search.ts pick` 从各源 serp 中挑出的候选条目总数（可被命令行 `--top N` 覆盖） |
| `keepN` | `5` | 精选保留数：`distill.ts index --keep N` 最终留给行程蓝本候选的游记条数；也是「可结构化条目 < keepN×2 时触发低产话术」的基准 |
| `maxFrames` | `20` | 视频抽帧上限：`video.ts prep` 每条视频最多抽多少帧给子代理理解 |
| `locale` | `"zh"` | 语言。V1 仅支持 `"zh"` |

## sources —— 搜索源路由表

```json
"sources": {
  "zh": {
    "travelogue": ["马蜂窝", "穷游", "携程攻略"],
    "community":  ["小红书", "知乎"],
    "video":      ["B站"],
    "photo":      ["图虫", "500px"]
  },
  "en": {}
}
```

按 locale 分组，每组四个类目（travelogue 长文游记 / community 社区帖 / video 视频 / photo 摄影图集）。`search.ts plan` 按这张表为每个源生成查询词。删掉某个源名即可禁用该源。

## query_templates —— 查询词模板

```json
"query_templates": {
  "category_suffixes": {
    "travelogue": ["游记", "攻略"],
    "community":  ["游记", "攻略"],
    "video":      ["视频攻略", "游记"],
    "photo":      ["摄影游记", "照片攻略"]
  },
  "transport_keywords": {
    "self-drive": "自驾",
    "public":     "公共交通",
    "mixed":      ""
  }
}
```

- `category_suffixes`：每个类目的查询词后缀。最终查询词形如「`<目的地> <交通词> <后缀>`」（如「新疆北疆 自驾 游记」）
- `transport_keywords`：intake 的 transport 值到查询词的映射；`mixed` 为空串表示不加交通限定词

## pick_quota —— 候选配额

```json
"pick_quota": {
  "travelogue": 0.5,
  "community":  0.25,
  "video":      0.15,
  "photo":      0.1
}
```

`search.ts pick` 挑候选时四类目的比例配额（合计 1.0）。长文游记信息密度最高所以占一半。

## preferred_domains —— 域名加权

```json
"preferred_domains": {
  "you.ctrip.com": 3,
  "tuchong.com":   2
}
```

pick 排序时对实证抓取成功率更高的域名加权（数值越大越靠前）。这解释了为什么覆盖率汇报中携程攻略/图虫往往靠前——是预期内行为。

## scrape_domains / media_domains —— 抓取方式路由

```json
"scrape_domains": ["mafengwo.cn", "zhihu.com", "ctrip.com", "xiaohongshu.com", "xhslink.com"],
"media_domains": {
  "video":     ["bilibili.com", "b23.tv"],
  "image-set": ["500px.com", "tuchong.com"]
}
```

- `scrape_domains`：这些域名的条目直接走 playwright 抓取（`method=scrape`），不先尝试 WebFetch（它们对普通 HTTP 抓取不友好）
- `media_domains`：域名到媒体类型的映射，决定条目的 `media_type_guess`（video 走视频轮，image-set 有特殊的短文本判定）

## map —— 地图伴侣

```json
"map": {
  "tile_url": null
}
```

- `tile_url`：自定义底图瓦片 URL 模板。`null` 时使用天地图（需要 `~/.pilot/app/.env` 里的 `TIANDITU_KEY`）。想换 OSM 等其他栅格源可填形如 `https://.../{z}/{x}/{y}.png` 的模板

## 相关环境变量（.env 或 shell 环境）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TIANDITU_KEY` | 无 | 天地图浏览器端 key（地图底图）。放 `~/.pilot/app/.env` |
| `PILOT_HOME` | `~/.pilot` | 数据主目录（workspace / cookies / current-trip.json 的父目录） |
| `PILOT_PORT` | `4870` | 地图伴侣本地端口 |
| `AMAP_KEY` | 无 | 高德 Web 服务 key（可选 geocoding 兜底与 GCJ-02 纠偏） |
| `PILOT_CONFIG` | `~/.pilot/app/config/pilot.json` | 配置文件路径覆盖 |

完整模板见仓库根的 `.env.example`。
