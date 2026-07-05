import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import { readJson } from "./lib/workspace";
import {
  haversineKm,
  parseDrivingHours,
  HIGH_INTENSITY_KEYWORDS,
  R09_SAME_DAY_THRESHOLD_KM,
  R09_CROSS_DAY_THRESHOLD_KM,
  type LatLng,
} from "./lib/conflict";

// ---------------------------------------------------------------------------
// PILOT check.ts —— itinerary.json 的 schema 校验 + 确定性冲突规则
//
//   validate  ajv 校验 itinerary.json（对话编辑后的 schema 漂移拦截）
//   run       跑 C-01~C-07（W5 原样迁移）+ R-08/R-09（v2 新增）9 条规则，
//             输出违规数组 [{day, rule, severity, detail}]
//
// 规则规范文本的唯一来源：.claude/skills/pilot/references/conflict-rules.md
// （含 W5 字段名 → v4.0 itinerary.schema.json 字段名的映射表）。规则实现与
// 该文件冲突时，以该文件为准。
//
// 所有规则都是纯函数（itinerary/intake → Violation[]），文件 I/O 只在
// runValidate/runRun 里发生，便于对每条规则单独写 fixture 测试。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

export class ValidationError extends CliError {
  details: ErrorObject[];
  constructor(details: ErrorObject[]) {
    super("itinerary 未通过 schema 校验");
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 类型（对应 shared/schema/itinerary.schema.json、intake.schema.json）
// ---------------------------------------------------------------------------

export interface ItineraryItem {
  time: string | null;
  kind: "sight" | "meal" | "hotel" | "transit" | "other";
  name: string;
  note: string;
  geo: LatLng | null;
  cost_cny: number | null;
  booking?: unknown;
}

export interface ItineraryDay {
  day: number;
  date: string;
  source_ref?: unknown;
  items: ItineraryItem[];
}

export interface Itinerary {
  trip_id: string;
  status: string;
  base_travelogue: string;
  days: ItineraryDay[];
  agency_recommendation: unknown;
  conflicts_checked_at: string | null;
}

export interface Intake {
  trip_id: string;
  destination: string;
  dates: { start: string; end: string };
  party: { adults: number; children: number; seniors: number };
  budget_cny: number | null;
  transport: string;
  preferences: string[];
  origin_city: string;
  locale: string;
}

export interface Violation {
  day: number;
  rule: string;
  severity: "warn";
  detail: string;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

const SCHEMA_PATH = path.resolve(__dirname, "../shared/schema/itinerary.schema.json");
const ajv = new Ajv({ strict: false, allErrors: true });
let itineraryValidator: ValidateFunction | null = null;

function getItineraryValidator(): ValidateFunction {
  if (!itineraryValidator) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    itineraryValidator = ajv.compile(schema);
  }
  return itineraryValidator;
}

export function runValidate(tripId: string): { ok: true } {
  const data = readJson<unknown>(tripId, "itinerary.json");
  const validate = getItineraryValidator();
  if (!validate(data)) {
    throw new ValidationError(validate.errors ?? []);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 规则实现（C-01~C-07 W5 原样迁移 + R-08/R-09 v2 新增）
// 规则文本见 .claude/skills/pilot/references/conflict-rules.md
// ---------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** C-01：单日驾车时间超限（>4h）。驾车时长从当日 transit 条目 note 文本解析并累加。 */
export function checkC01(itinerary: Itinerary): Violation[] {
  const violations: Violation[] = [];
  for (const day of itinerary.days) {
    const hours = day.items
      .filter((item) => item.kind === "transit")
      .map((item) => parseDrivingHours(item.note))
      .filter((h): h is number => h !== null)
      .reduce((sum, h) => sum + h, 0);
    if (hours > 4) {
      violations.push({
        day: day.day,
        rule: "C-01",
        severity: "warn",
        detail: `第${day.day}天驾车时间约${round1(hours)}小时，超过安全建议的4小时。建议：拆分为两天，或删减沿途景点减少绕路。`,
      });
    }
  }
  return violations;
}

/** C-02：时间反转。v4 每条目单时间点，"反转" = 同日后一条目 time 早于前一条目 time（null 跳过）。 */
export function checkC02(itinerary: Itinerary): Violation[] {
  const violations: Violation[] = [];
  for (const day of itinerary.days) {
    let prev: ItineraryItem | null = null;
    for (const item of day.items) {
      if (item.time === null) continue;
      if (prev !== null && prev.time !== null && item.time < prev.time) {
        violations.push({
          day: day.day,
          rule: "C-02",
          severity: "warn",
          detail: `第${day.day}天「${prev.name}」时间 ${prev.time} 晚于「${item.name}」时间 ${item.time}，顺序颠倒。建议：调整时间顺序，或删除其中一个景点。`,
        });
      }
      prev = item;
    }
  }
  return violations;
}

const NON_SPARSE_KINDS = new Set(["sight", "meal", "other"]);

/** C-03：单日景点过多（>6，不含 transit/hotel）。 */
export function checkC03(itinerary: Itinerary): Violation[] {
  const violations: Violation[] = [];
  for (const day of itinerary.days) {
    const count = day.items.filter((item) => NON_SPARSE_KINDS.has(item.kind)).length;
    if (count > 6) {
      violations.push({
        day: day.day,
        rule: "C-03",
        severity: "warn",
        detail: `第${day.day}天有 ${count} 个景点，行程过于密集。建议：删减到 4-5 个景点，或拆分到相邻天。`,
      });
    }
  }
  return violations;
}

/** C-04：住宿缺失。检查非首日/非末日（按 days 数组位置，首=index 0，末=最后一项）。 */
export function checkC04(itinerary: Itinerary): Violation[] {
  const violations: Violation[] = [];
  const days = itinerary.days;
  days.forEach((day, idx) => {
    if (idx === 0 || idx === days.length - 1) return;
    const hasHotel = day.items.some((item) => item.kind === "hotel");
    if (!hasHotel) {
      violations.push({
        day: day.day,
        rule: "C-04",
        severity: "warn",
        detail: `第${day.day}天没有安排住宿。建议：在当天最后添加住宿点。`,
      });
    }
  });
  return violations;
}

function computeIntakeDays(dates: { start: string; end: string }): number {
  const start = new Date(`${dates.start}T00:00:00`);
  const end = new Date(`${dates.end}T00:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

/**
 * C-05：总天数不匹配。itinerary.days.length 与 intake.dates 推算天数（含首尾）不一致。
 * 该冲突不属于任何一个具体天，用 day: 0 作为"整体行程"哨兵值（其余 8 条规则
 * 的 day 均指向具体的某一天）。
 */
export function checkC05(itinerary: Itinerary, intake: Intake): Violation[] {
  const expected = computeIntakeDays(intake.dates);
  const actual = itinerary.days.length;
  if (expected === actual) return [];
  return [
    {
      day: 0,
      rule: "C-05",
      severity: "warn",
      detail: `用户要求 ${expected} 天，但当前行程有 ${actual} 天。建议：${
        actual < expected ? "增加" : "删减"
      }天数以匹配需求。`,
    },
  ];
}

/** C-06：首日出发时间过早（第一天第一个景点条目的 time 早于 09:00）。
 *  注：「第一个景点」= 首日首个 kind="sight" 条目；transit/hotel 不算。
 *  2026-07-05 主控裁定：避免误报首日交通条目（如 07:00 transit）。
 */
export function checkC06(itinerary: Itinerary): Violation[] {
  const firstDay = itinerary.days[0];
  if (!firstDay || firstDay.items.length === 0) return [];
  // 寻找首日第一个 kind="sight" 的条目
  const firstSight = firstDay.items.find((item) => item.kind === "sight");
  if (!firstSight || firstSight.time === null) return [];
  if (firstSight.time < "09:00") {
    return [
      {
        day: firstDay.day,
        rule: "C-06",
        severity: "warn",
        detail: `第1天首个景点安排在 ${firstSight.time}，到达目的地后可能来不及。建议：调整到 10:00 之后，或把该景点移到第二天。`,
      },
    ];
  }
  return [];
}

/** C-07：同行人群适配。intake.party.seniors>0 且条目 name/note 命中高强度关键词。 */
export function checkC07(itinerary: Itinerary, intake: Intake): Violation[] {
  if (intake.party.seniors <= 0) return [];
  const violations: Violation[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const text = `${item.name}${item.note}`;
      if (HIGH_INTENSITY_KEYWORDS.some((kw) => text.includes(kw))) {
        violations.push({
          day: day.day,
          rule: "C-07",
          severity: "warn",
          detail: `第${day.day}天行程包含「${item.name}」，可能不适合同行老人。建议：替换为强度较低的替代景点。`,
        });
      }
    }
  }
  return violations;
}

/**
 * R-08：单日花费超预算基线（Σcost_cny > intake.budget_cny / 行程天数 × 3）。
 * budget_cny 为 null 时跳过。"行程天数" 取 itinerary.days.length（当前实际
 * 行程的天数，而非 intake.dates 推算的用户声明天数——日均基线应对齐正在
 * 被检查的这份行程本身；两者不一致时 C-05 会单独报出）。
 */
export function checkR08(itinerary: Itinerary, intake: Intake): Violation[] {
  if (intake.budget_cny === null) return [];
  const totalDays = itinerary.days.length;
  if (totalDays === 0) return [];
  const baseline = intake.budget_cny / totalDays;
  const threshold = baseline * 3;
  const violations: Violation[] = [];
  for (const day of itinerary.days) {
    const spent = day.items.reduce((sum, item) => sum + (item.cost_cny ?? 0), 0);
    if (spent > threshold) {
      violations.push({
        day: day.day,
        rule: "R-08",
        severity: "warn",
        detail: `第${day.day}天预计花费 ¥${spent}，超过日均预算基线（¥${Math.round(baseline)}）的 3 倍。建议：更换高消费条目，或与用户确认预算是否需要上调。`,
      });
    }
  }
  return violations;
}

/**
 * R-09：坐标直线距离异常（2026-07-05 主控裁定扩展跨天检测）。
 *   - 同日内：相邻（按当日 geo 非 null 条目在原顺序中的相邻关系）直线距离 > 300km。
 *   - 跨天：第 N 天最后一个有 geo 的条目 → 第 N+1 天第一个有 geo 的条目，直线
 *     距离 > 600km（跨天含正常长途驾驶日，阈值比同日内更宽松）。对话编辑常
 *     造成跨天拼接的坐标错误，同日检测覆盖不到这种情况。
 */
export function checkR09(itinerary: Itinerary): Violation[] {
  const violations: Violation[] = [];
  const geoItemsByDay = itinerary.days.map((day) => ({
    day,
    geoItems: day.items.filter(
      (item): item is ItineraryItem & { geo: LatLng } => item.geo !== null,
    ),
  }));

  // 同日内相邻 geo 条目
  for (const { day, geoItems } of geoItemsByDay) {
    for (let i = 1; i < geoItems.length; i++) {
      const dist = haversineKm(geoItems[i - 1].geo, geoItems[i].geo);
      if (dist > R09_SAME_DAY_THRESHOLD_KM) {
        violations.push({
          day: day.day,
          rule: "R-09",
          severity: "warn",
          detail: `第${day.day}天「${geoItems[i - 1].name}」→「${geoItems[i].name}」直线距离约 ${Math.round(
            dist,
          )}km（>${R09_SAME_DAY_THRESHOLD_KM}km），坐标疑似错误。建议：核对两点经纬度（geo 坐标必须来自 WebFetch 查证，禁止凭记忆填写）；确认无误则说明行程本身跨度过大。`,
        });
      }
    }
  }

  // 跨天：第 N 天最后一个有 geo 的条目 → 第 N+1 天第一个有 geo 的条目
  for (let i = 1; i < geoItemsByDay.length; i++) {
    const prevGeo = geoItemsByDay[i - 1].geoItems;
    const currGeo = geoItemsByDay[i].geoItems;
    if (prevGeo.length === 0 || currGeo.length === 0) continue;
    const lastPrev = prevGeo[prevGeo.length - 1];
    const firstCurr = currGeo[0];
    const dist = haversineKm(lastPrev.geo, firstCurr.geo);
    if (dist > R09_CROSS_DAY_THRESHOLD_KM) {
      const prevDayNum = geoItemsByDay[i - 1].day.day;
      const currDayNum = geoItemsByDay[i].day.day;
      violations.push({
        day: currDayNum,
        rule: "R-09",
        severity: "warn",
        detail: `第${prevDayNum}天「${lastPrev.name}」→第${currDayNum}天「${firstCurr.name}」跨天直线距离约 ${Math.round(
          dist,
        )}km（>${R09_CROSS_DAY_THRESHOLD_KM}km），坐标疑似错误。建议：核对两点经纬度（geo 坐标必须来自 WebFetch 查证，禁止凭记忆填写）；确认无误则说明行程本身跨度过大（长途转场日）。`,
      });
    }
  }

  return violations;
}

/** 9 条规则全跑，按 C-01~C-07、R-08、R-09 的顺序拼接输出。 */
export function runRun(tripId: string): Violation[] {
  const itinerary = readJson<Itinerary>(tripId, "itinerary.json");
  const intake = readJson<Intake>(tripId, "intake.json");
  return [
    ...checkC01(itinerary),
    ...checkC02(itinerary),
    ...checkC03(itinerary),
    ...checkC04(itinerary),
    ...checkC05(itinerary, intake),
    ...checkC06(itinerary),
    ...checkC07(itinerary, intake),
    ...checkR08(itinerary, intake),
    ...checkR09(itinerary),
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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

export function main(argv: string[]): unknown {
  const { cmd, flags } = parseArgs(argv);
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const tripId = flags.trip;

  switch (cmd) {
    case "validate":
      return runValidate(tripId);
    case "run":
      return runRun(tripId);
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 validate/run）`);
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`${JSON.stringify({ error: err.message, details: err.details })}\n`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  }
}
