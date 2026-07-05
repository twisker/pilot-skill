# 穷游手册四段结构大纲（路书导出内容基准）

> 本文件是 Excel / PDF / Word 三格式导出（Task 13-15、18、19，`tools/export/`）的**内容基准**：
> 三个渲染器共用同一数据对象（`tools/export/lib/render.ts` 的 `buildManualData(tripId)`），
> 数据对象的章节结构与字段来源以本文件为准。
> 单一数据源：`~/.pilot/workspace/<trip-id>/itinerary.json` + `intake.json`（+ `travelogues/index.json` 参考来源附注）。
>
> **Task 19（v4.0）**：PDF/Word 对齐 Excel（Task 18）已重构的四 sheet 结构——原九章节内容
> **重组而非删除**：行程概览/预算表合并为一天一行主表，住宿/交通/餐饮汇总降级为该主表的附注
> 小节，装备清单改造为自检清单模板，应急信息并入自检清单末尾，并新增消费流水模板。
> **Excel 是三渲染器中最完整的实现**（公式、下拉校验、跨表引用），PDF/Word 是同一结构的
> 静态呈现（模板段落留白供打印后手写）。设计裁定：PDF/Word 对 Excel 格式**取神不形似**，
> 不逐项复刻公式/校验，只需结构与内容对齐。

## 四段结构总览

| # | 段落 | Excel sheet 名 | PDF/Word 标题 | 数据来源 |
|---|------|----------------|----------------|---------|
| 1 | 行程安排及费用预算 | 行程安排及费用预算 | 一、行程安排及费用预算 | itinerary.days 骨架 + items[].cost_cny 聚合（`overview` + `budget.byDayKind`/`byKind`）；附注小节取 items 中 kind=hotel/transit/meal |
| 2 | 每日详细行程 | 每日详细行程 | 二、每日详细行程 | itinerary.days[].items 全量（`dailyDetails`） |
| 3 | 出行必备自检清单（模板） | 出行必备自检清单 | 三、出行必备自检清单（模板） | intake 推导的装备清单模板（`equipment`）+ intake.destination 推导的应急信息（`emergency`），均为渲染器内置规则，不依赖 AI 生成 |
| 4 | 消费流水及费用核算（模板） | 消费流水及费用核算 | 四、消费流水及费用核算（模板） | 无对应 itinerary 字段，纯模板；核算小表「预算数」取自 `budget.byKind` 真实值，「实际/差额」留空 |

封面（intake + itinerary 概要）与附录「参考游记来源」（`travelogues`）在四段结构之外，保留原样，分别置于最前与最后。

---

## 1. 封面

- 路书标题：`{intake.destination} {天数}天{交通方式}路书`（天数 = intake.dates start~end 含首尾）
- 出行日期：`intake.dates.start` ~ `intake.dates.end`
- 出行人：`intake.party`（adults / children / seniors 组合成「X大人X小孩X老人」）
- 出发地：`intake.origin_city`
- 生成信息：trip_id（`itinerary.trip_id`）、生成日期、「由 PILOT 生成」

## 2. 一、行程安排及费用预算

**主表**：一天一行，合并原「行程概览」与「预算表」两章：

- 天序与日期：`itinerary.days[].day`、`days[].date`
- 行程摘要：当天 `items` 中 `kind=sight` 条目名称串（如「赛里木湖 → 果子沟大桥 → 伊宁」），对应 `overview[].mainLine`
- 住宿地：当天 `items` 中 `kind=hotel` 条目的 `name`（无则「—」），对应 `overview[].hotel`
- 分类费用列（动态展开，按行程实际用到的类目建列）：`budget.byDayKind[].kindTotals`，费用类目顺序/措辞 = 门票(sight)/餐饮(meal)/住宿(hotel)/交通(transit)/其他(other)，与 Excel `BUDGET_KIND_LABELS` 对齐
- 当日合计：`budget.byDayKind[].total`
- 末行总计：各分类列 + 当日合计列求和，对应 `budget.byKind[].total` / `budget.grandTotal`

**与预算对比**：`budget.grandTotal` vs `intake.budget_cny`（null 则只列合计）；超预算标红；人均 = 合计 ÷ 出行人数（`intake.party` 三项之和）；未计价条目数提示（`budget.uncountedItemCount`）。

**附注小节**（原第4/5/6章内容保留，降级为本段小节）：

- **住宿汇总**：全程 `kind=hotel` 条目（`hotels.rows`），入住日/名称/备注/价格/预订链接，表尾小计（`hotels.subtotal`）
- **交通汇总**：全程交通方式（`transport.modeLabel`）；大交通（首末日 transit，`transport.longHaul`）；每日路段（中间天 transit，`transport.dailySegments`）；自驾取还车附注（`transport.carRentalNotes`）
- **餐饮推荐**：全程 `kind=meal` 条目按天分组（`meals`），无 meal 条目的天不出现

