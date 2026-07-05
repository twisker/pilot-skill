import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, readJson, tripDir } from "../lib/workspace";
import type { ProgressState } from "../lib/progress";
import { runValidate, runDedupe, runScore, runIndex, main, CliError } from "../distill";
import {
  jaccardSimilarity,
  lcsLength,
  poiSimilarity,
  completeness,
  granularity,
  mediaRichness,
  freshness,
  scoreDeterministic,
  dedupeRankScore,
  indexTotal,
  DUPLICATE_THRESHOLD,
  type Travelogue,
} from "../lib/fingerprint";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeTravelogue(overrides: {
  id?: string;
  title?: string;
  publishedAt?: string | null;
  mediaType?: "text" | "video" | "image-set";
  days?: { day: number; pois: { name: string; kind?: string; note?: string }[]; transport?: string }[];
  tasteScore?: number | null;
  total?: number | null;
  deterministic?: { completeness: number; granularity: number; media_richness: number; freshness: number };
  brief?: string;
  tags?: string[];
  url?: string;
}): Travelogue {
  const days = overrides.days ?? [
    { day: 1, pois: [{ name: "天山天池" }, { name: "乌鲁木齐大巴扎" }], transport: "自驾" },
  ];
  return {
    id: overrides.id ?? "t1",
    meta: {
      title: overrides.title ?? "北疆9天自驾环线",
      author: "张三",
      source: {
        url: overrides.url ?? `https://example.com/${overrides.id ?? "t1"}`,
        platform: "mafengwo",
        media_type: overrides.mediaType ?? "text",
      },
      published_at: overrides.publishedAt === undefined ? "2026-01-01" : overrides.publishedAt,
      fetch_quality: "full",
    },
    summary: {
      brief: overrides.brief ?? "北疆自驾环线游记简介。",
      tags: overrides.tags ?? ["自驾", "摄影"],
    },
    route: {
      days: days.map((d) => ({
        day: d.day,
        transport: d.transport ?? "自驾",
        pois: d.pois.map((p) => ({
          name: p.name,
          kind: (p.kind ?? "sight") as "sight" | "meal" | "hotel" | "transit",
          note: p.note ?? "沿途风景不错，适合拍照。",
        })),
      })),
    },
    quality: {
      deterministic: overrides.deterministic ?? {
        completeness: 0,
        granularity: 0,
        media_richness: 0,
        freshness: 0,
      },
      taste_score: overrides.tasteScore ?? null,
      total: overrides.total ?? null,
    },
  };
}

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-distill-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("xinjiang");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  delete process.env.PILOT_CONFIG;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

function travelogueFile(name: string): string {
  return path.join(tripDir(tripId), "travelogues", name);
}

