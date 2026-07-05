import path from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from "docx";
import { buildManualData, type ManualData } from "./lib/render";
import { tripDir } from "../lib/workspace";
import { track } from "../lib/telemetry";
import { reportProgress } from "../lib/progress";

// ---------------------------------------------------------------------------
// PILOT export/word.ts —— 穷游手册 Word (.docx) 导出
//
//   run --trip <id> --format docx   buildManualData → docx 库 Document
//                                    → exports/<trip>-路书.docx
//
// SKILL.md ⑧ 导出命令的落地实现。数据层（buildManualData）在 lib/render.ts，
// 本文件只做 ManualData → docx 的编排 + CLI 参数解析，CLI/错误处理模式与
// excel.ts（Task 14/18）/ pdf.ts（Task 13）保持一致。
//
// Task 19（v4.0）：对齐 Excel 四段结构（design/reference-xlsx-format.md +
// Task 18 excel.ts）——原九章节内容重组而非删除，四段主结构为：
//   一、行程安排及费用预算（原行程概览 + 预算表合并为一天一行主表，原住宿/
//      交通/餐饮章节内容降级为本段附注小节）
//   二、每日详细行程（原逐日详情，不变）
//   三、出行必备自检清单（模板，原装备清单改造 + 原应急信息并入末尾）
//   四、消费流水及费用核算（模板，新增——空白流水表 + 核算小表）
// 封面与参考游记附录保留原样。详见 .claude/skills/pilot/references/manual-outline.md。
//
// 中文字体：正文用「宋体」（打印手册惯用字体），标题/封面用「苹方
// （PingFang SC）」以获得更清晰的视觉层级；OOXML 本身不支持 CSS 式的多字体
// 兜底链，V1 目标运行环境是 macOS 笔电（本地跑 Claude Code），
// 当「宋体」未安装时，
// Word/Pages/WPS 通常会按系统默认 CJK 字体（macOS 上即为苹方）自动回退，
// 这里额外显式给标题/封面指定苹方，确保即使宋体缺失也有明确、可控的中文
// 字体展示效果。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new CliError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    flags[key.slice(2)] = rest[i + 1] ?? "";
  }
  return { cmd, flags };
}

const BODY_FONT = { ascii: "Times New Roman", eastAsia: "宋体", hAnsi: "Times New Roman" };
const HEADING_FONT = { ascii: "PingFang SC", eastAsia: "PingFang SC", hAnsi: "PingFang SC" };

type Kind = ManualData["budget"]["byKind"][number]["kind"];

// 费用类目动态展开顺序 + 列名——与 excel.ts / lib/html.ts 保持一致的「预算表
// 费用类目」措辞（门票/其他），与 render.ts KIND_LABELS（景点/其他，逐日明细
// 条目类型标签）是两套不同场景的命名，不应合并。
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

/** 只允许 http(s) 链接，防止文档内容里混入 javascript: 等危险 scheme */
function safeUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    run: { font: HEADING_FONT },
    children: [new TextRun({ text, font: HEADING_FONT, bold: true })],
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: HEADING_FONT, bold: true })],
  });
}

function heading3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun({ text, font: HEADING_FONT, bold: true, size: 22 })],
  });
}

function body(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, font: BODY_FONT })] });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, font: BODY_FONT })],
  });
}

/** 链接文本：有合法 URL 用超链接展示，否则退化为普通文本段落 */
function linkOrText(label: string, url: string | null | undefined): Paragraph {
  const safe = safeUrl(url);
  if (!safe) return body(label);
  return new Paragraph({
    children: [
      new ExternalHyperlink({
        link: safe,
        children: [new TextRun({ text: label, font: BODY_FONT, style: "Hyperlink" })],
      }),
    ],
  });
}

function cell(text: string, opts: { bold?: boolean } = {}): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, font: BODY_FONT, bold: opts.bold ?? false })] })],
  });
}

function headerRow(labels: string[]): TableRow {
  return new TableRow({ children: labels.map((label) => cell(label, { bold: true })) });
}

function dataRow(values: string[]): TableRow {
  return new TableRow({ children: values.map((value) => cell(value)) });
}

/** 空白行——供打印后手写填写（消费流水模板 / 自检清单追加行） */
function blankRow(columns: number): TableRow {
  return new TableRow({ children: Array.from({ length: columns }, () => cell("")) });
}

