# PILOT Docs / PILOT 文档

[中文 ↓](#中文) | [English ↓](#english)

Repo home & install instructions: [github.com/twisker/pilot-skill](https://github.com/twisker/pilot-skill) — [README (English)](https://github.com/twisker/pilot-skill/blob/main/README.md) · [README（中文）](https://github.com/twisker/pilot-skill/blob/main/README.zh.md)

---

## 中文

**PILOT** 是一个 Claude Code Skill：对话式旅行路书设计工具。实时搜索全网真实游记 → 结构化精选 → 对话生成与编辑行程 → 冲突检查 → 导出 Excel / PDF / Word 三格式路书，另配浏览器地图伴侣视图。全程本地运行。

![PILOT 地图伴侣：新疆伊犁 9 日自驾全程连续路线](images/web-map.png)

> 上图为真实生成的「新疆伊犁 9 日亲子自驾」路书地图视图。更多界面与三格式导出截图见[快速上手教程](https://twisker.github.io/pilot-skill/zh/tutorial-quickstart.html)。

### 文档导览

| 文档 | 你想做什么 |
|------|-----------|
| [快速上手教程](https://twisker.github.io/pilot-skill/zh/tutorial-quickstart.html) | 从安装到导出第一份路书，完整走一遍（含预期终端输出） |
| [cookie 导出指南](https://twisker.github.io/pilot-skill/zh/guide-cookies.html) | 提升马蜂窝/知乎/穷游/小红书/B站的抓取成功率 |
| [配置参考](https://twisker.github.io/pilot-skill/zh/guide-config.html) | `config/pilot.json` 全字段说明（源路由 / 精选数量 / 地图等） |
| [路书导出说明](https://twisker.github.io/pilot-skill/zh/guide-export.html) | 四段结构、Excel 四 sheet、模板 sheet 用法 |
| [常见问题 FAQ](https://twisker.github.io/pilot-skill/zh/faq.html) | 抓取被拦 / 无 key 地图 / 如何更新 等 |
| [隐私声明](https://twisker.github.io/pilot-skill/zh/privacy.html) | 匿名统计收集什么/不收集什么/如何一键关闭（当前默认不上报） |

### 一分钟了解主链路

```
① 意图收集     对话问清目的地/日期/人群/预算/交通/偏好 → intake.json
② 搜索编排     多源搜索计划 → WebSearch → 挑选候选 → 抓取正文（playwright 兜底）
③ 结构化       每条游记一个子代理，整理为统一 travelogue JSON
④ 精选         校验 → 去重 → 机器打分 + 品味分 → 留前 5 条（含视频补充轮）
⑤ 行程生成     以最优游记为蓝本裁剪成逐日行程，对话编辑随改随查
⑥ 逐日细化     住宿/交通/餐饮/门票逐天补齐，坐标联网查证（不许凭记忆填）
⑦ 冲突检查     长途驾车/单日过密/预算超限/坐标距离异常等确定性规则
⑧ 导出         PDF → Excel → Word 三件套，落盘 ~/.pilot/workspace/<trip-id>/exports/
```

所有数据都在你的机器上：行程与素材在 `~/.pilot/workspace/`，程序安装在 `~/.pilot/app/`，cookie 在 `~/.pilot/cookies/`（绝不上传）。

### 快速命令速查

```bash
npx tsx ~/.pilot/app/tools/trip.ts current            # 查看当前行程指针
npx tsx ~/.pilot/app/tools/cookies.ts setup           # 引导式导出站点 cookie
npx tsx ~/.pilot/app/tools/cookies.ts status          # 各站 cookie 现状表
npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id>   # 手动启动地图伴侣
```

> 这些命令一般不需要手动敲——在 Claude Code 对话里 PILOT 会自己调用。它们在排查问题时有用。

---

## English

**PILOT** is a Claude Code Skill for conversational travel itinerary design. It searches real travelogues across the web in real time, structures and curates the best ones, drafts and edits a day-by-day itinerary through conversation, runs deterministic conflict checks, and exports a three-format itinerary book (Excel / PDF / Word), plus a read-only map companion in your browser. Runs entirely on your own machine.

![PILOT map companion: a 9-day Yili self-drive route](images/web-map.png)

> Above: the map view of a real generated "9-day family self-drive around Yili, Xinjiang" itinerary. More UI and three-format export screenshots are in the [quickstart tutorial](https://twisker.github.io/pilot-skill/en/tutorial-quickstart.html).

### Documentation

| Doc | What it's for |
|-----|----------------|
| [Quickstart tutorial](https://twisker.github.io/pilot-skill/en/tutorial-quickstart.html) | Install to exporting your first itinerary book, start to finish (with expected terminal output) |
| [Cookie export guide](https://twisker.github.io/pilot-skill/en/guide-cookies.html) | Improve scraping success on Mafengwo / Zhihu / Qyer / Xiaohongshu / Bilibili |
| [Configuration reference](https://twisker.github.io/pilot-skill/en/guide-config.html) | Every field in `config/pilot.json` (source routing / curation count / map, etc.) |
| [Itinerary export guide](https://twisker.github.io/pilot-skill/en/guide-export.html) | The four-section structure, Excel's 4 sheets, and how to use the template sheets |
| [FAQ](https://twisker.github.io/pilot-skill/en/faq.html) | Scraping blocked / no map key / how to update, and more |
| [Privacy statement](https://twisker.github.io/pilot-skill/en/privacy.html) | What the anonymous statistics collect / never collect / one-switch opt-out (no uploading by default) |

### The main flow in one minute

```
1. Intake            Conversation clarifies destination/dates/group/budget/
                      transport/preferences -> intake.json
2. Search planning    Multi-source search plan -> WebSearch -> pick candidates
                      -> fetch full text (playwright fallback)
3. Structuring        One sub-agent per travelogue, normalized into a shared
                      travelogue JSON schema
4. Curation           Validate -> dedupe -> machine score + taste score
                      -> keep the top 5 (with a video supplement pass)
5. Itinerary draft     Trim the best travelogue into a day-by-day itinerary;
                      conversational edits are validated as you make them
6. Day-by-day detail   Fill in lodging/transport/meals/tickets per day;
                      coordinates verified online (never from memory)
7. Conflict check      Deterministic rules: long drives, overpacked days,
                      over-budget totals, anomalous coordinate distances
8. Export              PDF -> Excel -> Word, saved to
                      ~/.pilot/workspace/<trip-id>/exports/
```

All data stays on your machine: trips and material in `~/.pilot/workspace/`, the program installed at `~/.pilot/app/`, cookies in `~/.pilot/cookies/` (never uploaded).

### Quick command reference

```bash
npx tsx ~/.pilot/app/tools/trip.ts current            # show the current trip pointer
npx tsx ~/.pilot/app/tools/cookies.ts setup           # guided site-cookie export
npx tsx ~/.pilot/app/tools/cookies.ts status          # per-site cookie status table
npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id>   # start the map companion manually
```

> You usually won't need to type these by hand — PILOT calls them for you during the conversation. They're useful when troubleshooting.
