import path from "node:path";
import { existsSync } from "node:fs";
import { tripDir, readJson } from "../../lib/workspace";

// ---------------------------------------------------------------------------
// PILOT export/lib/render.ts —— itinerary + intake → 穷游手册九章节数据对象
//
// buildManualData(tripId) 是 PDF/Excel/Word 三个渲染器共用的数据层
// （Task 13/14/15）。章节结构与字段来源以
// .claude/skills/pilot/references/manual-outline.md 为准，本文件是该基准的
// 唯一实现——三渲染器不得各自重复解析 itinerary/intake。
//
// 装备清单（第8章）/ 应急信息（第9章）在 itinerary schema（冻结，
// additionalProperties=false）里没有对应字段，由本文件用内置规则模板从
// intake 推导，不依赖 AI 生成（见 buildEquipment / buildEmergency）。
//
// 交通汇总（第5章）的口径选择：大交通（longHaul）取「首日」与「末日」的
// transit 条目（对应去程/返程航班或车次）；每日路段（dailySegments）取
// 「中间天」的 transit 条目（沿途换乘/驾车路段），二者不重叠。若行程只有
// 1 天，则该天 transit 全部计入 longHaul，dailySegments 为空。
// ---------------------------------------------------------------------------

export class RenderError extends Error {}

// ---------------------------------------------------------------------------
// 输入数据类型（对应 shared/schema/itinerary.schema.json / intake.schema.json）
// ---------------------------------------------------------------------------

export interface AltRecommendation {
  name: string;
  reason: string;
  url: string | null;
  affiliate_url: string | null;
}

export interface ItineraryBooking {
  type: string;
  name: string;
  url: string | null;
  affiliate_url: string | null;
  alt_recommendation: AltRecommendation | null;
}

export interface ItineraryItem {
  time: string | null;
  kind: "sight" | "meal" | "hotel" | "transit" | "other";
  name: string;
  note: string;
  geo: { lat: number; lng: number } | null;
  cost_cny: number | null;
  booking?: ItineraryBooking | null;
}

export interface ItineraryDay {
  day: number;
  date: string;
  source_ref?: { travelogue_id: string; day: number } | null;
  items: ItineraryItem[];
}