function table(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow(headers), ...rows.map((row) => dataRow(row))],
  });
}

// ---------------------------------------------------------------------------
// 章节构建函数 —— 每个函数返回该章节的 docx children（Paragraph/Table 序列）
// ---------------------------------------------------------------------------

function buildCoverChildren(data: ManualData): Paragraph[] {
  const { cover } = data;
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 2000, after: 400 },
      children: [new TextRun({ text: cover.title, font: HEADING_FONT, bold: true, size: 56 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `出行日期：${cover.dateStart} ~ ${cover.dateEnd}（共 ${cover.totalDays} 天）`,
          font: BODY_FONT,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `出行人：${cover.partyLabel}`, font: BODY_FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `出发地：${cover.originCity}`, font: BODY_FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 600 },
      children: [
        new TextRun({
          text: `trip_id: ${cover.tripId} ｜ 生成时间：${cover.generatedAt}`,
          font: BODY_FONT,
          size: 18,
          color: "666666",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "由 PILOT 生成", font: BODY_FONT, size: 18, color: "666666" })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ---------------------------------------------------------------------------
// 一、行程安排及费用预算 —— 一天一行主表（原行程概览+预算表合并）+ 与预算对比
// + 住宿/交通/餐饮附注小节（原独立章节降级）
// ---------------------------------------------------------------------------

function buildBudgetMainTable(data: ManualData): Table {
  const { overview, budget } = data;
  const kindsUsed = BUDGET_KIND_ORDER.filter((k) => budget.byKind.some((row) => row.kind === k));
  const headers = ["天", "日期", "行程摘要", "住宿地", ...kindsUsed.map((k) => BUDGET_KIND_LABELS[k]), "当日合计"];

  const dataRows = overview.map((ov, idx) => {
    const dayKind = budget.byDayKind[idx];
    return [
      `第${ov.day}天`,
      ov.date,
      ov.mainLine,
      ov.hotel,
      ...kindsUsed.map((k) => `¥${dayKind?.kindTotals[k] ?? 0}`),
      `¥${dayKind?.total ?? 0}`,
    ];
  });

  const totalRowValues = [
    "",
    "",
    "",
    "总计",
    ...kindsUsed.map((k) => `¥${budget.byKind.find((row) => row.kind === k)?.total ?? 0}`),
    `¥${budget.grandTotal}`,
  ];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(headers),
      ...dataRows.map((row) => dataRow(row)),
      new TableRow({ children: totalRowValues.map((value) => cell(value, { bold: true })) }),
    ],
  });
}

function buildBudgetCompareChildren(data: ManualData): Paragraph[] {
  const { budget } = data;
  const children: Paragraph[] = [heading2("与预算对比")];
  if (budget.budgetCny !== null) {
    children.push(body(`合计：¥${budget.grandTotal} / 预算 ¥${budget.budgetCny}`));
    children.push(body(`结余/超支：¥${budget.diff}（${budget.overBudget ? "超支" : "未超支"}）`));
  } else {
    children.push(body(`合计：¥${budget.grandTotal}（未设置预算上限）`));
  }
  children.push(body(`人均：¥${Math.round(budget.perPerson)}`));
  if (budget.uncountedItemCount > 0) {
    children.push(body(`（未计价条目 ${budget.uncountedItemCount} 条，未计入以上金额）`));
  }
  return children;
}

function buildHotelsNoteChildren(data: ManualData): (Paragraph | Table)[] {
  const { hotels } = data;
  return [
    heading2("住宿汇总"),
    table(
      ["入住日", "名称", "备注", "价格", "预订链接"],
      hotels.rows.map((row) => [
        row.date,
        row.name,
        row.note,
        row.cost === null ? "—" : `¥${row.cost}`,
        safeUrl(row.bookingUrl) ?? "—",
      ])
    ),
    body(`住宿费用小计：¥${hotels.subtotal}`),
  ];
}

