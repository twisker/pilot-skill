import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, writeJson } from "../lib/workspace";
import {
  main,
  runValidate,
  runRun,
  ValidationError,
  CliError,
  type Itinerary,
  type Intake,
} from "../check";
import { haversineKm, parseDrivingHours, HIGH_INTENSITY_KEYWORDS } from "../lib/conflict";

// ---------------------------------------------------------------------------
// fixtures —— 1 条全通过基线 itinerary/intake，每条规则从基线深拷贝后
// 只改动触发该规则所需的最小字段，避免互相污染（每条规则测试断言恰好命中该规则）。
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function baseIntake(): Intake {
  return {
    trip_id: "xinjiang-20260726",
    destination: "新疆",
    dates: { start: "2026-07-26", end: "2026-07-28" }, // 含首尾 = 3 天
    party: { adults: 2, children: 0, seniors: 0 },
    budget_cny: 3000,
    transport: "self-drive",
    preferences: [],
    origin_city: "上海",
    locale: "zh",
  };
}

function baseItinerary(): Itinerary {
  return {
    trip_id: "xinjiang-20260726",
    status: "detailed",
    base_travelogue: "t1",
    agency_recommendation: null,
    conflicts_checked_at: null,
    days: [
      {
        day: 1,
        date: "2026-07-26",
        items: [
          {
            time: "10:00",
            kind: "sight",
            name: "天山天池",
            note: "游览",
            geo: { lat: 43.88, lng: 88.13 },
            cost_cny: 100,
            booking: null,
          },
          {
            time: "18:00",
            kind: "hotel",
            name: "乌鲁木齐酒店",
            note: "入住",
            geo: null,
            cost_cny: 300,
            booking: null,
          },
        ],
      },
      {
        day: 2,
        date: "2026-07-27",
        items: [
          {
            time: "09:00",
            kind: "transit",
            name: "驱车前往喀纳斯",
            note: "驾车约3小时",
            geo: null,
            cost_cny: null,
            booking: null,
          },
          {
            time: "13:00",
            kind: "sight",
            name: "喀纳斯湖",
            note: "游览",
            geo: { lat: 48.75, lng: 87.02 },
            cost_cny: 200,
            booking: null,
          },
          {
            time: "19:00",
            kind: "hotel",
            name: "喀纳斯酒店",
            note: "入住",
            geo: null,
            cost_cny: 300,
            booking: null,
          },
        ],
      },
      {
        day: 3,
        date: "2026-07-28",
        items: [
          {
            time: "10:00",
            kind: "sight",
            name: "禾木村",
            note: "游览",
            geo: { lat: 48.62, lng: 86.98 },
            cost_cny: 100,
            booking: null,
          },
        ],
      },
    ],
  };
}

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-check-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("xinjiang");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

function setup(itinerary: Itinerary, intake: Intake = baseIntake()) {
  writeJson(tripId, "intake.json", intake);
  writeJson(tripId, "itinerary.json", itinerary);
}

// ---------------------------------------------------------------------------
// 全通过基线
// ---------------------------------------------------------------------------

describe("run —— 全通过基线", () => {
  it("基线 itinerary 无任何冲突", () => {
    setup(baseItinerary());
    expect(runRun(tripId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9 条规则 —— 各 1 条违规 fixture
// ---------------------------------------------------------------------------

describe("C-01 单日驾车时间超限", () => {
  it("第2天 transit note 解析出 5.5 小时 > 4 小时 → 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[1].items[0].note = "全程驾车约5.5小时";
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 2, rule: "C-01", severity: "warn" });
    expect(conflicts[0].detail).toContain("5.5");
  });
});

describe("C-02 时间反转", () => {
  it("第2天「喀纳斯湖」时间早于前一条目「驱车前往喀纳斯」→ 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[1].items[1].time = "08:00"; // 早于前一条目 09:00
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 2, rule: "C-02", severity: "warn" });
  });
});

describe("C-03 单日景点过多", () => {
  it("第1天景点数达到 7 个（>6）→ 违规", () => {
    const itinerary = clone(baseItinerary());
    const extras = Array.from({ length: 6 }, (_, i) => ({
      time: `10:${String(10 + i * 10).padStart(2, "0")}`,
      kind: "sight" as const,
      name: `景点${i + 2}`,
      note: "游览",
      geo: null,
      cost_cny: null,
      booking: null,
    }));
    // 插在首个景点之后、住宿之前，保持时间递增
    itinerary.days[0].items.splice(1, 0, ...extras);
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 1, rule: "C-03", severity: "warn" });
    expect(conflicts[0].detail).toContain("7");
  });
});