## 3. 二、每日详细行程

每天一节，条目按顺序列出（数据源 `dailyDetails`，与九章节版第3章「逐日详情」内容完全一致，未做任何重组）：

- 时间：`items[].time`（null 显示「待定」）
- 类型：`items[].kind`（sight=景点 / meal=餐饮 / hotel=住宿 / transit=交通 / other=其他）
- 名称与备注：`items[].name`、`items[].note`
- 坐标：`items[].geo`（null 不显示；有值时 PDF 可附小地图/坐标文本）
- 费用：`items[].cost_cny`（null 显示「—」）
- 预订入口：`items[].booking`（V1 只渲染 `booking.name` + `booking.url` 普通直链；`affiliate_url` / `alt_recommendation` V1 恒 null，不渲染）

## 4. 三、出行必备自检清单（模板）

**数据来源说明**：itinerary schema（冻结，additionalProperties=false）无装备字段。
自检清单事项由渲染器（`render.ts` 的 `buildEquipment`）用**内置规则模板**从 intake 推导，不依赖 AI 生成：

- 基础清单：证件（身份证/驾照）、充电、药品（固定模板）
- 季节推导：`intake.dates` 月份 → 衣物建议（如 7-8 月新疆：昼夜温差、防晒、冲锋衣）
- 交通推导：`intake.transport=self-drive` → 车用品（行车记录仪/拖车绳/备用油桶提示）
- 人群推导：`intake.party.children>0` → 儿童用品；`party.seniors>0` → 老人常用药提示
- 偏好推导：`intake.preferences` 含摄影 → 摄影器材项

**表格结构（模板，用户自填）**：类别 | 事项 | 责任人（空） | 出发前（空 ☐） | 出行中（空 ☐），打印后手工勾选；末尾预留空白追加行供补充自定义事项。

**应急信息**（原第9章，并入本段末尾——应急也是出行必备信息）：

**数据来源说明**：同上，由渲染器内置模板（`buildEmergency`）+ `intake.destination` 推导：

- 通用：110 / 120 / 122 / 119（国内固定模板；`intake.locale=en` 时换目的地国家紧急电话，V1 仅中文）
- 目的地注意事项：按 destination 匹配内置提示（如新疆：边防证提示、部分区域信号盲区、加油站间距）
- 保险与救援：自驾道路救援电话模板位
- 行程数据备份说明：workspace 路径 + 本路书文件位置

## 5. 四、消费流水及费用核算（模板）

**无对应 itinerary/intake 字段，纯模板新增**（对齐真实自驾出行记账习惯，见 `design/reference-xlsx-format.md` 第4类 sheet 解析）：

- **消费流水表**：空白表格，列为 日期 | 项目 | 类别 | 金额 | 付款人 | 备注；PDF/Word 预留 ~20 行空白供出行期间手写记账（Excel 版额外提供类别下拉校验，见下）
- **费用核算小表**：类别（门票/餐饮/住宿/交通/购物/其他）| 预算数 | 实际 | 差额
  - 「预算数」列**为真实值**，取自 `budget.byKind` 对应类目合计（门票→sight、餐饮→meal、住宿→hotel、交通→transit、其他→other；「购物」在 itinerary kind 枚举中无对应类目，恒为 ¥0）
  - 「实际」「差额」两列留空，供出行结束后用户自行核算填写

---

## 渲染器分工（Task 13-15、18、19 对照）

| 格式 | 工具 | 结构覆盖 | 完整度 |
|------|------|---------|--------|
| Excel | `tools/export/excel.ts` | **4 sheet，与上述四段结构一一对应**：①「行程安排及费用预算」（SUM 公式总计 + 与预算对比）②「每日详细行程」③「出行必备自检清单」模板（预置事项行 + 空白追加行）④「消费流水及费用核算」模板（示例流水行 + SUMIF 按类别核算 + 跨表引用①做预算对比）。详见 `design/reference-xlsx-format.md`。**三渲染器中最完整的实现**（公式、数据校验下拉、跨表引用）。 |
| PDF（优先保底） | `tools/export/pdf.ts`（`lib/html.ts` 生成 HTML，playwright 打印） | 封面 + 同一四段结构（HTML `<section class="chapter">` 对应四段，`page-break-before: always` 保证每段独立起页）+ 附录，静态呈现，无公式；消费流水表为 ~20 行空白表格供手写 |
| Word | `tools/export/word.ts`（docx 库） | 封面 + 同一四段结构（`HeadingLevel.HEADING_1` 对应四段主标题，`HEADING_2`/`HEADING_3` 对应附注小节/子小节）+ 附录，静态呈现，无公式；消费流水表同样为 ~20 行空白表格 |
