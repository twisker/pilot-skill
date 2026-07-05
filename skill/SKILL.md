---
name: pilot
description: PILOT —— 对话式旅行路书设计。用户想规划旅行、生成路书、设计行程、自驾游规划时使用。触发词：旅行、路书、行程、自驾、trip、itinerary、travel plan。
---

# PILOT v4 —— 实时搜索 · 对话式旅行路书

> 主链路：对话收集需求 → 实时搜索全网游记 → 结构化整理 → 精选蓝本 → 生成行程 → 对话编辑 → 逐日细化 → 冲突检查 → 三格式导出。
> 本文件是产品本身；`tools/` 下的 CLI 只是它的手脚。所有产物落盘 workspace，**文件即 API**。

---

## 0. 总则（先读，贯穿全程）

### 0.1 工作目录与 workspace

- 所有 `npx tsx ~/.pilot/app/tools/...` 命令使用安装位绝对路径（发行版安装于 `~/.pilot/app`），可在任意目录执行。
- 数据全部落盘：

```
~/.pilot/workspace/<trip-id>/
  intake.json        # ① 用户画像（shared/schema/intake.schema.json）
  search-plan.json   # ② 搜索计划与每源状态（search-plan.schema.json）
  raw/               # ② 抓取原文：serp-*.json、<sha1>.html/.txt/.meta.json、video-<sha1>/
  travelogues/       # ③④ 结构化游记 <id>.json + index.json（travelogue.schema.json）
  itinerary.json     # ⑤⑥ 行程（itinerary.schema.json）
  exports/           # ⑧ 路书产物
~/.pilot/current-trip.json   # session 指针（⑨）
```

### 0.2 Context 纪律（硬规则，违反必然撑爆会话）

- **MUST NOT** 在主会话中 Read `raw/*.txt`、`raw/*.html`、`raw/video-*/frame-*.jpg`、字幕或任何抓取原文。50 条原文累积必然超出 context 上限。
- **MUST** 用 **subagent-per-travelogue** 做结构化：每条待结构化的 pick 条目派**一个** Task 子代理，子代理读原文、生成 travelogue JSON、落盘；主会话只接收「id + 成功/失败」两项，**不接收正文，不接收 JSON 全文**（见 ③）。
- 主会话读取游记信息的唯一入口是 `travelogues/index.json`（精选摘要，distill index 产出）。
- 例外（按条读取）：⑤ 行程生成时允许读取**精选后（≤5 条）**的单条 travelogue JSON 的 `route` 字段（用 0.5 节的字段提取命令，不整读文件）；④ taste 评分时只读 `summary.brief` 等摘要字段。
- 工具 stdout 是统计 JSON（几十字节），可自由读取。

### 0.3 错误降级总则

- 任何工具 **exit 1** 时 stderr 输出 `{"error":"<原因>"}`：读取该 JSON，用平实中文向用户解释发生了什么，并给出可选项（重试 / 跳过 / 换路子），**不要静默吞掉，也不要擅自决定放弃某环节**。
- 任何**单源 / 单条 URL** 失败不阻塞主链路：记录状态，继续其余条目。
- 全链路降级链：`WebSearch（免费）→ WebFetch 直读 → scrape.ts playwright 兜底 → summary-only 增补（低产兜底，②.6）→ 标记 partial/failed 继续 → 覆盖率如实汇报（⑩）`。
- 工期紧砍刀顺序：**视频理解（第一位，先降 --meta-only 再整体砍）→ Web UI → Excel/Word（保 PDF）**。

### 0.4 预留字段（V1 不启用）

- `itinerary.json` 的 `agency_recommendation` 与各条目 `booking.affiliate_url` / `booking.alt_recommendation` **V1 恒填 null**。
- V1 **不向用户展示**旅行社产品推荐位；`booking.url` 只填普通直链（官网/官方预订页）。

### 0.5 常用小命令（原样复制使用）

计算 URL 的 sha1（raw 产物命名用）：

```bash
node -e 'console.log(require("crypto").createHash("sha1").update(process.argv[1]).digest("hex"))' '<URL>'
```

读取 travelogue 摘要字段（不装载全文）：

```bash
node -e 'const t=require(process.argv[1]);console.log(JSON.stringify({id:t.id,brief:t.summary.brief,tags:t.summary.tags,platform:t.meta.source.platform,fetch_quality:t.meta.fetch_quality,url:t.meta.source.url}))' ~/.pilot/workspace/<trip-id>/travelogues/<id>.json
```

