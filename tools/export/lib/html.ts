import { readFileSync } from "node:fs";
import path from "node:path";
import type { ManualData } from "./render";

// ---------------------------------------------------------------------------
// PILOT export/lib/html.ts —— ManualData → 穷游手册 HTML（PDF 专用渲染）
//
// templates/manual.html 是静态外壳（<head> A4 打印 CSS + 中文字体回退），
// 本文件生成正文 HTML 片段，替换外壳里的 {{CONTENT}} 占位符。
// Excel/Word 渲染器（Task 14/15/18/19）不复用本文件——它们直接消费
// ManualData 对象，各自用 exceljs/docx 生成自己格式的文档。
//
// Task 19（v4.0）：对齐 Excel 四段结构（design/reference-xlsx-format.md +
// Task 18 excel.ts）——原九章节内容重组而非删除，四段主结构为：
//   一、行程安排及费用预算（原第2章行程概览 + 第7章预算表合并为一天一行主表，
//      原第4/5/6章住宿/交通/餐饮内容降级为本段附注小节）
//   二、每日详细行程（原第3章逐日详情，不变）
//   三、出行必备自检清单（模板，原第8章装备清单改造 + 原第9章应急信息并入末尾）
//   四、消费流水及费用核算（模板，新增——空白流水表 + 核算小表）
// 封面与参考游记附录保留原样。详见 .claude/skills/pilot/references/manual-outline.md。
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = path.resolve(__dirname, "../templates/manual.html");

type Kind = ManualData["budget"]["byKind"][number]["kind"];

// 费用类目动态展开顺序 + 列名——「预算表费用类目」措辞（门票/其他），与
// render.ts KIND_LABELS（景点/其他，逐日明细条目类型标签）是两套不同场景的
// 命名，不应合并（与 excel.ts 保持一致的取舍，见该文件同名常量注释）。
const BUDGET_KIND_ORDER: Kind[] = ["sight", "meal", "hotel", "transit", "other"];
const BUDGET_KIND_LABELS: Record<Kind, string> = {
  sight: "门票",
  meal: "餐饮",
  hotel: "住宿",
  transit: "交通",
  other: "其他",
};

// 消费流水模板：空白手写行数 + 核算类别（与 excel.ts CASHFLOW_CATEGORIES 对齐）
const CASHFLOW_APPEND_ROWS = 20;
const CASHFLOW_CATEGORIES = ["门票", "餐饮", "住宿", "交通", "购物", "其他"] as const;
const CASHFLOW_CATEGORY_TO_KIND: Record<(typeof CASHFLOW_CATEGORIES)[number], Kind | null> = {
  门票: "sight",
  餐饮: "meal",
  住宿: "hotel",
  交通: "transit",
  购物: null,
  其他: "other",
};

const CHECKLIST_APPEND_ROWS = 6;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只允许 http(s) 链接，防止 PDF 内容里混入 javascript: 等危险 scheme */
function safeUrl(url: string | null): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function renderCover(data: ManualData): string {
  const { cover } = data;
  return `
<section class="chapter cover">
  <h1>${escapeHtml(cover.title)}</h1>
  <p>出行日期：${escapeHtml(cover.dateStart)} ~ ${escapeHtml(cover.dateEnd)}（共 ${cover.totalDays} 天）</p>
  <p>出行人：${escapeHtml(cover.partyLabel)}</p>
  <p>出发地：${escapeHtml(cover.originCity)}</p>
  <p class="muted">trip_id: ${escapeHtml(cover.tripId)} ｜ 生成时间：${escapeHtml(cover.generatedAt)}</p>
  <p class="muted">由 PILOT 生成</p>
</section>`;
}

// ---------------------------------------------------------------------------
// 一、行程安排及费用预算 —— 一天一行主表（原第2章概览+第7章预算合并）+
// 与预算对比 + 住宿/交通/餐饮附注小节（原第4/5/6章降级）
// ---------------------------------------------------------------------------