describe("C-04 住宿缺失", () => {
  it("第2天（非首非末）没有 kind=hotel 条目 → 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[1].items = itinerary.days[1].items.filter((item) => item.kind !== "hotel");
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 2, rule: "C-04", severity: "warn" });
  });
});

describe("C-05 总天数不匹配", () => {
  it("intake 要求 3 天，itinerary 只有 2 天 → 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days = itinerary.days.slice(0, 2);
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 0, rule: "C-05", severity: "warn" });
    expect(conflicts[0].detail).toContain("3");
    expect(conflicts[0].detail).toContain("2");
  });
});

describe("C-06 首日出发时间过早", () => {
  it("第1天首个景点条目 07:30 早于 09:00 → 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[0].items[0].time = "07:30";
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 1, rule: "C-06", severity: "warn" });
  });

  it("第1天 07:00 transit + 10:00 sight → 不触发 C-06（仅检查景点）", () => {
    const itinerary = clone(baseItinerary());
    // 在首个景点前插入一条 07:00 的交通条目
    itinerary.days[0].items.unshift({
      time: "07:00",
      kind: "transit",
      name: "前往出发点",
      note: "驾车约1小时",
      geo: null,
      cost_cny: null,
      booking: null,
    });
    setup(itinerary);
    const conflicts = runRun(tripId);
    // 现在第一个 sight 是 10:00，不应触发 C-06
    expect(conflicts.some((c) => c.rule === "C-06")).toBe(false);
  });

  it("第1天 07:00 transit + 08:00 sight → 触发 C-06（day 1）", () => {
    const itinerary = clone(baseItinerary());
    // 在首个景点前插入一条交通条目，并把景点时间改为 08:00
    itinerary.days[0].items.unshift({
      time: "07:00",
      kind: "transit",
      name: "前往出发点",
      note: "驾车约1小时",
      geo: null,
      cost_cny: null,
      booking: null,
    });
    itinerary.days[0].items[1].time = "08:00"; // 修改现在的第二个条目（原首个景点）
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 1, rule: "C-06", severity: "warn" });
  });
});

describe("C-07 同行人群适配", () => {
  it("seniors>0 且条目含高强度关键词「徒步」→ 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[2].items[0].note = "徒步穿越禾木原始森林";
    const intake = { ...baseIntake(), party: { adults: 2, children: 0, seniors: 2 } };
    setup(itinerary, intake);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 3, rule: "C-07", severity: "warn" });
    expect(conflicts[0].detail).toContain("禾木村");
  });

  it("seniors=0 时即使含关键词也不触发", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[2].items[0].note = "徒步穿越禾木原始森林";
    setup(itinerary); // baseIntake() 的 seniors=0
    const conflicts = runRun(tripId);
    expect(conflicts.some((c) => c.rule === "C-07")).toBe(false);
  });
});

describe("R-08 单日预算超基线 3 倍", () => {
  it("预算 3000/3天=1000，第1天花费 3500 > 3000 → 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[0].items[0].cost_cny = 3200;
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 1, rule: "R-08", severity: "warn" });
    expect(conflicts[0].detail).toContain("3500");
  });

  it("budget_cny 为 null 时跳过该规则", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[0].items[0].cost_cny = 999999;
    const intake = { ...baseIntake(), budget_cny: null };
    setup(itinerary, intake);
    const conflicts = runRun(tripId);
    expect(conflicts.some((c) => c.rule === "R-08")).toBe(false);
  });
});