读取 travelogue 的 route（⑤ 行程生成专用，仅限精选 ≤5 条）：

```bash
node -e 'const t=require(process.argv[1]);console.log(JSON.stringify(t.route))' ~/.pilot/workspace/<trip-id>/travelogues/<id>.json
```

---

## 启动流程

1. **Session 恢复检查**（详见 ⑨）：

   ```bash
   npx tsx ~/.pilot/app/tools/trip.ts current
   ```

   - `trip_id` 非 null 且该 trip 未完成 → 问用户：「上次你在做「{trip_id}」，要**继续上次**还是**新开一个**？」
   - `trip_id` 为 null 或用户选新开 → 进入 ①。
2. 用户 `/pilot <需求>` 带了需求描述 → 把描述作为 ① 的对话起点；没带 → 直接开始 ① 的提问。

---

## ① 意图收集（对话 → intake.json）

### 1.1 对话收集

用自然对话收集以下字段（**字段与 `shared/schema/intake.schema.json` 一一对齐**，全部 required 除 budget_cny 可 null）：

| 字段 | 问法示例 | 格式 |
|------|---------|------|
| destination | 去哪儿？ | 字符串，如「新疆北疆」 |
| dates.start / dates.end | 几号出发、几号回？ | `YYYY-MM-DD`；用户只说「8天」则和用户确认具体起止日期 |
| party | 几个人？有小孩或老人吗？ | `{adults, children, seniors}` 整数；「带父母」→ seniors 计 2 |
| budget_cny | 总预算大概多少？ | 整数或 null（用户不想说就 null，不追问第二次） |
| transport | 自驾还是公共交通？ | `"self-drive"` / `"public"` / `"mixed"` |
| preferences | 有什么偏好？（摄影/亲子/徒步/美食…） | 字符串数组，可为空数组 |
| origin_city | 从哪个城市出发？ | 字符串 |
| locale | （不用问） | 固定 `"zh"`（V1 仅中文） |

原则：用户一句话给全了就不逐条问；缺什么问什么，一轮最多问 3 个问题，别像填表。

### 1.2 创建 trip 并落盘

1. 用目的地拼一个 slug（小写字母/数字/连字符，如 `xinjiang-selfdrive`）：

   ```bash
   npx tsx ~/.pilot/app/tools/trip.ts new <slug>
   ```

   stdout 返回 `{"trip_id":"<slug>-<yyyymmdd>","path":"..."}`。后续所有 `--trip` 参数用这个 trip_id。
2. 用 Write 工具把 intake 写到 `~/.pilot/workspace/<trip-id>/intake.json`，`trip_id` 字段 = 上一步返回的 trip_id。
3. 向用户复述一遍画像（一段话），确认无误再进 ②；有误就改写 intake.json。

### 1.3 启动本地 UI

```bash
npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id> --port 4870 &
open http://localhost:4870
```

server（后台运行，`&` 放到后台不阻塞对话）监听 workspace 变化（chokidar 盯 trip 目录顶层
`*.json` 与 `travelogues/`），SSE 推送到浏览器只读页面，三视图：时间线 / 地图（MapLibre +
天地图栅格底图，需 `~/.pilot/app/.env` 配置 `TIANDITU_KEY`，缺 key 或行程内条目暂无 `geo` 时页面
显示引导文案而非报错）/ 参考游记卡片墙。V1 全量重渲染，不做局部 diff。
**server 未实现或启动失败时**：告知用户「本次没有网页视图，全程用终端对话」，不阻塞主链路。

---

## ② 搜索编排（plan → WebSearch → register → pick → WebFetch → scrape 兜底）

### 2.1 生成搜索计划

```bash
npx tsx ~/.pilot/app/tools/search.ts plan --trip <trip-id>
```

产出 `search-plan.json`：每个源（马蜂窝/穷游/携程攻略/小红书/知乎/B站/图虫/500px，见 `config/pilot.json` 的 `sources.zh`）一组查询词。

### 2.2 逐源执行 WebSearch 并落盘 serp

对 `search-plan.json` 里**每个源**：