function writeTravelogueFixture(name: string, t: unknown): void {
  writeFileSync(travelogueFile(name), JSON.stringify(t, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// lib/fingerprint.ts —— 纯算法单测
// ---------------------------------------------------------------------------

describe("fingerprint 算法", () => {
  it("jaccardSimilarity: 两个空集合定义为 0，不产生 NaN", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("jaccardSimilarity: 部分重合按交并比计算", () => {
    const a = new Set(["A", "B", "C"]);
    const b = new Set(["B", "C", "D"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 4, 5);
  });

  it("lcsLength: 标准最长公共子序列", () => {
    expect(lcsLength(["A", "B", "C", "D"], ["A", "C", "D"])).toBe(3);
    expect(lcsLength([], ["A"])).toBe(0);
    expect(lcsLength([], [])).toBe(0);
  });

  it("poiSimilarity: POI 序列高度重合（10 个中 9 个相同）的两条游记相似度 ≥0.75 阈值", () => {
    const a = makeTravelogue({
      id: "a",
      days: [
        { day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }] },
        { day: 2, pois: [{ name: "F" }, { name: "G" }, { name: "H" }, { name: "I" }, { name: "J" }] },
      ],
    });
    const b = makeTravelogue({
      id: "b",
      days: [
        { day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }] },
        { day: 2, pois: [{ name: "F" }, { name: "G" }, { name: "H" }, { name: "I" }, { name: "K" }] },
      ],
    });
    const sim = poiSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it("poiSimilarity: 完全不同路线的两条游记相似度低于阈值", () => {
    const a = makeTravelogue({
      id: "a",
      days: [{ day: 1, pois: [{ name: "喀纳斯" }, { name: "禾木" }] }],
    });
    const b = makeTravelogue({
      id: "b",
      days: [{ day: 1, pois: [{ name: "吐鲁番" }, { name: "火焰山" }] }],
    });
    expect(poiSimilarity(a, b)).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("completeness: 标题声称天数与 route.days 覆盖比，封顶 1", () => {
    const full = makeTravelogue({
      title: "北疆2天速览",
      days: [
        { day: 1, pois: [{ name: "A" }] },
        { day: 2, pois: [{ name: "B" }] },
      ],
    });
    expect(completeness(full)).toBe(1);

    const under = makeTravelogue({
      title: "北疆9天自驾环线",
      days: [{ day: 1, pois: [{ name: "A" }] }],
    });
    expect(completeness(under)).toBeCloseTo(1 / 9, 5);
  });

  it("completeness: route.days 为空数组时自然得 0 分，不特判 fetch_quality", () => {
    const summaryOnly = makeTravelogue({ title: "北疆9天自驾环线", days: [] });
    expect(completeness(summaryOnly)).toBe(0);
  });

  it("granularity: 平均每日 POI 数 ≥4 满分，空 days 得 0", () => {
    const dense = makeTravelogue({
      days: [{ day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }] }],
    });
    expect(granularity(dense)).toBe(1);

    const sparse = makeTravelogue({ days: [{ day: 1, pois: [{ name: "A" }] }] });
    expect(granularity(sparse)).toBeCloseTo(0.25, 5);

    const empty = makeTravelogue({ days: [] });
    expect(granularity(empty)).toBe(0);
  });

  it("mediaRichness: image-set 高于 text，且不因空 POI 崩溃", () => {
    const textLog = makeTravelogue({ mediaType: "text" });
    const imageLog = makeTravelogue({ mediaType: "image-set" });
    expect(mediaRichness(imageLog)).toBeGreaterThan(mediaRichness(textLog));

    const empty = makeTravelogue({ days: [] });
    expect(() => mediaRichness(empty)).not.toThrow();
    expect(mediaRichness(empty)).toBeGreaterThanOrEqual(0);
  });

  it("freshness: 新旧对比——最近发布分数显著高于 5 年前；null 给中性 0.5", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    const recent = freshness("2026-07-01", now);
    const old = freshness("2021-07-01", now);
    const unknown = freshness(null, now);

    expect(recent).toBeGreaterThan(old);
    expect(recent).toBeGreaterThan(0.9);
    // 5 年 / 2 年半衰 = 2.5 个半衰期 → 0.5^2.5 ≈ 0.177
    expect(old).toBeCloseTo(0.177, 2);
    expect(unknown).toBe(0.5);
  });

  it("freshness: 锚定测试——2 年前恰为半衰期 → freshness ≈ 0.5", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    const twoYearsAgo = freshness("2024-07-05", now);
    expect(twoYearsAgo).toBeCloseTo(0.5, 2);
  });

  it("scoreDeterministic: summary-only 空 days fixture 不崩溃且四项均低分", () => {
    const summaryOnly = makeTravelogue({ days: [], publishedAt: null });
    const score = scoreDeterministic(summaryOnly);
    expect(score.completeness).toBe(0);
    expect(score.granularity).toBe(0);
    expect(score.media_richness).toBeLessThan(0.5);
    expect(score.freshness).toBe(0.5);
  });

  it("dedupeRankScore: 有 total 用 total（0-10），否则用 deterministic 均值乘以 10 统一量纲", () => {
    const withTotal = makeTravelogue({ total: 8.4 });
    expect(dedupeRankScore(withTotal)).toBe(8.4);

    const withoutTotal = makeTravelogue({
      deterministic: { completeness: 0.5, granularity: 0.5, media_richness: 0.5, freshness: 0.5 },
    });
    // deterministic 均值 = 0.5，乘以 10 = 5.0
    expect(dedupeRankScore(withoutTotal)).toBeCloseTo(5.0, 5);
  });

  it("dedupeRankScore: 混合量纲——A 有 total=2、B 无 total 但 deterministic 全 1.0 → B 胜出", () => {
    const a = makeTravelogue({
      id: "a",
      total: 2,
      days: [{ day: 1, pois: [{ name: "X" }] }],
    });
    const b = makeTravelogue({
      id: "b",
      deterministic: { completeness: 1.0, granularity: 1.0, media_richness: 1.0, freshness: 1.0 },
      days: [{ day: 1, pois: [{ name: "X" }] }],
    });
    const scoreA = dedupeRankScore(a);
    const scoreB = dedupeRankScore(b);
    expect(scoreA).toBe(2); // total = 2
    expect(scoreB).toBeCloseTo(10, 5); // deterministic mean = 1.0 * 10 = 10
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it("indexTotal: 0.6*deterministic均值*10 + 0.4*taste_score；无 taste 时纯 deterministic", () => {
    const withTaste = makeTravelogue({
      deterministic: { completeness: 1, granularity: 1, media_richness: 1, freshness: 1 },
      tasteScore: 5,
    });
    // detMean=1 → 0.6*10 + 0.4*5 = 6 + 2 = 8
    expect(indexTotal(withTaste)).toBeCloseTo(8, 5);

    const withoutTaste = makeTravelogue({
      deterministic: { completeness: 0.5, granularity: 0.5, media_richness: 0.5, freshness: 0.5 },
    });
    // detMean=0.5 → 纯 deterministic = 0.5*10 = 5
    expect(indexTotal(withoutTaste)).toBeCloseTo(5, 5);
  });
});

// ---------------------------------------------------------------------------
// distill.ts CLI —— validate / dedupe / score / index
// ---------------------------------------------------------------------------

describe("distill validate", () => {
  it("非法 travelogue 改名加 .invalid 后缀（不删除），合法文件计入 valid", () => {
    const valid = makeTravelogue({ id: "valid-1" });
    writeTravelogueFixture("valid-1.json", valid);

    const invalid = makeTravelogue({ id: "invalid-1" }) as unknown as Record<string, unknown>;
    delete (invalid as { quality?: unknown }).quality; // 缺失 required 字段
    writeTravelogueFixture("invalid-1.json", invalid);

    const result = runValidate(tripId);

    expect(result.total).toBe(2);
    expect(result.valid).toBe(1);
    expect(result.invalid).toEqual(["invalid-1.json"]);

    expect(existsSync(travelogueFile("invalid-1.json"))).toBe(false);
    expect(existsSync(travelogueFile("invalid-1.json.invalid"))).toBe(true);
    expect(existsSync(travelogueFile("valid-1.json"))).toBe(true);

    // 原内容保留，只是改名
    const preserved = JSON.parse(readFileSync(travelogueFile("invalid-1.json.invalid"), "utf-8"));
    expect(preserved.id).toBe("invalid-1");

    // Task 26 review Important-2：接入点断言——progress.json 落到 stage=distill，
    // 且末次上报为完成态（current===total，两个文件都跑完）
    const progress = readJson<ProgressState>(tripId, "progress.json");
    expect(progress.stage).toBe("distill");
    expect(progress.current).toBe(progress.total);
  });

  it("非法 JSON 语法也被判定失败并改名", () => {
    writeFileSync(travelogueFile("broken.json"), "{ not valid json", "utf-8");
    const result = runValidate(tripId);
    expect(result.invalid).toEqual(["broken.json"]);
    expect(existsSync(travelogueFile("broken.json.invalid"))).toBe(true);
  });

  it("空 travelogues 目录返回 total 0", () => {
    const result = runValidate(tripId);
    expect(result).toEqual({ total: 0, valid: 0, invalid: [] });
  });
});

describe("distill dedupe", () => {
  it("两条高度重合的游记判重，保留 quality.total 更高者，另一条移入 travelogues/dup/", () => {
    const sharedDays = [
      { day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }] },
    ];
    const high = makeTravelogue({ id: "high", days: sharedDays, total: 9 });
    const low = makeTravelogue({ id: "low", days: sharedDays, total: 3 });
    writeTravelogueFixture("high.json", high);
    writeTravelogueFixture("low.json", low);

    const result = runDedupe(tripId);

    expect(result.total).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].removed).toBe("low.json");

    expect(existsSync(travelogueFile("high.json"))).toBe(true);
    expect(existsSync(travelogueFile("low.json"))).toBe(false);
    expect(existsSync(path.join(tripDir(tripId), "travelogues", "dup", "low.json"))).toBe(true);
  });

  it("不重合的游记全部保留", () => {
    const a = makeTravelogue({ id: "a", days: [{ day: 1, pois: [{ name: "喀纳斯" }] }] });
    const b = makeTravelogue({ id: "b", days: [{ day: 1, pois: [{ name: "吐鲁番" }] }] });
    writeTravelogueFixture("a.json", a);
    writeTravelogueFixture("b.json", b);

    const result = runDedupe(tripId);
    expect(result.kept).toBe(2);
    expect(result.removed).toHaveLength(0);
  });

  it("先出现且顺位在前但分低的条目也会被换出（无 total 时用 deterministic 均值判定）", () => {
    const sharedDays = [{ day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }] }];
    const firstLow = makeTravelogue({
      id: "first-low",
      days: sharedDays,
      deterministic: { completeness: 0.2, granularity: 0.2, media_richness: 0.2, freshness: 0.2 },
    });
    const secondHigh = makeTravelogue({
      id: "second-high",
      days: sharedDays,
      deterministic: { completeness: 0.9, granularity: 0.9, media_richness: 0.9, freshness: 0.9 },
    });
    // 文件名字母序确保 first-low 先被处理
    writeTravelogueFixture("a-first-low.json", firstLow);
    writeTravelogueFixture("b-second-high.json", secondHigh);

    const result = runDedupe(tripId);
    expect(result.kept).toBe(1);
    expect(existsSync(travelogueFile("b-second-high.json"))).toBe(true);
    expect(existsSync(travelogueFile("a-first-low.json"))).toBe(false);
    expect(existsSync(path.join(tripDir(tripId), "travelogues", "dup", "a-first-low.json"))).toBe(true);
  });
});

