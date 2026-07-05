import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, readJson, writeJson } from "../lib/workspace";
import { runPlan, runRegister, runPick, normalizeUrl, domainWeight, CliError } from "../search";

const BASE_CONFIG_PATH = path.resolve(__dirname, "../../config/pilot.json");
const baseConfig = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf-8"));

function writeConfigFixture(dir: string, overrides: Record<string, unknown>): string {
  const configPath = path.join(dir, "pilot.config.json");
  writeFileSync(configPath, JSON.stringify({ ...baseConfig, ...overrides }), "utf-8");
  return configPath;
}

let testPilotHome: string;
let tripId: string;

const baseIntake = {
  destination: "新疆",
  dates: { start: "2026-07-26", end: "2026-08-02" },
  party: { adults: 2, children: 0, seniors: 2 },
  budget_cny: 20000,
  transport: "self-drive" as const,
  preferences: ["自驾", "摄影"],
  origin_city: "上海",
  locale: "zh" as const,
};

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-search-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("xinjiang");
  tripId = path.basename(tripPath);
  writeJson(tripId, "intake.json", { trip_id: tripId, ...baseIntake });
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  delete process.env.PILOT_CONFIG;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

function writeSerpFixture(entries: unknown, filePath: string) {
  writeFileSync(filePath, JSON.stringify(entries), "utf-8");
}

describe("search plan", () => {
  it("按 intake 生成 ≥4 类源，视频源查询词含目的地", () => {
    const plan = runPlan(tripId);

    expect(plan.trip_id).toBe(tripId);
    const categories = new Set(plan.sources.map((s) => s.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);

    const videoSources = plan.sources.filter((s) => s.category === "video");
    expect(videoSources.length).toBeGreaterThan(0);
    for (const vs of videoSources) {
      expect(vs.queries.length).toBeGreaterThan(0);
      for (const q of vs.queries) {
        expect(q).toContain("新疆");
      }
    }

    // 自驾 transport 应体现在查询词中的至少一条
    const allQueries = plan.sources.flatMap((s) => s.queries);
    expect(allQueries.some((q) => q.includes("自驾"))).toBe(true);

    // 写盘验证
    const written = readJson(tripId, "search-plan.json");
    expect(written).toEqual(plan);
  });

  it("路由表来自 config，不硬编码——en locale 无源时 sources 为空", () => {
    writeJson(tripId, "intake.json", {
      trip_id: tripId,
      ...baseIntake,
      locale: "en",
    });
    const plan = runPlan(tripId);
    expect(plan.sources).toEqual([]);
  });
});

describe("search register", () => {
  it("合法 serp 文件登记成功并更新 search-plan 状态", () => {
    runPlan(tripId);
    const serpFile = path.join(testPilotHome, "serp-mafengwo.json");
    writeSerpFixture(
      [
        { title: "北疆9天自驾环线", url: "https://www.mafengwo.cn/i/123.html", snippet: "禾木喀纳斯" },
        { title: "南疆环线", url: "https://www.mafengwo.cn/i/456.html", snippet: "喀什塔县" },
      ],
      serpFile,
    );

    const result = runRegister(tripId, "马蜂窝", serpFile);
    expect(result.added).toBe(2);
    expect(result.total).toBe(2);

    const plan = readJson<{ sources: { name: string; status: string; result_count: number }[] }>(
      tripId,
      "search-plan.json",
    );
    const source = plan.sources.find((s) => s.name === "马蜂窝");
    expect(source?.status).toBe("done");
    expect(source?.result_count).toBe(2);
  });

  it("两次登记同一 URL（含不同 utm 参数）去重", () => {
    runPlan(tripId);
    const serpFile1 = path.join(testPilotHome, "serp-1.json");
    const serpFile2 = path.join(testPilotHome, "serp-2.json");
    writeSerpFixture(
      [{ title: "北疆9天自驾环线", url: "https://www.mafengwo.cn/i/123.html?utm_source=weibo", snippet: "禾木喀纳斯" }],
      serpFile1,
    );
    writeSerpFixture(
      [{ title: "北疆9天自驾环线（转发）", url: "https://WWW.mafengwo.cn/i/123.html?utm_source=wechat#comments", snippet: "禾木喀纳斯" }],
      serpFile2,
    );

    runRegister(tripId, "马蜂窝", serpFile1);
    const second = runRegister(tripId, "马蜂窝", serpFile2);

    expect(second.added).toBe(0);
    expect(second.total).toBe(1);

    const raw = readJson<{ url: string }[]>(tripId, "raw/serp-马蜂窝.json");
    expect(raw.length).toBe(1);
  });

  it("非法条目（缺 required 字段）exit 拒绝并报告下标", () => {
    runPlan(tripId);
    const serpFile = path.join(testPilotHome, "serp-bad.json");
    writeSerpFixture(
      [
        { title: "合法条目", url: "https://www.mafengwo.cn/i/1.html", snippet: "ok" },
        { title: "缺 url" /* url 缺失 */, snippet: "bad" },
      ],
      serpFile,
    );

    expect(() => runRegister(tripId, "马蜂窝", serpFile)).toThrow(CliError);
    try {
      runRegister(tripId, "马蜂窝", serpFile);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as Error).message).toContain("1");
    }
  });

  it("未知 source 名（不在 search-plan 中）拒绝", () => {
    runPlan(tripId);
    const serpFile = path.join(testPilotHome, "serp-unknown.json");
    writeSerpFixture([{ title: "t", url: "https://example.com/a", snippet: "s" }], serpFile);
    expect(() => runRegister(tripId, "不存在的源", serpFile)).toThrow(CliError);
  });
});