1. 用 **WebSearch 工具**依次执行该源的每条 `queries`，并传 `allowed_domains` 限定到该源的域名（如马蜂窝→`mafengwo.cn`，知乎→`zhihu.com`，穷游→`qyer.com`，携程攻略→`ctrip.com`，小红书→`xiaohongshu.com`/`xhslink.com`，B站→`bilibili.com`/`b23.tv`，图虫→`tuchong.com`，500px→`500px.com`）。**实证（2026-07-05 内部验证）**：不加 `allowed_domains` 时结果域名混杂（如搜"马蜂窝"查询词却大量返回携程/知乎/CSDN 链接），会污染该源的 serp 归属，必须限定域名才能拿到真正该源的结果。
2. 汇总该源所有结果为数组 `[{"title":"...","url":"...","snippet":"..."}]`（三字段均必填字符串；snippet 缺失就填空串），用 Write 落盘到**暂存文件**：
   `~/.pilot/workspace/<trip-id>/raw/serp-<源名>.pending.json`
3. 登记（工具做 ajv 校验 + URL 归一化 + 去重合并到正式的 `raw/serp-<源名>.json`）：

   ```bash
   npx tsx ~/.pilot/app/tools/search.ts register --trip <trip-id> --source <源名> --file ~/.pilot/workspace/<trip-id>/raw/serp-<源名>.pending.json
   ```

   - **exit 1 且报「非法条目下标：i,j」** → 回到暂存文件修掉对应下标的条目（补齐字段 / 删掉非法 URL 条目），重新 register。最多重试 2 次，仍失败则跳过该源并记入 ⑩ 汇报。
   - `--source` 必须与 search-plan 中的 `name` 逐字一致（如 `马蜂窝`）。
4. 某源 WebSearch 全部查询词都无结果 → 不落盘不 register，直接继续下一个源（该源在 plan 里保持 pending，⑩ 中如实汇报）。

### 2.3 挑选候选

```bash
npx tsx ~/.pilot/app/tools/search.ts pick --trip <trip-id>
```

产出 `raw/pick.json`（topN 默认 50，可 `--top <N>` 覆盖）：每条 `{url, source, media_type_guess, method: webfetch|scrape, status: pending}`。

### 2.4 WebFetch 直读（method=webfetch 的文字条目）

读取 `raw/pick.json`，对 **`method="webfetch"` 且 `status="pending"` 且 `media_type_guess≠"video"`** 的条目逐个处理（视频条目留到 ④ 的视频轮，**不要 WebFetch 视频页**）：

1. 用 **WebFetch 工具**读该 URL，prompt 要求「提取页面正文全文（游记内容），保留逐日结构与地名，去掉导航/评论/推荐位」。
2. **成功**（拿到正文）：
   - 用 0.5 节命令算该 URL 的 sha1；
   - 正文用 Write 落盘 `raw/<sha1>.txt`；
   - 写 `raw/<sha1>.meta.json`：`{"url":"<URL>","fetched_at":"<ISO时间>","status":"full","title":"<标题>"}`（正文 <500 字时 `status` 填 `"partial"`）；
   - 把 pick.json 中该条 `status` 改为 `"fetched"`（用 Edit 精确改这一条，每条处理完立即回写，别攒批）。
3. **失败**（超时 / 反爬页 / 拿到的明显不是正文）：把该条 `status` 改为 `"fetch_failed"`，不写 meta，交给 2.5 兜底。
4. **特殊处理**：`media_type_guess="image-set"` 的条目（图虫/500px 相册页）WebFetch 后若结果 <200 字，直接标记 `status="fetch_failed"`，交 scrape 兜底或放弃，不强行结构化。

### 2.5 scrape 兜底

```bash
npx tsx ~/.pilot/app/tools/scrape.ts run --trip <trip-id>
```

工具自动处理 `method="scrape"` 或 `status="fetch_failed"` 的条目（playwright，含马蜂窝分页拼接、xhs cookie 门控），产出 `raw/<sha1>.html/.txt/.meta.json` 并逐条回写 pick.json（成功 `scraped` / 失败 `failed`）。**单条失败不中断、整体 exit 0**；只有 trip 级错误才 exit 1（按 0.3 处理）。

> **抓取现实（实证，勿抱幻想）**：马蜂窝有腾讯滑块验证码 WAF，playwright 也可能被拦（meta 里是 48 字验证码文案、status=partial）；小红书无 cookie 直接判 failed（reason: no-cookie）。**首选源可能大面积失败，这是常态**，处理方式见 ⑩，绝不假装数据充足。

### 2.6 summary-only 增补

