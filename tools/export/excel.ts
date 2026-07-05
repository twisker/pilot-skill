import path from "node:path";
import { mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import { buildManualData, type ManualData, type ItineraryItem } from "./lib/render";
import { tripDir } from "../lib/workspace";

// ---------------------------------------------------------------------------
// PILOT export/excel.ts —— 穷游手册 Excel 导出（4 sheet，对齐真实自驾出行记账格式）
//
//   run --trip <id> --format xlsx   buildManualData → exceljs Workbook
//                                    → exports/<trip>-路书.xlsx
//
// Task 18：依据 design/reference-xlsx-format.md（解析两份真实旅行
// 计划 xlsx 得出的格式规范）重构为 4 sheet。设计裁定：格式仅取「结构
// 精神」参考，不逐像素模仿；「出行必备自检清单」「消费流水及费用核算」两
// sheet 是**模板**——预置表头/示例行/公式，内容行留给用户自填。
//
// 4 sheet：
//   1. 行程安排及费用预算 —— 一天一行 + 分类费用列（动态展开）+ SUM 总计 +
//      与预算对比（对应 manual-outline.md 第 2/7 章）
//   2. 每日详细行程 —— 逐条 item 一行（对应第 3 章，4/5/6 章并入此表列）
//   3. 出行必备自检清单（模板）—— 预置装备清单事项行 + 空白追加行（第 8 章）
//   4. 消费流水及费用核算（模板）—— 示例流水行 + SUMIF 按类别核算，公式引用
//      sheet1 分类小计做预算对比（无对应 manual-outline 章节，纯模板新增）
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

type Kind = ItineraryItem["kind"];

const HEADER_FONT = { bold: true } as const;
const TEMPLATE_TIP_FONT = { italic: true, color: { argb: "FF808080" } } as const;
const EXAMPLE_FONT = { italic: true, color: { argb: "FF999999" } } as const;
const CURRENCY_FMT = '"¥"#,##0.00';
const DATE_FMT = "yyyy-mm-dd";

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = HEADER_FONT;
}

/** ISO 日期字符串（YYYY-MM-DD）→ Date 对象，供 Excel 存为真正的日期单元格
 *  （而不是文本）。用 UTC 正午避免时区导致的跨日问题；调用方必须显式设置
 *  该单元格/列的 numFmt——参考格式规范明确指出「不能假设复制格式会跟着走」。
 */