function renderBudgetMainTable(data: ManualData): string {
  const { overview, budget } = data;
  const kindsUsed = BUDGET_KIND_ORDER.filter((k) => budget.byKind.some((row) => row.kind === k));

  const headerCells = ["天", "日期", "行程摘要", "住宿地", ...kindsUsed.map((k) => BUDGET_KIND_LABELS[k]), "当日合计"]
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join("");

  const rows = overview
    .map((ov, idx) => {
      const dayKind = budget.byDayKind[idx];
      const kindCells = kindsUsed.map((k) => `<td>¥${dayKind?.kindTotals[k] ?? 0}</td>`).join("");
      return `
      <tr>
        <td>第${ov.day}天</td>
        <td>${escapeHtml(ov.date)}</td>
        <td>${escapeHtml(ov.mainLine)}</td>
        <td>${escapeHtml(ov.hotel)}</td>
        ${kindCells}
        <td>¥${dayKind?.total ?? 0}</td>
      </tr>`;
    })
    .join("");

  const totalCells = kindsUsed
    .map((k) => {
      const row = budget.byKind.find((r) => r.kind === k);
      return `<td>¥${row?.total ?? 0}</td>`;
    })
    .join("");
  const totalRow = `<tr class="total-row"><td colspan="4">总计</td>${totalCells}<td>¥${budget.grandTotal}</td></tr>`;

  return `
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${rows}${totalRow}</tbody>
  </table>`;
}

function renderBudgetCompare(data: ManualData): string {
  const { budget } = data;
  const budgetLine =
    budget.budgetCny === null
      ? `<p>合计：¥${budget.grandTotal}（未设置预算上限）</p>`
      : `<p class="${budget.overBudget ? "over-budget" : ""}">合计：¥${budget.grandTotal} / 预算 ¥${budget.budgetCny}（${
          budget.overBudget ? `超出 ¥${Math.abs(budget.diff ?? 0)}` : `结余 ¥${budget.diff}`
        }）</p>`;
  return `
  <h3>与预算对比</h3>
  ${budgetLine}
  <p>人均：¥${Math.round(budget.perPerson)}</p>
  <p class="muted">未计价条目 ${budget.uncountedItemCount} 条，未计入合计</p>`;
}

function renderHotelsNote(data: ManualData): string {
  const rows = data.hotels.rows
    .map((row) => {
      const url = safeUrl(row.bookingUrl);
      const urlDisplay = url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : "—";
      return `
      <tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.note)}</td>
        <td>${row.cost === null ? "—" : `¥${row.cost}`}</td>
        <td>${urlDisplay}</td>
      </tr>`;
    })
    .join("");
  return `
  <h3>住宿汇总</h3>
  <table>
    <thead><tr><th>入住日</th><th>名称</th><th>备注</th><th>价格</th><th>预订链接</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">小计</td><td colspan="2">¥${data.hotels.subtotal}</td></tr></tfoot>
  </table>`;
}

function renderTransportSegments(rows: ManualData["transport"]["longHaul"]): string {
  return rows
    .map(
      (row) => `
      <tr>
        <td>第${row.day}天</td>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td class="muted">${escapeHtml(row.note)}</td>
        <td>${row.cost === null ? "—" : `¥${row.cost}`}</td>
      </tr>`
    )
    .join("");
}

function renderTransportNote(data: ManualData): string {
  const { transport } = data;
  const carRental =
    transport.carRentalNotes.length > 0
      ? `<h4>自驾取还车</h4><ul>${transport.carRentalNotes
          .map((row) => `<li>第${row.day}天 ${escapeHtml(row.name)}（${escapeHtml(row.bookingName ?? "无预订信息")}）</li>`)
          .join("")}</ul>`
      : "";
  return `
  <h3>交通汇总</h3>
  <p>全程交通方式：${escapeHtml(transport.modeLabel)}</p>
  <h4>大交通（去程/返程）</h4>
  <table>
    <thead><tr><th>天序</th><th>日期</th><th>名称</th><th>备注</th><th>费用</th></tr></thead>
    <tbody>${renderTransportSegments(transport.longHaul)}</tbody>
  </table>
  <h4>每日路段</h4>
  <table>
    <thead><tr><th>天序</th><th>日期</th><th>名称</th><th>备注</th><th>费用</th></tr></thead>
    <tbody>${renderTransportSegments(transport.dailySegments)}</tbody>
  </table>
  ${carRental}`;
}