scrape 全部跑完后，若「`fetched + scraped`」条目数 < `keepN×2`（`config.keepN` 默认 5，即 <10 条），先对 `status="failed"` 的条目里能救的做一轮降级增补，再走 2.7 的低产话术——增补是为了把可结构化素材尽量拉到能继续的水平，不是取代如实汇报。

1. 从 `raw/pick.json` 挑 `status="failed"` 且对应 `raw/serp-<源>.json` 里该 URL 的 `snippet` 长度 **≥80 字**的条目（snippet 太短的没有信息量，不值得增补，直接放弃）。
2. 对每条命中的，派一个 Task 子代理（沿用 ③ 的 subagent-per-travelogue 规则，可与 ③ 的结构化子代理一起并行派发），prompt 要求「**只依据这个标题与摘要片段生成一条结构化 travelogue，不许编造 snippet 未提及的细节**」：
   - `meta.fetch_quality: "summary-only"`
   - `summary.brief`：由 snippet 改写压缩为 ≤200 字，不得添加 snippet 未提及的信息
   - `route.days`：`travelogue.schema.json` 对 `route.days` **没有 `minItems` 限制**，**允许写为空数组 `[]`**（snippet 一般没有逐日结构，宁可留空也不许编造）；只有 snippet 明确提到具体地名/天数时才粗略整理为单日（`day:1`，`pois` 按 snippet 提到的地名列，`transport` 留空字符串 `""`）——**默认选空数组方案**，不确定就别编。
   - `quality.deterministic` 四项先填 0（占位，distill.ts score 后续会覆盖，但 summary-only 条目天然信息密度低，预期打分也低）。
3. `raw/pick.json` 中该条目的 `status` **保持 `"failed"`**（抓取本身确实失败了）——增补出的 travelogue 是独立记录，不回写为 `scraped`，避免和真实抓取成功混淆口径。
4. 增补产出的 travelogue 落盘到 `travelogues/<sha1前12位>.json`（id 规则与 ③ 一致），随后正常进入 ④ 的校验/去重/评分/索引流程，与全文抓取的 travelogue 一视同仁地竞争精选名额。
5. ⑩ 汇报覆盖率时，增补条目**单独计数**（「可用于结构化的游记：8 条（含 summary-only 增补 3 条）」），不得混入「抓取成功」口径。

**用途边界**：仅用于缓解「可结构化条目 <10」的低产状况，不是常规路径——能全文抓到就不用增补；增补比例过高（超过一半）应如实告诉用户素材质量偏低。

### 2.7 阶段小结

统计 pick.json：`fetched + scraped` 为可结构化条目，加上 2.6 增补出的 summary-only 条目数为**可用于结构化的总条目**。**可用于结构化的总条目 <10**时先执行 ⑩ 的低产话术（给用户选项），用户选择继续才进 ③。

---

## ③ 结构化（MUST：subagent-per-travelogue）

### 3.1 硬规则

- 对每条 `status ∈ {fetched, scraped}` 的 pick 条目，**派一个 Task 子代理**（general-purpose，后台并行可以，但同时在飞的子代理别超过 5 个）。
- **MUST NOT** 在主会话读 `raw/<sha1>.txt`。主会话只收集每个子代理返回的「id + 成功/失败」。
- travelogue 的 `id` = 该 URL sha1 的**前 12 位**（与 raw 文件同源，便于对账）。

### 3.2 子代理 prompt 模板（逐条替换 <占位符> 后使用）

```
你在为 PILOT 结构化一条游记。只做这一条，做完立刻返回。

1. Read /Users/<你的用户名>/.pilot/workspace/<trip-id>/raw/<sha1>.txt（正文）与 raw/<sha1>.meta.json（标题/URL/抓取质量）。
2. Read ~/.pilot/app/shared/schema/travelogue.schema.json，严格按 schema 生成 JSON：
   - id: "<sha1前12位>"
   - meta.title/author：从正文与 meta 提取，author 找不到填 "佚名"
   - meta.source: {url: "<URL>", platform: "<源名>", media_type: "text"}
   - meta.published_at: 正文可考则填 YYYY-MM-DD，否则 null
   - meta.fetch_quality: meta.json 的 status 为 full→"full"，partial→"partial"
   - summary.brief: ≤200 字中文简介（写给要选路线的旅行者看：路线走向、亮点、适合谁）
   - summary.tags: 特征标签数组（自驾/亲子/摄影/徒步/美食…）
   - route.days: 逐日整理，每天 {day, pois:[{name,kind(sight|meal|hotel|transit),note}], transport, stay}；
     正文没有逐日结构就按叙述顺序尽力分天，实在分不出就单天装全部 POI
   - quality.deterministic: {completeness:0, granularity:0, media_richness:0, freshness:0}（占位，后续工具计算覆盖）
   - quality.taste_score: null；quality.total: null
3. Write 到 /Users/<你的用户名>/.pilot/workspace/<trip-id>/travelogues/<sha1前12位>.json
4. 只返回一行：「<sha1前12位> 成功」或「<sha1前12位> 失败：<一句话原因>」。不要粘贴正文或 JSON 内容。
```