function toDateValue(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// 费用类目动态展开顺序 + 列名——注意这里是「预算表费用类目」措辞（门票/其他），
// 与 render.ts KIND_LABELS（景点/其他，用于逐日明细的条目类型标签）是两套
// 不同场景的命名，不应合并。
const BUDGET_KIND_ORDER: Kind[] = ["sight", "meal", "hotel", "transit", "other"];
const BUDGET_KIND_LABELS: Record<Kind, string> = {
  sight: "门票",
  meal: "餐饮",
  hotel: "住宿",
  transit: "交通",
  other: "其他",
};

// ---------------------------------------------------------------------------
// Sheet 1：行程安排及费用预算 —— 一天一行 + 动态分类费用列 + SUM 总计 + 与预算对比
// ---------------------------------------------------------------------------

interface BudgetMainResult {
  sheetName: string;
  /** 各费用类目「总计」单元格地址（不含 sheet 名），供 Sheet4 核算区跨表引用 */
  kindTotalCellRef: Partial<Record<Kind, string>>;
}

function buildBudgetMainSheet(workbook: ExcelJS.Workbook, data: ManualData): BudgetMainResult {
  const sheetName = "行程安排及费用预算";
  const sheet = workbook.addWorksheet(sheetName);
  const { overview, budget } = data;

  const kindsUsed = BUDGET_KIND_ORDER.filter((k) => budget.byKind.some((row) => row.kind === k));

  const headers = ["天", "日期", "行程摘要", "住宿地", ...kindsUsed.map((k) => BUDGET_KIND_LABELS[k]), "当日合计"];
  sheet.columns = [
    { width: 6 },
    { width: 14 },
    { width: 40 },
    { width: 20 },
    ...kindsUsed.map(() => ({ width: 14 })),
    { width: 14 },
  ];
  const headerRow = sheet.addRow(headers);
  styleHeaderRow(headerRow);

  const DATE_COL = 2;
  const FIRST_COST_COL = 5;
  const dailyTotalCol = FIRST_COST_COL + kindsUsed.length;

  const dataStartRow = sheet.rowCount + 1;
  overview.forEach((ov, idx) => {
    const dayKind = budget.byDayKind[idx];
    const row: (string | number | Date)[] = [ov.day, toDateValue(ov.date), ov.mainLine, ov.hotel];
    for (const k of kindsUsed) {
      row.push(dayKind?.kindTotals[k] ?? 0);
    }
    row.push(dayKind?.total ?? 0);
    sheet.addRow(row);
  });
  const dataEndRow = sheet.rowCount;

  sheet.getColumn(DATE_COL).numFmt = DATE_FMT;
  for (let c = FIRST_COST_COL; c <= dailyTotalCol; c++) {
    sheet.getColumn(c).numFmt = CURRENCY_FMT;
  }

  // 总计行：每个费用类目列 SUM，末列（当日合计）也 SUM——两者理论上应相等
  const totalRow = sheet.addRow(["", "", "", "总计"]);
  totalRow.font = HEADER_FONT;
  const kindTotalCellRef: Partial<Record<Kind, string>> = {};
  kindsUsed.forEach((k, i) => {
    const col = FIRST_COST_COL + i;
    const colLetter = sheet.getColumn(col).letter;
    const kindRow = budget.byKind.find((row) => row.kind === k);
    const cell = totalRow.getCell(col);
    cell.value = {
      formula: `SUM(${colLetter}${dataStartRow}:${colLetter}${dataEndRow})`,
      result: kindRow?.total ?? 0,
    };
    kindTotalCellRef[k] = `${colLetter}${totalRow.number}`;
  });
  const dailyTotalColLetter = sheet.getColumn(dailyTotalCol).letter;
  const grandTotalCellRef = `${dailyTotalColLetter}${totalRow.number}`;
  totalRow.getCell(dailyTotalCol).value = {
    formula: `SUM(${dailyTotalColLetter}${dataStartRow}:${dailyTotalColLetter}${dataEndRow})`,
    result: budget.grandTotal,
  };

  sheet.addRow([]);
  const compareHeader = sheet.addRow(["与预算对比"]);
  compareHeader.font = HEADER_FONT;
  const budgetRow = sheet.addRow(["预算(¥)", budget.budgetCny]);
  budgetRow.getCell(2).numFmt = CURRENCY_FMT;
  const actualRow = sheet.addRow(["实际总计(¥)"]);
  actualRow.getCell(2).value = { formula: grandTotalCellRef, result: budget.grandTotal };
  actualRow.getCell(2).numFmt = CURRENCY_FMT;
  const diffRow = sheet.addRow(["结余/超支(¥)"]);
  if (budget.budgetCny !== null) {
    diffRow.getCell(2).value = {
      formula: `B${budgetRow.number}-${grandTotalCellRef}`,
      result: budget.diff ?? 0,
    };
  }
  diffRow.getCell(2).numFmt = CURRENCY_FMT;
  sheet.addRow(["是否超支", budget.overBudget ? "是" : "否"]);
  const perPersonRow = sheet.addRow(["人均(¥)", Math.round(budget.perPerson)]);
  perPersonRow.getCell(2).numFmt = CURRENCY_FMT;

  return { sheetName, kindTotalCellRef };
}

// ---------------------------------------------------------------------------
// Sheet 2：每日详细行程 —— 每个 item 一行（4/5/6 章的住宿/交通/餐饮均并入此表）
// ---------------------------------------------------------------------------

function buildDailyDetailsSheet(workbook: ExcelJS.Workbook, data: ManualData): void {
  const sheet = workbook.addWorksheet("每日详细行程");
  sheet.columns = [
    { width: 6 },
    { width: 14 },
    { width: 10 },
    { width: 10 },
    { width: 30 },
    { width: 35 },
    { width: 14 },
  ];

  const headerRow = sheet.addRow(["天", "日期", "时间", "类型", "名称", "备注", "费用(¥)"]);
  styleHeaderRow(headerRow);

  sheet.getColumn(2).numFmt = DATE_FMT;
  sheet.getColumn(7).numFmt = CURRENCY_FMT;

  for (const day of data.dailyDetails) {
    for (const item of day.items) {
      sheet.addRow([
        day.day,
        toDateValue(day.date),
        item.time,
        item.kindLabel,
        item.name,
        item.note,
        item.cost === null ? null : item.cost,
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Sheet 3：出行必备自检清单（模板）—— 预置装备事项行 + 空白追加行
// ---------------------------------------------------------------------------

const CHECKLIST_APPEND_ROWS = 10;

function buildEquipmentChecklistSheet(workbook: ExcelJS.Workbook, data: ManualData): void {
  const sheet = workbook.addWorksheet("出行必备自检清单");
  sheet.columns = [
    { width: 16 }, // 类别
    { width: 36 }, // 事项
    { width: 12 }, // 责任人
    { width: 10 }, // 出发前
    { width: 10 }, // 出行中
  ];

  sheet.mergeCells(1, 1, 1, 5);
  const tipCell = sheet.getCell(1, 1);
  tipCell.value = "模板：以下事项由行程自动推导预置，责任人/勾选请自行填写（出发前/出行中列填 ☑ 表示完成）";
  tipCell.font = TEMPLATE_TIP_FONT;

  const headerRow = sheet.addRow(["类别", "事项", "责任人", "出发前", "出行中"]);
  styleHeaderRow(headerRow);

  for (const category of data.equipment) {
    for (const item of category.items) {
      sheet.addRow([category.category, item, "", "☐", "☐"]);
    }
  }

  // 预留空白行供用户追加自定义事项（不预填类别/事项/勾选，保持真正空白）。
  // 注意：exceljs 对完全不含任何单元格样式/值的行，写盘再读回后会被丢弃
  // （不会真的出现在 xlsx 里），所以这里显式给每格加一条浅色边框，既让这些
  // 预留行在文件中真实存在、可见，也符合「模板」应有的可视化留白观感。
  const APPEND_BORDER: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFD9D9D9" } };
  for (let i = 0; i < CHECKLIST_APPEND_ROWS; i++) {
    const row = sheet.addRow([]);
    for (let c = 1; c <= 5; c++) {
      row.getCell(c).border = { top: APPEND_BORDER, bottom: APPEND_BORDER, left: APPEND_BORDER, right: APPEND_BORDER };
    }
  }
}

// ---------------------------------------------------------------------------
// Sheet 4：消费流水及费用核算（模板）—— 示例流水行 + 类别下拉 + SUMIF 核算
// ---------------------------------------------------------------------------

const CASHFLOW_APPEND_ROWS = 30;
const CASHFLOW_CATEGORIES = ["门票", "餐饮", "住宿", "交通", "购物", "其他"] as const;
// 消费流水类别 → Sheet1 预算类目的映射（“购物”在 itinerary kind 枚举中无对应类目，
// 核算区对该行不引用 Sheet1，直接留 0）
const CASHFLOW_CATEGORY_TO_KIND: Record<(typeof CASHFLOW_CATEGORIES)[number], Kind | null> = {
  门票: "sight",
  餐饮: "meal",
  住宿: "hotel",
  交通: "transit",
  购物: null,
  其他: "other",
};

interface CashflowExampleRow {
  date: Date;
  item: string;
  category: (typeof CASHFLOW_CATEGORIES)[number];
  amount: number;
  payer: string;
  note: string;
}

function buildCashflowSheet(workbook: ExcelJS.Workbook, data: ManualData, budgetMain: BudgetMainResult): void {
  const sheet = workbook.addWorksheet("消费流水及费用核算");
  sheet.columns = [
    { width: 14 }, // 日期
    { width: 26 }, // 项目
    { width: 10 }, // 类别
    { width: 12 }, // 金额
    { width: 12 }, // 付款人
    { width: 30 }, // 备注
  ];

  sheet.mergeCells(1, 1, 1, 6);
  const tipCell = sheet.getCell(1, 1);
  tipCell.value = "模板：灰色斜体为示例行（可删除），请从空白行起自行填写消费流水，下方核算区公式已预置";
  tipCell.font = TEMPLATE_TIP_FONT;

  const headerRow = sheet.addRow(["日期", "项目", "类别", "金额(¥)", "付款人", "备注"]);
  styleHeaderRow(headerRow);

  const firstDay = data.overview[0]?.date ?? data.cover.dateStart;
  const examples: CashflowExampleRow[] = [
    {
      date: toDateValue(firstDay),
      item: "机场打车",
      category: "交通",
      amount: 50,
      payer: "示例",
      note: "示例（不计入核算，可删除）",
    },
    {
      date: toDateValue(firstDay),
      item: "超市采购",
      category: "购物",
      amount: 120,
      payer: "示例",
      note: "示例（不计入核算，可删除）",
    },
  ];

  for (const ex of examples) {
    const row = sheet.addRow([ex.date, ex.item, ex.category, ex.amount, ex.payer, ex.note]);
    row.eachCell((cell) => {
      cell.font = EXAMPLE_FONT;
    });
  }
  // 示例行之后的第一行为实际数据的起始行，确保 SUMIF 公式只计算用户输入的数据，不包含示例行
  const dataStartRow = sheet.rowCount + 1;
  for (let i = 0; i < CASHFLOW_APPEND_ROWS; i++) {
    sheet.addRow([]);
  }
  const dataEndRow = sheet.rowCount;

  sheet.getColumn(1).numFmt = DATE_FMT;
  sheet.getColumn(4).numFmt = CURRENCY_FMT;

  const categoryCol = sheet.getColumn(3).letter;
  const categoryListFormula = `"${CASHFLOW_CATEGORIES.join(",")}"`;
  for (let r = dataStartRow; r <= dataEndRow; r++) {
    sheet.getCell(`${categoryCol}${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [categoryListFormula],
    };
  }

  sheet.addRow([]);
  const acctHeader = sheet.addRow(["费用核算（按类别，公式已预置，仅需填写以上流水行）"]);
  acctHeader.font = HEADER_FONT;
  const acctColHeader = sheet.addRow(["类别", "流水合计(¥)", "预算对应金额(¥)", "差额(¥)"]);
  styleHeaderRow(acctColHeader);

  const amountCol = sheet.getColumn(4).letter;
  for (const category of CASHFLOW_CATEGORIES) {
    // SUMIF 范围已排除示例行，模板初始无用户数据，缓存值即为 0
    const sumifResult = 0;

    const row = sheet.addRow([category]);
    row.getCell(2).value = {
      formula: `SUMIF(${categoryCol}${dataStartRow}:${categoryCol}${dataEndRow},"${category}",${amountCol}${dataStartRow}:${amountCol}${dataEndRow})`,
      result: sumifResult,
    };
    row.getCell(2).numFmt = CURRENCY_FMT;

    const kind = CASHFLOW_CATEGORY_TO_KIND[category];
    const kindCellRef = kind ? budgetMain.kindTotalCellRef[kind] : undefined;
    if (kindCellRef) {
      // 从 Sheet1 预算表查找对应的类目总计值
      const kindRow = data.budget.byKind.find((row) => row.kind === kind);
      const kindTotal = kindRow?.total ?? 0;
      row.getCell(3).value = { formula: `'${budgetMain.sheetName}'!${kindCellRef}`, result: kindTotal };
    } else {
      row.getCell(3).value = 0;
    }
    row.getCell(3).numFmt = CURRENCY_FMT;

    // 差额 = 预算对应金额 - 流水合计，初始结果值为 0（实际数据为空时）
    row.getCell(4).value = { formula: `C${row.number}-B${row.number}`, result: 0 };
    row.getCell(4).numFmt = CURRENCY_FMT;
  }
}

// ---------------------------------------------------------------------------

export interface RunExcelResult {
  path: string;
}

export async function runExcel(tripId: string): Promise<RunExcelResult> {
  const data = buildManualData(tripId);

  const workbook = new ExcelJS.Workbook();
  const budgetMain = buildBudgetMainSheet(workbook, data);
  buildDailyDetailsSheet(workbook, data);
  buildEquipmentChecklistSheet(workbook, data);
  buildCashflowSheet(workbook, data, budgetMain);

  const outDir = path.join(tripDir(tripId), "exports");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${tripId}-路书.xlsx`);
  await workbook.xlsx.writeFile(outPath);

  return { path: outPath };
}

export async function main(argv: string[]): Promise<unknown> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd !== "run") {
    throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 run）`);
  }
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const format = flags.format ?? "xlsx";
  if (format !== "xlsx") {
    throw new CliError(`不支持的 --format: ${format}（本工具仅支持 xlsx，pdf/word 见各自导出工具）`);
  }
  return runExcel(flags.trip);
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