export interface Itinerary {
  trip_id: string;
  status: "draft" | "confirmed" | "detailed";
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

export interface TravelogueIndexEntry {
  id: string;
  brief: string;
  tags: string[];
  total: number;
  url: string;
  days_count?: number;
}

// ---------------------------------------------------------------------------
// 输出：ManualData（九章节 + 参考游记附录）
// ---------------------------------------------------------------------------

export interface CoverData {
  title: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  totalDays: number;
  partyLabel: string;
  originCity: string;
  tripId: string;
  generatedAt: string;
}

export interface OverviewRow {
  day: number;
  date: string;
  mainLine: string;
  hotel: string;
  sourceLabel: string;
}

export interface DailyDetailItem {
  time: string;
  kind: ItineraryItem["kind"];
  kindLabel: string;
  name: string;
  note: string;
  geoLabel: string | null;
  cost: number | null;
  costLabel: string;
  bookingName: string | null;
  bookingUrl: string | null;
  /** item 级额外推荐（booking.alt_recommendation 非 null 时呈现，链接口径 affiliate_url 优先） */
  alt: { name: string; reason: string; url: string | null } | null;
}

export interface DailyDetailDay {
  day: number;
  date: string;
  items: DailyDetailItem[];
}

export interface HotelRow {
  date: string;
  name: string;
  note: string;
  cost: number | null;
  bookingUrl: string | null;
}

export interface HotelsData {
  rows: HotelRow[];
  subtotal: number;
}

export interface TransportSegment {
  day: number;
  date: string;
  name: string;
  note: string;
  cost: number | null;
  bookingName: string | null;
}

export interface TransportData {
  modeLabel: string;
  longHaul: TransportSegment[];
  dailySegments: TransportSegment[];
  carRentalNotes: TransportSegment[];
}

export interface MealItem {
  name: string;
  note: string;
  cost: number | null;
}

export interface MealDayGroup {
  day: number;
  date: string;
  items: MealItem[];
}

export interface BudgetKindRow {
  kind: ItineraryItem["kind"];
  kindLabel: string;
  total: number;
}

export interface BudgetDayRow {
  day: number;
  date: string;
  total: number;
}

/** Task 18 新增（additive）：逐日 × 分类费用矩阵，供 Excel Sheet1「行程安排及费用预算」动态展开分类费用列使用 */
export interface BudgetDayKindRow {
  day: number;
  date: string;
  kindTotals: Partial<Record<ItineraryItem["kind"], number>>;
  total: number;
}

export interface BudgetData {
  byKind: BudgetKindRow[];
  byDay: BudgetDayRow[];
  /** Task 18 新增（additive） */
  byDayKind: BudgetDayKindRow[];
  grandTotal: number;
  budgetCny: number | null;
  diff: number | null;
  overBudget: boolean;
  perPerson: number;
  uncountedItemCount: number;
}

export interface EquipmentCategory {
  category: string;
  items: string[];
}

export interface EmergencyData {
  generalNumbers: { label: string; number: string }[];
  destinationNotes: string[];
  insurance: string[];
  backupInfo: string;
}

export interface ManualData {
  tripId: string;
  cover: CoverData;
  overview: OverviewRow[];
  dailyDetails: DailyDetailDay[];
  hotels: HotelsData;
  transport: TransportData;
  meals: MealDayGroup[];
  budget: BudgetData;
  equipment: EquipmentCategory[];
  emergency: EmergencyData;
  travelogues: TravelogueIndexEntry[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<ItineraryItem["kind"], string> = {
  sight: "景点",
  meal: "餐饮",
  hotel: "住宿",
  transit: "交通",
  other: "其他",
};

const TRANSPORT_LABELS: Record<string, string> = {
  "self-drive": "自驾",
  public: "公共交通",
  mixed: "混合",
};

function partyLabel(party: Intake["party"]): string {
  const parts: string[] = [];
  if (party.adults > 0) parts.push(`${party.adults}大人`);
  if (party.children > 0) parts.push(`${party.children}小孩`);
  if (party.seniors > 0) parts.push(`${party.seniors}老人`);
  return parts.length > 0 ? parts.join("") : "无出行人信息";
}

function partyCount(party: Intake["party"]): number {
  return party.adults + party.children + party.seniors;
}

/** 起止日期含首尾的总天数 */
function countDaysInclusive(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((endMs - startMs) / 86400000) + 1;
}

function costLabel(cost: number | null): string {
  return cost === null ? "—" : `¥${cost}`;
}

// ---------------------------------------------------------------------------
// 章节构建函数（每个都是纯函数，itinerary/intake → 该章节数据）
// ---------------------------------------------------------------------------

function buildCover(intake: Intake, itinerary: Itinerary): CoverData {
  const totalDays = countDaysInclusive(intake.dates.start, intake.dates.end);
  const modeLabel = TRANSPORT_LABELS[intake.transport] ?? intake.transport;
  return {
    title: `${intake.destination} ${totalDays}天${modeLabel}路书`,
    destination: intake.destination,
    dateStart: intake.dates.start,
    dateEnd: intake.dates.end,
    totalDays,
    partyLabel: partyLabel(intake.party),
    originCity: intake.origin_city,
    tripId: itinerary.trip_id,
    generatedAt: new Date().toISOString(),
  };
}

function buildOverview(itinerary: Itinerary): OverviewRow[] {
  return itinerary.days.map((day) => {
    const sights = day.items.filter((item) => item.kind === "sight");
    const mainLine = sights.length > 0 ? sights.map((s) => s.name).join(" → ") : "—";
    const hotelItem = day.items.find((item) => item.kind === "hotel");
    const sourceLabel = day.source_ref
      ? `游记 ${day.source_ref.travelogue_id} 第${day.source_ref.day}天`
      : "自定";
    return {
      day: day.day,
      date: day.date,
      mainLine,
      hotel: hotelItem ? hotelItem.name : "—",
      sourceLabel,
    };
  });
}

function buildDailyDetails(itinerary: Itinerary): DailyDetailDay[] {
  return itinerary.days.map((day) => ({
    day: day.day,
    date: day.date,
    items: day.items.map((item) => ({
      time: item.time ?? "待定",
      kind: item.kind,
      kindLabel: KIND_LABELS[item.kind],
      name: item.name,
      note: item.note,
      geoLabel: item.geo ? `${item.geo.lat}, ${item.geo.lng}` : null,
      cost: item.cost_cny,
      costLabel: costLabel(item.cost_cny),
      bookingName: item.booking?.name ?? null,
      // SKILL ⑧ 预订链接口径：affiliate_url 存在时一律用它替代裸链接
      bookingUrl: item.booking?.affiliate_url ?? item.booking?.url ?? null,
      alt: item.booking?.alt_recommendation
        ? {
            name: item.booking.alt_recommendation.name,
            reason: item.booking.alt_recommendation.reason,
            url:
              item.booking.alt_recommendation.affiliate_url ??
              item.booking.alt_recommendation.url ??
              null,
          }
        : null,
    })),
  }));
}

function buildHotels(itinerary: Itinerary): HotelsData {
  const rows: HotelRow[] = [];
  let subtotal = 0;
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== "hotel") continue;
      rows.push({
        date: day.date,
        name: item.name,
        note: item.note,
        cost: item.cost_cny,
        bookingUrl: item.booking?.affiliate_url ?? item.booking?.url ?? null,
      });
      if (item.cost_cny !== null) subtotal += item.cost_cny;
    }
  }
  return { rows, subtotal };
}