正文是验证码文案 / 完全无旅行内容时，子代理应返回失败；主会话把该 pick 条目改为 `"failed"`。

### 3.3 汇总

全部子代理返回后，向用户报一行进度：「结构化完成：成功 X 条 / 失败 Y 条」，进 ④。

---

## ④ 精选（distill → taste_score → index → 展示）

### 4.1 校验、去重、确定性评分

```bash
npx tsx ~/.pilot/app/tools/distill.ts validate --trip <trip-id>
npx tsx ~/.pilot/app/tools/distill.ts dedupe --trip <trip-id>
npx tsx ~/.pilot/app/tools/distill.ts score --trip <trip-id>
```

- validate：非法 travelogue 改名 `.invalid` 并报告（向用户提一句即可，不逐条解释）。
- dedupe：路线指纹相似度 ≥0.75 判重，留分高者。
- score：写回每条的 `quality.deterministic` 四项。

### 4.2 taste_score（Skill 评品味分，score 之后、index 之前）

对 `travelogues/` 下每条存活的 travelogue：

1. 用 0.5 节的「读取摘要字段」命令读 `brief/tags/platform/fetch_quality`（**只读摘要，不读全文**）。
2. 按三个维度评 **0-10 品味分**：**文风可信度**（像真实走过的人写的，有具体时间地点花费，不是营销文）、**实用细节密度**（路况/预订/避坑等可执行信息量）、**与用户偏好契合**（对照 intake.preferences 与人群）。
3. 写回：

   ```bash
   node -e 'const fs=require("fs");const p=process.argv[1];const s=Number(process.argv[2]);const t=JSON.parse(fs.readFileSync(p,"utf-8"));t.quality.taste_score=s;fs.writeFileSync(p,JSON.stringify(t,null,2));' ~/.pilot/workspace/<trip-id>/travelogues/<id>.json <分数>
   ```

### 4.3 索引（精选前 5）

```bash
npx tsx ~/.pilot/app/tools/distill.ts index --trip <trip-id> --keep 5
```

产出 `travelogues/index.json`（id/brief/tags/total/url/days_count）——**这是主会话此后唯一读取的游记摘要文件**。

### 4.4 视频补充轮（仅文字源精选完成后；砍刀第一位）

1. 从 `raw/pick.json` 取 `media_type_guess="video"` 且 `status="pending"` 的条目，按文件内顺序（已按相关度排序）取**前 3 条**（K=3）。
2. 逐条预处理（yt-dlp 下载 + ffmpeg 抽帧，帧数上限 20 进 config）：

   ```bash
   npx tsx ~/.pilot/app/tools/video.ts prep --url <视频URL> --trip <trip-id> --max-frames 20
   ```

   产出 `raw/video-<sha1>/frame-*.jpg` + `manifest.json`。exit 1 报缺 yt-dlp/ffmpeg 时，把安装指引转告用户（`brew install yt-dlp ffmpeg`），用户不装则本轮跳过。
3. 每条视频同样派**一个子代理**：Read manifest.json + 逐帧 Read 图片 → 按 3.2 同规则生成 travelogue（`media_type:"video"`，`fetch_quality` 按 manifest 信息定）→ 落盘 → 只回 id+状态。主会话**不看帧**。
4. 成功后把该 pick 条目 `status` 改 `"scraped"`，失败改 `"failed"`。
5. 有新增 travelogue 时**重跑 4.1 → 4.2（只评新条目）→ 4.3**合并精选。
6. **降级**：工期紧或下载失败 → `npx tsx ~/.pilot/app/tools/video.ts prep --url <视频URL> --trip <trip-id> --meta-only`（只取标题/简介，fetch_quality=summary-only）；再不行整体放弃视频轮，向用户说明。

### 4.5 展示精选