function buildTransportNoteChildren(data: ManualData): (Paragraph | Table)[] {
  const { transport } = data;
  const segmentRow = (seg: (typeof transport.longHaul)[number]): string[] => [
    `第${seg.day}天`,
    seg.date,
    seg.name,
    seg.note,
    seg.cost === null ? "—" : `¥${seg.cost}`,
  ];
  const children: (Paragraph | Table)[] = [
    heading2("交通汇总"),
    body(`全程交通方式：${transport.modeLabel}`),
    heading3("大交通（去程/返程）"),
    table(["天", "日期", "名称", "备注", "费用"], transport.longHaul.map(segmentRow)),
    heading3("每日路段"),
    table(["天", "日期", "名称", "备注", "费用"], transport.dailySegments.map(segmentRow)),
  ];
  if (transport.carRentalNotes.length > 0) {
    children.push(heading3("自驾行程附注（取还车）"));
    for (const note of transport.carRentalNotes) {
      children.push(bullet(`第${note.day}天 ${note.date}：${note.name}（${note.note}）`));
    }
  }
  return children;
}

function buildMealsNoteChildren(data: ManualData): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [heading2("餐饮推荐")];
  if (data.meals.length === 0) {
    children.push(body("本行程无独立餐饮条目。"));
    return children;
  }
  for (const group of data.meals) {
    children.push(heading3(`第 ${group.day} 天 · ${group.date}`));
    children.push(
      table(
        ["名称", "备注", "费用"],
        group.items.map((item) => [item.name, item.note, item.cost === null ? "—" : `¥${item.cost}`])
      )
    );
  }
  return children;
}

function buildBudgetSectionChildren(data: ManualData): (Paragraph | Table)[] {
  return [
    heading1("一、行程安排及费用预算"),
    buildBudgetMainTable(data),
    ...buildBudgetCompareChildren(data),
    ...buildHotelsNoteChildren(data),
    ...buildTransportNoteChildren(data),
    ...buildMealsNoteChildren(data),
  ];
}

// ---------------------------------------------------------------------------
// 二、每日详细行程 —— 原逐日详情，不变
// ---------------------------------------------------------------------------

function buildDailyDetailsChildren(data: ManualData): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [heading1("二、每日详细行程")];
  for (const day of data.dailyDetails) {
    children.push(heading2(`第 ${day.day} 天 · ${day.date}`));
    children.push(
      table(
        ["时间", "类型", "名称", "备注", "费用"],
        day.items.map((item) => [item.time, item.kindLabel, item.name, item.note, item.costLabel])
      )
    );
    for (const item of day.items) {
      if (item.bookingUrl) {
        children.push(linkOrText(`预订：${item.bookingName ?? item.name} → ${item.bookingUrl}`, item.bookingUrl));
      }
      // item 级额外推荐（booking.alt_recommendation）：逐日明细里加一行「替代推荐」
      if (item.alt) {
        children.push(
          linkOrText(
            `替代推荐：${item.alt.name}（${item.alt.reason}）${item.alt.url ? ` → ${item.alt.url}` : ""}`,
            item.alt.url
          )
        );
      }
    }
  }
  return children;
}

// ---------------------------------------------------------------------------
// 三、出行必备自检清单（模板）—— 原装备清单改造为「事项+责任人+勾选列」表，
// 原应急信息并入末尾小节（应急也是出行必备信息）
// ---------------------------------------------------------------------------

function buildChecklistTable(data: ManualData): Table {
  const itemRows = data.equipment.flatMap((category) =>
    category.items.map((item) => [category.category, item, "", "☐", "☐"])
  );
  const appendRows = Array.from({ length: CHECKLIST_APPEND_ROWS }, () => blankRow(5));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow(["类别", "事项", "责任人", "出发前", "出行中"]), ...itemRows.map((row) => dataRow(row)), ...appendRows],
  });
}

function buildEmergencyNoteChildren(data: ManualData): Paragraph[] {
  const { emergency } = data;
  const children: Paragraph[] = [heading2("应急信息")];
  children.push(heading3("通用紧急电话"));
  for (const entry of emergency.generalNumbers) {
    children.push(bullet(`${entry.label}：${entry.number}`));
  }
  children.push(heading3("目的地注意事项"));
  for (const note of emergency.destinationNotes) {
    children.push(bullet(note));
  }
  children.push(heading3("保险与救援"));
  for (const note of emergency.insurance) {
    children.push(bullet(note));
  }
  children.push(heading3("行程数据备份"));
  children.push(body(emergency.backupInfo));
  return children;
}