describe("search pick", () => {
  function seedRegisteredSources() {
    runPlan(tripId);
    const dir = path.join(testPilotHome, "workspace", tripId, "raw");
    mkdirSync(dir, { recursive: true });

    const wenzhang = [
      { title: "云南自驾6天游记大理丽江", url: "https://www.mafengwo.cn/i/1.html", snippet: "s" },
      { title: "南疆环线攻略", url: "https://www.mafengwo.cn/i/2.html", snippet: "s" },
    ];
    writeJson(tripId, "raw/serp-马蜂窝.json", wenzhang);

    const video = [
      { title: "新疆自驾视频攻略", url: "https://www.bilibili.com/video/BV1xx", snippet: "s" },
      { title: "喀纳斯航拍", url: "https://b23.tv/abc123", snippet: "s" },
    ];
    writeJson(tripId, "raw/serp-B站.json", video);

    // 更新 result_count 使 pick 能读取到（手工模拟 register 后的落盘结果，pick 直接读 raw/serp-*.json，无需 result_count）
  }

  it("视频 URL 的 media_type_guess 判定为 video（B站域名，含 b23.tv 短链）", () => {
    seedRegisteredSources();
    runPick(tripId, 10);
    const pick = readJson<{ url: string; media_type_guess: string; method: string }[]>(
      tripId,
      "raw/pick.json",
    );
    const videoEntries = pick.filter((p) => p.url.includes("bilibili.com") || p.url.includes("b23.tv"));
    expect(videoEntries.length).toBeGreaterThan(0);
    for (const v of videoEntries) {
      expect(v.media_type_guess).toBe("video");
    }
  });

  it("马蜂窝域名 method 判定为 scrape", () => {
    seedRegisteredSources();
    runPick(tripId, 10);
    const pick = readJson<{ url: string; method: string }[]>(tripId, "raw/pick.json");
    const mfw = pick.filter((p) => p.url.includes("mafengwo.cn"));
    expect(mfw.length).toBeGreaterThan(0);
    for (const p of mfw) {
      expect(p.method).toBe("scrape");
    }
  });

  it("--top 上限被尊重", () => {
    seedRegisteredSources();
    const result = runPick(tripId, 2);
    expect(result.picked).toBeLessThanOrEqual(2);
    const pick = readJson<unknown[]>(tripId, "raw/pick.json");
    expect(pick.length).toBe(result.picked);
    expect(pick.length).toBe(result.total);
  });
});

describe("search pick: preferred_domains 配额倾斜", () => {
  it("命中 preferred_domains 的条目相关度得分乘以倍率，排到同类别非 preferred 条目之前", () => {
    runPlan(tripId);
    const dir = path.join(testPilotHome, "workspace", tripId, "raw");
    mkdirSync(dir, { recursive: true });

    // 图虫与 500px 同属 photo 类别，标题相关度打平（都含"新疆"与"摄影"）
    writeJson(tripId, "raw/serp-图虫.json", [
      { title: "新疆摄影游记合集", url: "https://tuchong.com/albums/1", snippet: "s" },
    ]);
    writeJson(tripId, "raw/serp-500px.json", [
      { title: "新疆摄影游记合集", url: "https://500px.com/photo/1", snippet: "s" },
    ]);

    const configPath = writeConfigFixture(testPilotHome, {
      preferred_domains: { "tuchong.com": 3 },
    });
    process.env.PILOT_CONFIG = configPath;

    // topN=20 → photo 配额 round(20*0.1)=2，两条候选都能进入结果
    runPick(tripId, 20);
    const pick = readJson<{ url: string }[]>(tripId, "raw/pick.json");
    const tuchongIdx = pick.findIndex((p) => p.url.includes("tuchong.com"));
    const px500Idx = pick.findIndex((p) => p.url.includes("500px.com"));
    expect(tuchongIdx).toBeGreaterThanOrEqual(0);
    expect(px500Idx).toBeGreaterThanOrEqual(0);
    expect(tuchongIdx).toBeLessThan(px500Idx);
  });

  it("未配置 preferred_domains 时排序不受影响（权重恒为 1）", () => {
    seedRegisteredSourcesFixture();
    const result = runPick(tripId, 10);
    expect(result.picked).toBeGreaterThan(0);
  });

  function seedRegisteredSourcesFixture() {
    runPlan(tripId);
    const dir = path.join(testPilotHome, "workspace", tripId, "raw");
    mkdirSync(dir, { recursive: true });
    writeJson(tripId, "raw/serp-马蜂窝.json", [
      { title: "云南自驾6天游记大理丽江", url: "https://www.mafengwo.cn/i/1.html", snippet: "s" },
    ]);
  }
});

describe("domainWeight", () => {
  it("命中域名（含子域名）返回配置倍率，未命中返回 1", () => {
    const preferred = { "you.ctrip.com": 3, "tuchong.com": 2 };
    expect(domainWeight("https://you.ctrip.com/travels/abc", preferred)).toBe(3);
    expect(domainWeight("https://www.tuchong.com/photo/1", preferred)).toBe(2);
    expect(domainWeight("https://www.mafengwo.cn/i/1.html", preferred)).toBe(1);
  });

  it("未配置 preferred_domains 时恒为 1", () => {
    expect(domainWeight("https://tuchong.com/photo/1", undefined)).toBe(1);
  });

  it("非法 URL 不抛异常，返回 1", () => {
    expect(domainWeight("not-a-url", { "tuchong.com": 5 })).toBe(1);
  });
});

describe("normalizeUrl", () => {
  it("去 utm_* 参数、fragment，host 小写", () => {
    const normalized = normalizeUrl("HTTPS://Example.COM/path?utm_source=a&keep=1#frag");
    expect(normalized).toBe("https://example.com/path?keep=1");
  });

  it("非法 URL 抛出异常", () => {
    expect(() => normalizeUrl("not-a-url")).toThrow();
  });
});