Read `travelogues/index.json`，向用户展示 5 条：每条「标题式一句话 + brief + 标签 + 评分 + **天数（`days_count` 条，如「共 6 天」；`days_count=0` 标注「仅地点清单，无逐日行程」）** + 原文链接」，并说明蓝本候选（见 ⑤ 5.1 的选择规则），用户可改选。
（旅行社产品推荐位：V1 不展示，见 0.4。）

---

## ⑤ 行程生成与对话编辑

### 5.1 生成初稿

1. **蓝本选择规则（2026-07-05 主控裁定）**：蓝本 = index 中排名最高**且 `days_count ≥ 2`** 的条目（`days_count < 2` 的条目，如图虫/500px 地点清单类游记，没有逐日结构，不能拆分成行程骨架，即使总分高也不得作为蓝本）。
   - index 全部条目 `days_count < 2` 时：如实告知用户「本次精选素材都缺少逐日行程结构，蓝本质量会打折扣」，取 `days_count` 最大者（并列取排名靠前者）作为蓝本继续。
   - 用户可从展示的 5 条中改选，改选时同样提示所选条目的 `days_count`；改选 `days_count < 2` 的条目需再次确认用户知情。
   用 0.5 节命令**只读蓝本的 `route`**。
2. 结合 intake（起止日期/天数/人群/交通/预算）裁剪生成 `itinerary.json`（Write 落盘），严格按 `shared/schema/itinerary.schema.json`：
   - `status: "draft"`、`base_travelogue: "<蓝本id>"`、`agency_recommendation: null`
   - 每天 `{day, date, source_ref: {travelogue_id, day}, items}`；date 从 intake.dates.start 顺推
   - item：`{time, kind, name, note, geo: null, cost_cny: null, booking: null}`——**此阶段 geo 一律 null**（坐标只能在 ⑥ 查证后填）
3. **每次写 itinerary.json 后 MUST 立即校验，通过才能继续**：

   ```bash
   npx tsx ~/.pilot/app/tools/check.ts validate --trip <trip-id>
   ```

   校验失败 → 按报错修 JSON → 重跑，直到通过。这条规则对**本文件所有写 itinerary.json 的场景**（初稿/编辑/细化）无一例外。
4. 跑一次冲突检查（⑦），连同行程概览一起呈现给用户。

### 5.2 对话编辑（source_ref 记账）

用户会说「第 3 天换成 2 号线路的安排」「加一天禾木」这类话：

- 跨游记拼接：用 0.5 节命令读**目标游记（必须在精选 5 条内）**对应天的 route，转换为 items 替换/插入；该天 `source_ref` 改为 `{travelogue_id: <目标游记id>, day: <其第几天>}`。
- 自行新增/用户口述的天：`source_ref: null`。
- 每轮编辑后：**check validate（MUST）→ check run（⑦）→ 展示被改动的那几天**。
- 用户表示整体满意 → `status` 改 `"confirmed"`（写后照旧 validate），进 ⑥。

---

## ⑥ 逐日细化（住宿/交通/餐饮/门票 + geo 查证）

对 confirmed 的行程逐天细化（一次做 1-2 天，边做边给用户看，别一口气全做完再倒给用户）：

### 6.1 内容细化

- 每天补齐：住宿（kind=hotel）、当日交通（kind=transit，note 写路段与预计时长）、三餐中值得安排的（kind=meal）、门票/花费（`cost_cny`，参考游记正文提到的价格，拿不准就 WebSearch 核价）。
- 尽量贴近参考游记的安排，按 intake 微调（老人→强度降档；孩子→缩短车程）。
- `booking`：可预订条目填 `{type, name, url: <官方直链或null>, affiliate_url: null, alt_recommendation: null}`；查不到可靠直链就整个 booking 填 null，**不编 URL**。

### 6.2 geo 坐标（MUST 查证，禁止凭记忆）

- **MUST NOT 凭记忆/常识填经纬度**——模型记忆的坐标是幻觉高发区（R-09 规则就是为它设的）。
- 每个需要上图的条目，用 **WebFetch** 查证：
  1. 首选 Nominatim：WebFetch `https://nominatim.openstreetmap.org/search?q=<URL编码的地名>&format=jsonv2&limit=1`，prompt「返回第一条结果的 lat 与 lon 数值」。**查询词只用景点名容易被误配到同名/近音的境外地点**（实证 2026-07-05：单查「天山天池」返回日本长野县一处水库的坐标，Nominatim 不报错、静默给出低相关度的第一条结果）——查询词务必带地区限定（如「阜康市天池」「新疆XX县XX」），拿到结果后**检查 `display_name` 是否落在预期省份/国家**，对不上就换更具体的查询词重试，而不是直接采信。
  2. 查不到 → WebFetch 该地名的百度百科/维基百科页面，prompt「找页面中的经纬度坐标」。
  3. 都查不到 → `geo: null`（不上图，不硬填）。