function buildChecklistSectionChildren(data: ManualData): (Paragraph | Table)[] {
  return [
    heading1("三、出行必备自检清单（模板）"),
    body("以下事项由行程自动推导预置；责任人 / 出发前 / 出行中两列请打印后手工勾选（☑）。空白行可自行填写补充事项。"),
    buildChecklistTable(data),
    ...buildEmergencyNoteChildren(data),
  ];
}

// ---------------------------------------------------------------------------
// 四、消费流水及费用核算（模板）—— 新增：空白流水表（供手写）+ 核算小表
// （核算小表「预算数」取自行程安排及费用预算的真实分类合计，「实际/差额」留空）
// ---------------------------------------------------------------------------

function buildCashflowTable(): Table {
  const appendRows = Array.from({ length: CASHFLOW_APPEND_ROWS }, () => blankRow(6));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow(["日期", "项目", "类别", "金额", "付款人", "备注"]), ...appendRows],
  });
}

function buildCashflowAccountingTable(data: ManualData): Table {
  const rows = CASHFLOW_CATEGORIES.map((category) => {
    const kind = CASHFLOW_CATEGORY_TO_KIND[category];
    const kindRow = kind ? data.budget.byKind.find((row) => row.kind === kind) : undefined;
    return [category, `¥${kindRow?.total ?? 0}`, "", ""];
  });
  return table(["类别", "预算数", "实际", "差额"], rows);
}

function buildCashflowSectionChildren(data: ManualData): (Paragraph | Table)[] {
  return [
    heading1("四、消费流水及费用核算（模板）"),
    body(
      "以下为空白流水表，供出行期间逐笔手写记账；表末核算小表「预算数」已按行程安排及费用预算的分类合计自动填入，「实际」「差额」请出行结束后自行核算填写。"
    ),
    heading2("消费流水"),
    buildCashflowTable(),
    heading2("费用核算（按类别）"),
    buildCashflowAccountingTable(data),
  ];
}

// ---------------------------------------------------------------------------
// 附录：参考游记来源 —— 保留原样
// ---------------------------------------------------------------------------

function buildTraveloguesChildren(data: ManualData): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [heading1("附录：参考游记")];
  if (data.travelogues.length === 0) {
    children.push(body("本行程未记录参考游记来源。"));
    return children;
  }
  children.push(
    table(
      ["ID", "简介", "标签", "评分", "天数", "链接"],
      data.travelogues.map((t) => [
        t.id,
        t.brief,
        t.tags.join("、"),
        t.total.toFixed(2),
        t.days_count === undefined ? "—" : String(t.days_count),
        safeUrl(t.url) ?? "—",
      ])
    )
  );
  return children;
}

function buildDocument(data: ManualData): Document {
  return new Document({
    styles: {
      default: {
        document: { run: { font: BODY_FONT } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: convertMillimetersToTwip(20),
              bottom: convertMillimetersToTwip(16),
              left: convertMillimetersToTwip(20),
              right: convertMillimetersToTwip(20),
            },
          },
        },
        children: [
          ...buildCoverChildren(data),
          ...buildBudgetSectionChildren(data),
          ...buildDailyDetailsChildren(data),
          ...buildChecklistSectionChildren(data),
          ...buildCashflowSectionChildren(data),
          ...buildTraveloguesChildren(data),
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------

export interface RunWordResult {
  path: string;
  bytes: number;
}

export async function runWord(tripId: string): Promise<RunWordResult> {
  reportProgress(tripId, { stage: "export", current: 0, total: 1, message: "开始导出 Word" });

  const data = buildManualData(tripId);
  const doc = buildDocument(data);

  const outDir = path.join(tripDir(tripId), "exports");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${tripId}-路书.docx`);

  const buffer = await Packer.toBuffer(doc);
  await writeFile(outPath, buffer);

  const bytes = statSync(outPath).size;
  reportProgress(tripId, { stage: "export", current: 1, total: 1, message: `Word 导出完成: ${outPath}` });
  return { path: outPath, bytes };
}

export async function main(argv: string[]): Promise<unknown> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd !== "run") {
    throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 run）`);
  }
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const format = flags.format ?? "docx";
  if (format !== "docx") {
    throw new CliError(`不支持的 --format: ${format}（本工具仅支持 docx，pdf/excel 见各自导出工具）`);
  }
  const result = await runWord(flags.trip);
  track("export", { format: "docx" });
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    });
}