function buildTransport(intake: Intake, itinerary: Itinerary): TransportData {
  const modeLabel = TRANSPORT_LABELS[intake.transport] ?? intake.transport;
  const longHaul: TransportSegment[] = [];
  const dailySegments: TransportSegment[] = [];
  const carRentalNotes: TransportSegment[] = [];

  const lastIndex = itinerary.days.length - 1;
  itinerary.days.forEach((day, idx) => {
    const isEndpoint = idx === 0 || idx === lastIndex;
    for (const item of day.items) {
      if (item.booking?.type === "car") {
        carRentalNotes.push({
          day: day.day,
          date: day.date,
          name: item.name,
          note: item.note,
          cost: item.cost_cny,
          bookingName: item.booking?.name ?? null,
        });
      }
      if (item.kind !== "transit") continue;
      const segment: TransportSegment = {
        day: day.day,
        date: day.date,
        name: item.name,
        note: item.note,
        cost: item.cost_cny,
        bookingName: item.booking?.name ?? null,
      };
      if (isEndpoint) {
        longHaul.push(segment);
      } else {
        dailySegments.push(segment);
      }
    }
  });

  return { modeLabel, longHaul, dailySegments, carRentalNotes };
}

function buildMeals(itinerary: Itinerary): MealDayGroup[] {
  const groups: MealDayGroup[] = [];
  for (const day of itinerary.days) {
    const items = day.items
      .filter((item) => item.kind === "meal")
      .map((item) => ({ name: item.name, note: item.note, cost: item.cost_cny }));
    if (items.length === 0) continue;
    groups.push({ day: day.day, date: day.date, items });
  }
  return groups;
}

function buildBudget(intake: Intake, itinerary: Itinerary): BudgetData {
  const kindTotals = new Map<ItineraryItem["kind"], number>();
  const dayTotals: BudgetDayRow[] = [];
  const dayKindTotals: BudgetDayKindRow[] = [];
  let grandTotal = 0;
  let uncountedItemCount = 0;

  for (const day of itinerary.days) {
    let dayTotal = 0;
    const kindTotalsForDay: Partial<Record<ItineraryItem["kind"], number>> = {};
    for (const item of day.items) {
      if (item.cost_cny === null) {
        uncountedItemCount += 1;
        continue;
      }
      kindTotals.set(item.kind, (kindTotals.get(item.kind) ?? 0) + item.cost_cny);
      kindTotalsForDay[item.kind] = (kindTotalsForDay[item.kind] ?? 0) + item.cost_cny;
      dayTotal += item.cost_cny;
      grandTotal += item.cost_cny;
    }
    dayTotals.push({ day: day.day, date: day.date, total: dayTotal });
    dayKindTotals.push({ day: day.day, date: day.date, kindTotals: kindTotalsForDay, total: dayTotal });
  }

  const byKind: BudgetKindRow[] = (["sight", "hotel", "transit", "meal", "other"] as const)
    .filter((kind) => kindTotals.has(kind))
    .map((kind) => ({ kind, kindLabel: KIND_LABELS[kind], total: kindTotals.get(kind) ?? 0 }));

  const budgetCny = intake.budget_cny;
  const diff = budgetCny !== null ? budgetCny - grandTotal : null;
  const people = partyCount(intake.party);
  const perPerson = people > 0 ? grandTotal / people : 0;

  return {
    byKind,
    byDay: dayTotals,
    byDayKind: dayKindTotals,
    grandTotal,
    budgetCny,
    diff,
    overBudget: diff !== null && diff < 0,
    perPerson,
    uncountedItemCount,
  };
}