- 查到的坐标直接写入该 item 的 `geo: {lat, lng}`（注意 Nominatim 返回 `lon`，schema 字段是 `lng`）。
- 每完成一批天的细化：**check validate（MUST）→ check run** → 展示。
- 全部天细化完且用户认可 → `status` 改 `"detailed"`（写后 validate）。

---

## ⑦ 冲突检查

```bash
npx tsx ~/.pilot/app/tools/check.ts run --trip <trip-id>
```

- 规则规范文本：`references/conflict-rules.md`（C-01~C-07 迁移自 W5 + v2 新增 R-08 预算超限 / R-09 相邻坐标同日内 >300km、跨天 >600km）。
- 输出 `[{day, rule, severity, detail}]`：逐条用规则文本里的话术呈现给用户，附建议。
- 全部为 warn 级：用户可以说「就这样」——记下已确认忽略的规则，同一条不重复唠叨。
- 触发时机：⑤ 初稿后、每轮编辑后、⑥ 每批细化后、⑧ 导出前（最后一次全量跑）。
- R-09 报警时优先怀疑坐标错误：重走 6.2 查证流程，而不是先怀疑行程。
- check.ts run 通过（无 error 级冲突）后，Skill 将 itinerary.json 的 `conflicts_checked_at` 写为当前 ISO8601 时间（写后照例跑 check.ts validate）。

---

## ⑧ 导出（Excel / PDF / Word）

内容基准：`references/manual-outline.md`（穷游手册九章节）。

导出前置：itinerary `status ∈ {confirmed, detailed}`，且刚跑过一次 ⑦。用户指定格式；没指定就三件套全出（顺序 PDF → Excel → Word）：

```bash
npx tsx ~/.pilot/app/tools/export/pdf.ts run --trip <trip-id> --format pdf
npx tsx ~/.pilot/app/tools/export/excel.ts run --trip <trip-id> --format xlsx
npx tsx ~/.pilot/app/tools/export/word.ts run --trip <trip-id> --format docx
```

产物在 `~/.pilot/workspace/<trip-id>/exports/`，把文件路径报给用户。
降级：Excel/Word 失败 → 保证 PDF 出来，失败格式如实告知（0.3 原则）；PDF 也失败 → 读 error JSON 解释并给「修复重试 / 先要 Markdown 版顶用」两个选项（Markdown 版由主会话直接从 itinerary.json 渲染，作为最后兜底）。

---

## ⑨ Session 恢复

- 每个会话开始（Skill 被触发）先跑 `npx tsx ~/.pilot/app/tools/trip.ts current`。
- `trip_id` 非 null → 检查该 trip 的 workspace 文件，判断进度并问用户「继续上次还是新开」：

| workspace 状态 | 恢复到 |
|----------------|--------|
| 只有 intake.json | ② |
| 有 search-plan.json / raw/serp-* 但无 pick.json | ②（2.2 起） |
| 有 pick.json，travelogues/ 为空 | ②（2.4 起）或 ③（看 pick 状态） |
| travelogues/ 有条目但无 index.json | ④ |
| 有 index.json 但无 itinerary.json | ⑤ |
| itinerary status=draft | ⑤（编辑） |
| itinerary status=confirmed | ⑥ |
| itinerary status=detailed，exports/ 空 | ⑧ |
| exports/ 有产物 | 完成态；问用户是要改行程还是新开 |
| trip_id 非 null 但对应 workspace 目录不存在 | 告知用户该 trip 记录无法恢复，引导新开 trip |

- 用户选「新开」→ 走 ①（`trip.ts new` 会把指针指向新 trip；旧 workspace 原样保留，不删）。
- `current-trip.json` 损坏（trip_id null 但文件存在）→ 告知用户旧记录无法恢复，直接新开。

---

## ⑩ 覆盖率如实汇报（话术纪律）

在 ②-④ 各阶段结束时，读 `search-plan.json` 与 `raw/pick.json` 统计，**如实**汇报，样式：