describe("distill score", () => {
  it("写回每个文件的 quality.deterministic 四项", () => {
    const t = makeTravelogue({
      id: "t1",
      title: "北疆2天速览",
      days: [{ day: 1, pois: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] }, { day: 2, pois: [{ name: "E" }] }],
    });
    writeTravelogueFixture("t1.json", t);

    const result = runScore(tripId);
    expect(result.total).toBe(1);
    expect(result.scored).toEqual(["t1.json"]);

    const written = JSON.parse(readFileSync(travelogueFile("t1.json"), "utf-8"));
    expect(written.quality.deterministic.completeness).toBe(1); // 2天声称/2天实际
    expect(written.quality.deterministic.granularity).toBeCloseTo(0.625, 5); // avg 2.5/4
    expect(written.quality.deterministic.freshness).toBeGreaterThan(0);
    expect(typeof written.quality.deterministic.media_richness).toBe("number");
  });
});

describe("distill index", () => {
  it("只保留 keepN 条，按 total 降序，字段仅 id/brief/tags/total/url", () => {
    for (let i = 0; i < 7; i++) {
      const t = makeTravelogue({
        id: `t${i}`,
        brief: `简介 ${i}`,
        tags: ["自驾"],
        url: `https://example.com/${i}`,
        deterministic: { completeness: i / 10, granularity: i / 10, media_richness: i / 10, freshness: i / 10 },
      });
      writeTravelogueFixture(`t${i}.json`, t);
    }

    const result = runIndex(tripId, 3);
    expect(result.candidates).toBe(7);
    expect(result.kept).toBe(3);

    const index = JSON.parse(readFileSync(travelogueFile("index.json"), "utf-8"));
    expect(index).toHaveLength(3);
    expect(index.map((e: { id: string }) => e.id)).toEqual(["t6", "t5", "t4"]);
    for (const entry of index) {
      expect(Object.keys(entry).sort()).toEqual(["brief", "days_count", "id", "tags", "total", "url"]);
    }
  });

  it("days_count = route.days.length；空 days（如 summary-only 增补）得 0", () => {
    const fullTrip = makeTravelogue({
      id: "full",
      days: [
        { day: 1, pois: [{ name: "A" }] },
        { day: 2, pois: [{ name: "B" }] },
      ],
      deterministic: { completeness: 0.9, granularity: 0.9, media_richness: 0.9, freshness: 0.9 },
    });
    const summaryOnly = makeTravelogue({
      id: "summary-only",
      days: [],
      deterministic: { completeness: 0, granularity: 0, media_richness: 0, freshness: 0 },
    });
    writeTravelogueFixture("full.json", fullTrip);
    writeTravelogueFixture("summary-only.json", summaryOnly);

    runIndex(tripId, 5);
    const index = JSON.parse(readFileSync(travelogueFile("index.json"), "utf-8"));
    const full = index.find((e: { id: string }) => e.id === "full");
    const summary = index.find((e: { id: string }) => e.id === "summary-only");
    expect(full.days_count).toBe(2);
    expect(summary.days_count).toBe(0);
  });

  it("keep 未传时使用 config.pilot.json 的 keepN（默认 5）", () => {
    for (let i = 0; i < 8; i++) {
      writeTravelogueFixture(
        `t${i}.json`,
        makeTravelogue({
          id: `t${i}`,
          deterministic: { completeness: 0.5, granularity: 0.5, media_richness: 0.5, freshness: 0.5 },
        }),
      );
    }
    const result = runIndex(tripId);
    expect(result.kept).toBe(5);
  });
});

describe("distill main() CLI 参数校验", () => {
  it("缺少 --trip 抛 CliError", () => {
    expect(() => main(["validate"])).toThrow(CliError);
  });

  it("未知子命令抛 CliError", () => {
    expect(() => main(["frobnicate", "--trip", "x"])).toThrow(CliError);
  });

  it("--keep 非数字时抛 CliError", () => {
    expect(() => main(["index", "--trip", tripId, "--keep", "abc"])).toThrow(CliError);
  });

  it("--keep 为 0 或负数时抛 CliError", () => {
    expect(() => main(["index", "--trip", tripId, "--keep", "0"])).toThrow(CliError);
    expect(() => main(["index", "--trip", tripId, "--keep", "-5"])).toThrow(CliError);
  });

  it("--keep 为正整数时正常执行", () => {
    // 空 travelogues 目录，index 返回 kept=0，不抛异常
    expect(() => main(["index", "--trip", tripId, "--keep", "10"])).not.toThrow();
  });
});