function renderMealsNote(data: ManualData): string {
  const groups = data.meals
    .map((group) => {
      const items = group.items
        .map(
          (item) => `<li>${escapeHtml(item.name)} —— ${escapeHtml(item.note)}（${item.cost === null ? "—" : `¥${item.cost}`}）</li>`
        )
        .join("");
      return `<h4>第${group.day}天 · ${escapeHtml(group.date)}</h4><ul>${items}</ul>`;
    })
    .join("");
  return `
  <h3>餐饮推荐</h3>
  ${groups || '<p class="muted">本行程无独立餐饮条目</p>'}`;
}

function renderBudgetSection(data: ManualData): string {
  return `
<section class="chapter">
  <h2>一、行程安排及费用预算</h2>
  ${renderBudgetMainTable(data)}
  ${renderBudgetCompare(data)}
  ${renderHotelsNote(data)}
  ${renderTransportNote(data)}
  ${renderMealsNote(data)}
</section>`;
}

// ---------------------------------------------------------------------------
// 二、每日详细行程 —— 原第3章逐日详情，不变
// ---------------------------------------------------------------------------

function renderDailyDetailsSection(data: ManualData): string {
  const days = data.dailyDetails
    .map((day) => {
      const items = day.items
        .map((item) => {
          let booking = "—";
          if (item.bookingName || item.bookingUrl) {
            const name = escapeHtml(item.bookingName ?? "");
            const url = safeUrl(item.bookingUrl);
            if (url) {
              booking = `${name ? `${name} ` : ""}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
            } else {
              booking = name || "—";
            }
          }
          const geo = item.geoLabel ? `<div class="muted">坐标：${escapeHtml(item.geoLabel)}</div>` : "";
          return `
          <tr>
            <td class="nowrap">${escapeHtml(item.time)}</td>
            <td class="nowrap"><span class="tag">${escapeHtml(item.kindLabel)}</span></td>
            <td>${escapeHtml(item.name)}<div class="muted">${escapeHtml(item.note)}</div>${geo}</td>
            <td class="nowrap">${escapeHtml(item.costLabel)}</td>
            <td>${booking}</td>
          </tr>`;
        })
        .join("");
      return `
      <div class="day-block">
        <h3>第${day.day}天 · ${escapeHtml(day.date)}</h3>
        <table>
          <thead><tr><th>时间</th><th>类型</th><th>名称/备注</th><th>费用</th><th>预订</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
      </div>`;
    })
    .join("");
  return `
<section class="chapter">
  <h2>二、每日详细行程</h2>
  ${days}
</section>`;
}

// ---------------------------------------------------------------------------
// 三、出行必备自检清单（模板）—— 原第8章装备清单改造为「事项+责任人+勾选列」表，
// 原第9章应急信息并入末尾小节（应急也是出行必备信息）
// ---------------------------------------------------------------------------

function renderChecklistTable(data: ManualData): string {
  const rows = data.equipment
    .flatMap((cat) =>
      cat.items.map(
        (item) => `
      <tr>
        <td>${escapeHtml(cat.category)}</td>
        <td>${escapeHtml(item)}</td>
        <td></td>
        <td class="checkbox">☐</td>
        <td class="checkbox">☐</td>
      </tr>`
      )
    )
    .join("");
  const appendRows = Array.from({ length: CHECKLIST_APPEND_ROWS })
    .map(
      () => `
      <tr class="append-row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`
    )
    .join("");
  return `
  <p class="muted">以下事项由行程自动推导预置；责任人 / 出发前 / 出行中两列请打印后手工勾选（☑）。空白行可自行填写补充事项。</p>
  <table>
    <thead><tr><th>类别</th><th>事项</th><th>责任人</th><th>出发前</th><th>出行中</th></tr></thead>
    <tbody>${rows}${appendRows}</tbody>
  </table>`;
}

function renderEmergencyNote(data: ManualData): string {
  const { emergency } = data;
  const numbers = emergency.generalNumbers
    .map((n) => `<li>${escapeHtml(n.label)}：${escapeHtml(n.number)}</li>`)
    .join("");
  const notes = emergency.destinationNotes.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
  const insurance = emergency.insurance.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
  return `
  <h3>应急信息</h3>
  <h4>通用应急电话</h4>
  <ul>${numbers}</ul>
  <h4>目的地注意事项</h4>
  <ul>${notes}</ul>
  <h4>保险与救援</h4>
  <ul>${insurance}</ul>
  <p class="muted">${escapeHtml(emergency.backupInfo)}</p>`;
}

function renderChecklistSection(data: ManualData): string {
  return `
<section class="chapter">
  <h2>三、出行必备自检清单（模板）</h2>
  ${renderChecklistTable(data)}
  ${renderEmergencyNote(data)}
</section>`;
}

// ---------------------------------------------------------------------------
// 四、消费流水及费用核算（模板）—— 新增：空白流水表（供手写）+ 核算小表
// （核算小表「预算数」取自行程安排及费用预算的真实分类合计，「实际/差额」留空）
// ---------------------------------------------------------------------------

function renderCashflowSection(data: ManualData): string {
  const appendRows = Array.from({ length: CASHFLOW_APPEND_ROWS })
    .map(
      () => `
      <tr class="append-row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`
    )
    .join("");

  const acctRows = CASHFLOW_CATEGORIES.map((category) => {
    const kind = CASHFLOW_CATEGORY_TO_KIND[category];
    const kindRow = kind ? data.budget.byKind.find((row) => row.kind === kind) : undefined;
    const budgetAmount = kindRow ? `¥${kindRow.total}` : "¥0";
    return `<tr><td>${escapeHtml(category)}</td><td>${budgetAmount}</td><td></td><td></td></tr>`;
  }).join("");

  return `
<section class="chapter">
  <h2>四、消费流水及费用核算（模板）</h2>
  <p class="muted">以下为空白流水表，供出行期间逐笔手写记账；表末核算小表「预算数」已按行程安排及费用预算的分类合计自动填入，「实际」「差额」请出行结束后自行核算填写。</p>
  <h3>消费流水</h3>
  <table>
    <thead><tr><th>日期</th><th>项目</th><th>类别</th><th>金额</th><th>付款人</th><th>备注</th></tr></thead>
    <tbody>${appendRows}</tbody>
  </table>
  <h3>费用核算（按类别）</h3>
  <table>
    <thead><tr><th>类别</th><th>预算数</th><th>实际</th><th>差额</th></tr></thead>
    <tbody>${acctRows}</tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// 附录：参考游记来源 —— 保留原样
// ---------------------------------------------------------------------------

function renderTravelogues(data: ManualData): string {
  if (data.travelogues.length === 0) return "";
  const rows = data.travelogues
    .map((t) => {
      const url = safeUrl(t.url);
      const urlDisplay = url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(t.url);
      return `
      <tr>
        <td>${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.brief)}</td>
        <td>${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</td>
        <td>${t.days_count ?? "—"}</td>
        <td class="muted">${urlDisplay}</td>
      </tr>`;
    })
    .join("");
  return `
<section class="chapter">
  <h2>附录：参考游记来源</h2>
  <table>
    <thead><tr><th>ID</th><th>简介</th><th>标签</th><th>天数</th><th>来源链接</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

/** 生成完整 HTML 文档（外壳 + 封面 + 四段主结构 + 附录） */
export function renderManualHtml(data: ManualData): string {
  const shell = readFileSync(TEMPLATE_PATH, "utf-8");
  const content = [
    renderCover(data),
    renderBudgetSection(data),
    renderDailyDetailsSection(data),
    renderChecklistSection(data),
    renderCashflowSection(data),
    renderTravelogues(data),
  ].join("\n");

  return shell
    .replace("{{TITLE}}", () => escapeHtml(data.cover.title))
    .replace("{{CONTENT}}", () => content);
}