```
本轮搜索覆盖率：
- 马蜂窝：搜到 18 条 → 选 12 → 抓取成功 2（其余被滑块验证码拦截）
- 知乎：搜到 15 条 → 选 8 → 成功 6
- 小红书：无法抓取（需要登录 cookie）
- 携程攻略：搜到 10 条 → 选 6 → 成功 5
- 图虫：搜到 8 条 → 选 4 → 成功 3
- B站：3 条视频待第二轮处理
可用于结构化的游记：8 条（含 summary-only 增补 3 条）。
```

铁律：

1. **绝不假装数据充足**。成功 <10 条、或结构化后含逐日结构的 <5 条 → 明确告诉用户「本次参考素材偏少，行程质量会打折扣」，然后给选项，让**用户**选：
   - **继续**：就用现有素材做（明说置信度低的天会标出来）；
   - **提示可导出 cookie 提升成功率**：马蜂窝/知乎/穷游/小红书均支持 cookie 登录态（`~/.pilot/cookies/{mafengwo,zhihu,qyer,xhs}.json`，playwright storageState 格式），执行 `npx tsx ~/.pilot/app/tools/cookies.ts setup` 引导式登录导出后重跑 `scrape run`；马蜂窝被验证码拦时同理需人工过一次滑块；
   - **换源/换词重搜**：调整措辞或目的地粒度，重走 ②。
2. 失败写原因，不写「部分失败」这种含糊话：验证码拦截、需要 cookie、超时，各是各的。
3. 覆盖率数字来自文件统计，不许拍脑袋估；**summary-only 增补条目必须单独报数**（如「含 summary-only 增补 N 条」），不得混入抓取成功口径，增补占比过高（超过一半）要额外提醒用户素材质量偏低。
4. `config/pilot.json` 的 `preferred_domains` 对携程攻略（`you.ctrip.com`）/图虫（`tuchong.com`）等实证成功率更高的源做 pick 排序加权，覆盖率话术里这些源天然会更靠前，属预期内行为，不是异常。

---

## 附录 A：工具速查

| 命令 | 作用 | 状态 |
|------|------|------|
| `npx tsx ~/.pilot/app/tools/trip.ts new <slug>` / `current` | 建 trip / 读 session 指针 | ✅ |
| `npx tsx ~/.pilot/app/tools/search.ts plan --trip <id>` | intake → 搜索计划 | ✅ |
| `npx tsx ~/.pilot/app/tools/search.ts register --trip <id> --source <名> --file <serp>` | 登记 serp（ajv 校验） | ✅ |
| `npx tsx ~/.pilot/app/tools/search.ts pick --trip <id> [--top N]` | 候选清单 pick.json | ✅ |
| `npx tsx ~/.pilot/app/tools/scrape.ts run --trip <id> [--only <url>]` | playwright 兜底抓取 | ✅ |
| `npx tsx ~/.pilot/app/tools/distill.ts validate\|dedupe\|score\|index --trip <id> [--keep N]` | 校验/去重/评分/索引 | ✅ |
| `npx tsx ~/.pilot/app/tools/video.ts prep --url <u> --trip <id> [--max-frames N] [--meta-only]` | 视频预处理 | ✅ |
| `npx tsx ~/.pilot/app/tools/check.ts validate\|run --trip <id>` | itinerary 校验 / 冲突规则 | ✅ |
| `npx tsx ~/.pilot/app/tools/server/server.ts start --trip <id> [--port 4870]` | 本地只读 UI + SSE | ✅ |
| `npx tsx ~/.pilot/app/tools/export/<pdf\|excel\|word>.ts run --trip <id> --format <fmt>` | 三格式路书导出 | ✅ |
| `npx tsx ~/.pilot/app/tools/cookies.ts setup [--site <名>]` / `status` | 引导式 cookie 导出 / 各站点 cookie 现状表 | ✅ |

全部工具已交付。

## 附录 B：references

- `references/conflict-rules.md` —— 冲突规则规范文本（C-01~C-07 + R-08/R-09）
- `references/manual-outline.md` —— 穷游手册九章节大纲（导出内容基准）

## 版本信息

- Skill 版本：v4.0（实时搜索主链路，2026-07 架构调整）+ Task 7.5 内容供给对策（全站点 cookie / summary-only 增补 / 配额倾斜，2026-07-05）
- 契约：intake / search-plan / travelogue / itinerary schema 见 `shared/schema/`（冻结）
- 配置：`config/pilot.json`（topN=50、keepN=5、maxFrames=20、源路由、preferred_domains）