/** 第8章：装备清单——itinerary schema 无对应字段，纯规则模板从 intake 推导 */
function buildEquipment(intake: Intake): EquipmentCategory[] {
  const categories: EquipmentCategory[] = [
    {
      category: "证件",
      items: ["身份证", "驾照（自驾必备）", "行程确认单/订单截图"],
    },
    {
      category: "充电",
      items: ["充电宝", "手机/相机充电线", "车载充电器"],
    },
    {
      category: "药品",
      items: ["感冒药", "肠胃药", "创可贴/纱布", "常用外伤药"],
    },
  ];

  const startMonth = Number(intake.dates.start.slice(5, 7));
  if ([6, 7, 8].includes(startMonth)) {
    categories.push({
      category: "季节衣物（夏季）",
      items: ["防晒霜/墨镜/遮阳帽", "薄外套或冲锋衣（昼夜温差大）", "速干衣裤"],
    });
  } else if ([12, 1, 2].includes(startMonth)) {
    categories.push({
      category: "季节衣物（冬季）",
      items: ["羽绒服/保暖内衣", "防滑鞋", "护手霜/润唇膏"],
    });
  } else {
    categories.push({
      category: "季节衣物（春秋）",
      items: ["洋葱式穿衣搭配", "薄外套备用"],
    });
  }

  if (intake.transport === "self-drive") {
    categories.push({
      category: "自驾车用品",
      items: ["行车记录仪", "拖车绳", "备用油桶/油壶", "车载充气泵"],
    });
  }

  if (intake.party.children > 0) {
    categories.push({
      category: "儿童用品",
      items: ["湿巾", "儿童零食", "儿童常用退烧/止泻药", "安全座椅（如自驾）"],
    });
  }

  if (intake.party.seniors > 0) {
    categories.push({
      category: "老人用品",
      items: ["常备慢性病药品", "血压计（如需要）", "护腰/护膝"],
    });
  }

  if (intake.preferences.includes("摄影")) {
    categories.push({
      category: "摄影器材",
      items: ["相机+备用电池", "存储卡", "三脚架", "镜头滤镜"],
    });
  }

  return categories;
}

/** 第9章：应急信息——itinerary schema 无对应字段，纯规则模板从 intake.destination 推导 */
function buildEmergency(intake: Intake, tripId: string): EmergencyData {
  const generalNumbers =
    intake.locale === "zh"
      ? [
          { label: "匪警", number: "110" },
          { label: "急救", number: "120" },
          { label: "交通事故", number: "122" },
          { label: "火警", number: "119" },
        ]
      : [{ label: "提示", number: "V1 仅支持中文 locale，海外紧急电话请自行查询目的地国家" }];

  const destinationNotes: string[] = intake.destination.includes("新疆")
    ? [
        "部分边境区域（如喀纳斯、霍尔果斯等口岸周边）需办理边防证方可进入",
        "北疆部分区域（如独库公路沿线）信号盲区较多，建议提前下载离线地图",
        "国道加油站间距可能超过 100 公里，自驾建议保持油量过半",
      ]
    : ["请提前了解目的地当地治安、天气与路况信息"];

  const insurance =
    intake.transport === "self-drive"
      ? ["建议购买涵盖自驾场景的旅行意外险", "全国道路救援统一电话 12122（不含拖车费用，视保险覆盖情况而定）"]
      : ["建议购买涵盖行程全程的旅行意外险"];

  const backupInfo = `行程数据保存在 ~/.pilot/workspace/${tripId}/itinerary.json，本路书文件位于 ~/.pilot/workspace/${tripId}/exports/ 目录下`;

  return { generalNumbers, destinationNotes, insurance, backupInfo };
}

// ---------------------------------------------------------------------------
// buildManualData —— 唯一对外入口
// ---------------------------------------------------------------------------

export function buildManualData(tripId: string): ManualData {
  const dir = tripDir(tripId);

  const itineraryPath = path.join(dir, "itinerary.json");
  if (!existsSync(itineraryPath)) {
    throw new RenderError(
      `itinerary.json 不存在（${itineraryPath}）——导出必须在行程确认后进行，请先完成行程细化`
    );
  }
  const itinerary = readJson<Itinerary>(tripId, "itinerary.json");
  if (itinerary.status === "draft") {
    throw new RenderError(
      `行程状态为 draft（尚未确认）——导出必须在行程 confirmed/detailed 后进行`
    );
  }

  const intake = readJson<Intake>(tripId, "intake.json");

  let travelogues: TravelogueIndexEntry[] = [];
  const indexPath = path.join(dir, "travelogues", "index.json");
  if (existsSync(indexPath)) {
    travelogues = readJson<TravelogueIndexEntry[]>(tripId, "travelogues/index.json");
  }

  return {
    tripId,
    cover: buildCover(intake, itinerary),
    overview: buildOverview(itinerary),
    dailyDetails: buildDailyDetails(itinerary),
    hotels: buildHotels(itinerary),
    transport: buildTransport(intake, itinerary),
    meals: buildMeals(itinerary),
    budget: buildBudget(intake, itinerary),
    equipment: buildEquipment(intake),
    emergency: buildEmergency(intake, tripId),
    travelogues,
  };
}