describe("R-09 相邻坐标距离异常", () => {
  it("第3天两条目 geo 直线距离 >300km（同日阈值）→ 违规", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[2].items.push({
      time: "14:00",
      kind: "sight",
      name: "乌鲁木齐国际大巴扎",
      note: "游览",
      geo: { lat: 43.79, lng: 87.6 },
      cost_cny: null,
      booking: null,
    });
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 3, rule: "R-09", severity: "warn" });
    expect(conflicts[0].detail).toContain("禾木村");
    expect(conflicts[0].detail).toContain("乌鲁木齐国际大巴扎");
  });

  it("跨天：第1天末条目 → 第2天首条目直线距离约639km（>600km 跨天阈值）→ 违规", () => {
    const itinerary = clone(baseItinerary());
    // 第1天唯一 geo 条目与第2天唯一 geo 条目相距约 639km（同日内均无相邻 geo 对，
    // 只会触发跨天检测）；第3天 geo 置空避免第2→3天再触发一次干扰断言。
    itinerary.days[0].items[0].geo = { lat: 30.0, lng: 100.0 };
    itinerary.days[1].items[1].geo = { lat: 35.75, lng: 100.0 };
    itinerary.days[2].items[0].geo = null;
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ day: 2, rule: "R-09", severity: "warn" });
    expect(conflicts[0].detail).toContain("天山天池");
    expect(conflicts[0].detail).toContain("喀纳斯湖");
    expect(conflicts[0].detail).toContain("跨天");
  });

  it("跨天：距离约500km（<600km 跨天阈值）→ 不触发", () => {
    const itinerary = clone(baseItinerary());
    itinerary.days[0].items[0].geo = { lat: 30.0, lng: 100.0 };
    itinerary.days[1].items[1].geo = { lat: 34.49, lng: 100.0 };
    itinerary.days[2].items[0].geo = null;
    setup(itinerary);
    const conflicts = runRun(tripId);
    expect(conflicts.some((c) => c.rule === "R-09")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe("validate", () => {
  it("合法 itinerary 通过", () => {
    setup(baseItinerary());
    expect(runValidate(tripId)).toEqual({ ok: true });
  });

  it("非法 itinerary（缺少 status）被拒绝，抛出 ValidationError 附带 ajv details", () => {
    writeJson(tripId, "intake.json", baseIntake());
    const invalid = clone(baseItinerary()) as unknown as Record<string, unknown>;
    delete invalid.status;
    writeJson(tripId, "itinerary.json", invalid);

    expect(() => runValidate(tripId)).toThrow(ValidationError);
    try {
      runValidate(tripId);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.details.length).toBeGreaterThan(0);
      expect(ve.details.some((e) => e.params?.missingProperty === "status")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI 入口（main）
// ---------------------------------------------------------------------------

describe("main（CLI 入口）", () => {
  it("validate --trip <id> 走通", () => {
    setup(baseItinerary());
    expect(main(["validate", "--trip", tripId])).toEqual({ ok: true });
  });

  it("run --trip <id> 走通，输出裸数组契约", () => {
    setup(baseItinerary());
    const result = main(["run", "--trip", tripId]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it("缺少 --trip 抛 CliError", () => {
    expect(() => main(["run"])).toThrow(CliError);
  });

  it("未知子命令抛 CliError", () => {
    expect(() => main(["frobnicate", "--trip", tripId])).toThrow(CliError);
  });
});

// ---------------------------------------------------------------------------
// lib/conflict 纯函数单测
// ---------------------------------------------------------------------------

describe("lib/conflict", () => {
  it("haversineKm：同一点距离为 0", () => {
    expect(haversineKm({ lat: 43.88, lng: 88.13 }, { lat: 43.88, lng: 88.13 })).toBeCloseTo(0, 5);
  });

  it("haversineKm：已知两点距离在合理范围内（禾木村→乌鲁木齐 约 400~700km）", () => {
    const km = haversineKm({ lat: 48.62, lng: 86.98 }, { lat: 43.79, lng: 87.6 });
    expect(km).toBeGreaterThan(300);
    expect(km).toBeLessThan(700);
  });

  it("parseDrivingHours：解析「X小时」「X.X小时」「X个小时」", () => {
    expect(parseDrivingHours("驾车约4小时")).toBe(4);
    expect(parseDrivingHours("全程约5.5小时")).toBe(5.5);
    expect(parseDrivingHours("大约3个小时车程")).toBe(3);
  });

  it("parseDrivingHours：解析不到返回 null", () => {
    expect(parseDrivingHours("飞机抵达")).toBeNull();
  });

  it("HIGH_INTENSITY_KEYWORDS 含任务描述示例关键词", () => {
    for (const kw of ["徒步", "攀登", "骑行", "漂流"]) {
      expect(HIGH_INTENSITY_KEYWORDS).toContain(kw);
    }
  });
});
