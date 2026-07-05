import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, readJson, writeJson } from "../lib/workspace";
import type { ProgressState } from "../lib/progress";
import { buildManualData, RenderError, type Itinerary, type Intake } from "../export/lib/render";
import { renderManualHtml } from "../export/lib/html";
import { runPdf, main, CliError } from "../export/pdf";

// ---------------------------------------------------------------------------
// fixture：3 天新疆自驾行程（覆盖 5 种 kind + 缺失 cost_cny + hotel booking +
// car booking + source_ref 有/无），用于九章节字段齐全校验 + 预算合计校验
// ---------------------------------------------------------------------------

let testPilotHome: string;
let tripId: string;

function makeIntake(overrides: Partial<Intake> = {}): Intake {
  return {
    trip_id: tripId,
    destination: "新疆北疆",
    dates: { start: "2026-07-25", end: "2026-07-27" },
    party: { adults: 2, children: 0, seniors: 2 },
    budget_cny: 10000,
    transport: "self-drive",
    preferences: ["自然风光", "轻松节奏"],
    origin_city: "上海",
    locale: "zh",
    ...overrides,
  };
}

function makeItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    trip_id: tripId,
    status: "detailed",
    base_travelogue: "f10180a5bf08",
    agency_recommendation: null,
    conflicts_checked_at: "2026-07-05T16:00:00Z",
    days: [
      {
        day: 1,
        date: "2026-07-25",
        source_ref: null,
        items: [
          { time: "08:00", kind: "transit", name: "上海-乌鲁木齐", note: "航班", geo: null, cost_cny: 4800, booking: null },
          { time: "14:00", kind: "sight", name: "新疆博物馆", note: "参观", geo: null, cost_cny: 0, booking: null },
          { time: "18:00", kind: "meal", name: "国际大巴扎", note: "烤肉", geo: null, cost_cny: 320, booking: null },
          {
            time: "20:00",
            kind: "hotel",
            name: "乌鲁木齐酒店",
            note: "市区住宿",
            geo: null,
            cost_cny: 600,
            booking: {
              type: "hotel",
              name: "乌鲁木齐大酒店",
              url: "https://example.com/hotel1",
              affiliate_url: "https://go-cn.example.cn/r/ht-abc123?d=%E6%96%B0%E7%96%86&dt=2026-07-25",
              alt_recommendation: null,
            },
          },
        ],
      },
      {
        day: 2,
        date: "2026-07-26",
        source_ref: { travelogue_id: "f10180a5bf08", day: 6 },
        items: [
          { time: "08:30", kind: "transit", name: "乌鲁木齐-天山天池", note: "车程1小时", geo: null, cost_cny: 100, booking: null },
          {
            time: "10:00",
            kind: "sight",
            name: "天山天池",
            note: "景区游玩",
            geo: { lat: 43.88, lng: 88.13 },
            cost_cny: 800,
            booking: null,
          },
          { time: "12:30", kind: "meal", name: "景区午餐", note: "简餐", geo: null, cost_cny: 80, booking: null },
          { time: "20:00", kind: "hotel", name: "布尔津酒店", note: "夜宿", geo: null, cost_cny: null, booking: null },
          {
            time: null,
            kind: "other",
            name: "取车",
            note: "租车公司取车",
            geo: null,
            cost_cny: null,
            booking: { type: "car", name: "某租车公司", url: null, affiliate_url: null, alt_recommendation: null },
          },
        ],
      },
      {
        day: 3,
        date: "2026-07-27",
        source_ref: null,
        items: [
          { time: "09:00", kind: "transit", name: "乌鲁木齐-上海", note: "返程航班", geo: null, cost_cny: 4800, booking: null },
          { time: "11:00", kind: "sight", name: "国际大巴扎", note: "回程前采购", geo: null, cost_cny: 0, booking: null },
        ],
      },
    ],
    ...overrides,
  };
}

function setupFixtureTrip(
  intakeOverrides: Partial<Intake> = {},
  itineraryOverrides: Partial<Itinerary> = {},
  withIndex = true
): void {
  const tripPath = createTrip("xinjiang-manual-fixture");
  tripId = path.basename(tripPath);
  writeJson(tripId, "intake.json", makeIntake(intakeOverrides));
  writeJson(tripId, "itinerary.json", makeItinerary(itineraryOverrides));
  if (withIndex) {
    writeJson(tripId, "travelogues/index.json", [
      {
        id: "f10180a5bf08",
        brief: "北疆经典12天环线自驾深度游",
        tags: ["自驾", "摄影"],
        total: 6.18,
        url: "https://gs.ctrip.com/html5/you/travels/427/3943927.html",
        days_count: 12,
      },
      {
        id: "d8d38596f2cb",
        brief: "伊犁地区摄影地点清单",
        tags: ["摄影", "地点清单"],
        total: 6.77,
        url: "https://biyanjianmo.tuchong.com/t/47309467/",
      },
    ]);
  }
}

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-export-pdf-test-"));
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

describe("buildManualData", () => {
  it("九章节字段齐全（含附录）", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);

    expect(data.tripId).toBe(tripId);
    // 1 封面
    expect(data.cover.title).toBe("新疆北疆 3天自驾路书");
    expect(data.cover.totalDays).toBe(3);
    expect(data.cover.partyLabel).toBe("2大人2老人");
    expect(data.cover.originCity).toBe("上海");
    // 2 行程概览
    expect(data.overview).toHaveLength(3);
    expect(data.overview[0]).toMatchObject({ day: 1, mainLine: "新疆博物馆", hotel: "乌鲁木齐酒店", sourceLabel: "自定" });
    expect(data.overview[1]).toMatchObject({ day: 2, mainLine: "天山天池", hotel: "布尔津酒店" });
    expect(data.overview[1].sourceLabel).toContain("f10180a5bf08");
    expect(data.overview[2]).toMatchObject({ day: 3, mainLine: "国际大巴扎", hotel: "—" });
    // 3 逐日详情
    expect(data.dailyDetails).toHaveLength(3);
    expect(data.dailyDetails[0].items).toHaveLength(4);
    expect(data.dailyDetails[1].items[4].time).toBe("待定"); // "取车" 项 time=null
    // 验证 cost 字段存在
    expect(data.dailyDetails[0].items[0]).toHaveProperty("cost", 4800);
    expect(data.dailyDetails[1].items[3]).toHaveProperty("cost", null); // hotel with no cost
    // 4 住宿汇总
    expect(data.hotels.rows).toHaveLength(2);
    expect(data.hotels.subtotal).toBe(600);
    // affiliate_url 优先：fixture 同时有 url+affiliate_url，断言渲染取 affiliate_url
    expect(data.hotels.rows[0].bookingUrl).toBe("https://go-cn.example.cn/r/ht-abc123?d=%E6%96%B0%E7%96%86&dt=2026-07-25");
    // 5 交通汇总
    expect(data.transport.modeLabel).toBe("自驾");
    expect(data.transport.longHaul).toHaveLength(2);
    expect(data.transport.dailySegments).toHaveLength(1);
    expect(data.transport.carRentalNotes).toHaveLength(1);
    // 6 餐饮推荐
    expect(data.meals).toHaveLength(2);
    expect(data.meals[0].items[0].name).toBe("国际大巴扎");
    // 7 预算表
    expect(data.budget.grandTotal).toBe(11500);
    expect(data.budget.uncountedItemCount).toBe(2);
    expect(data.budget.byKind.reduce((sum, row) => sum + row.total, 0)).toBe(data.budget.grandTotal);
    expect(data.budget.budgetCny).toBe(10000);
    expect(data.budget.overBudget).toBe(true);
    expect(data.budget.diff).toBe(10000 - 11500);
    expect(data.budget.perPerson).toBeCloseTo(11500 / 4);
    // 8 装备清单
    expect(data.equipment.length).toBeGreaterThan(0);
    expect(data.equipment.some((c) => c.category.includes("自驾"))).toBe(true);
    expect(data.equipment.some((c) => c.category.includes("老人"))).toBe(true);
    // 9 应急信息
    expect(data.emergency.generalNumbers.length).toBe(4);
    expect(data.emergency.destinationNotes.some((n) => n.includes("边防证"))).toBe(true);
    // 附录：参考游记
    expect(data.travelogues).toHaveLength(2);
    expect(data.travelogues[0].id).toBe("f10180a5bf08");
  });

  it("预算合计正确：分类小计之和等于总计，且等于逐日小计之和", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const byDaySum = data.budget.byDay.reduce((sum, row) => sum + row.total, 0);
    expect(byDaySum).toBe(data.budget.grandTotal);
    expect(data.budget.grandTotal).toBe(11500);
  });

  it("itinerary.json 缺失时抛 RenderError（导出必须在行程确认后）", () => {
    const tripPath = createTrip("xinjiang-manual-missing-itinerary");
    tripId = path.basename(tripPath);
    writeJson(tripId, "intake.json", makeIntake());
    expect(() => buildManualData(tripId)).toThrow(RenderError);
  });

  it("行程状态为 draft 时抛 RenderError", () => {
    setupFixtureTrip({}, { status: "draft" });
    expect(() => buildManualData(tripId)).toThrow(RenderError);
  });

  it("无 travelogues/index.json 时附录为空数组而非报错", () => {
    setupFixtureTrip({}, {}, false);
    const data = buildManualData(tripId);
    expect(data.travelogues).toEqual([]);
  });
});

describe("renderManualHtml", () => {
  it("渲染 HTML 含 Day 1 名称与预算总额关键内容", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("新疆博物馆");
    expect(html).toContain("天山天池");
    expect(html).toContain("¥11500");
    expect(html).toContain(data.cover.title);
  });

  it("模板替换防护：title 含 $& 等特殊模式不损坏", () => {
    setupFixtureTrip({ origin_city: "上海$&测试" }, {});
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 验证出发地正确转义且包含在 HTML 中
    expect(html).toContain("上海$&amp;测试");
    expect(html).not.toContain("出发地：上海$&测试"); // 原样不应出现未转义版本
    // 验证无占位符残留
    expect(html).not.toContain("{{TITLE}}");
    expect(html).not.toContain("{{CONTENT}}");
  });

  it("模板替换防护：title 含 $' 特殊模式不损坏", () => {
    setupFixtureTrip({ destination: "新疆$'测试" }, {});
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 验证目的地正确转义且包含在 HTML 中
    expect(html).toContain("新疆$&#39;测试");
    expect(html).not.toContain("新疆 3天"); // title 格式被正确生成
    // 验证无占位符残留
    expect(html).not.toContain("{{TITLE}}");
    expect(html).not.toContain("{{CONTENT}}");
  });

  it("booking URL 渲染为可点击链接", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 验证 hotel booking URL 渲染为 <a> 标签（affiliate_url 优先于 url）
    expect(data.hotels.rows[0].bookingUrl).toBe("https://go-cn.example.cn/r/ht-abc123?d=%E6%96%B0%E7%96%86&dt=2026-07-25");
    expect(html).toContain("https://go-cn.example.cn/r/ht-abc123");
  });

  it("travelogue URL 渲染为可点击链接", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 验证 travelogue URL 渲染为 <a> 标签
    expect(html).toContain('<a href="https://gs.ctrip.com/html5/you/travels/427/3943927.html">');
  });

  it("Task 19：四段主结构标题均出现，原住宿/应急内容仍保留在对应段落中", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 四段主结构标题（对齐 Excel 四 sheet 命名）
    expect(html).toContain("一、行程安排及费用预算");
    expect(html).toContain("二、每日详细行程");
    expect(html).toContain("三、出行必备自检清单（模板）");
    expect(html).toContain("四、消费流水及费用核算（模板）");
    // 原住宿汇总/交通汇总/餐饮推荐降级为第一段附注小节，内容仍保留
    expect(html).toContain("住宿汇总");
    expect(html).toContain("乌鲁木齐大酒店");
    expect(html).toContain("交通汇总");
    expect(html).toContain("餐饮推荐");
    // 原应急信息并入第三段末尾，内容仍保留
    expect(html).toContain("应急信息");
    expect(html).toContain("边防证");
  });

  it("Task 19：出行必备自检清单含空白责任人/出发前/出行中列（模板）", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    expect(html).toContain("<th>责任人</th>");
    expect(html).toContain("<th>出发前</th>");
    expect(html).toContain("<th>出行中</th>");
    expect(html).toContain("☐");
  });

  it("Task 19：消费流水模板含约 20 行空白手写行 + 核算小表（含门票/购物等类别）", () => {
    setupFixtureTrip();
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    expect(html).toContain("消费流水");
    expect(html).toContain("费用核算（按类别）");
    expect(html).toContain("<th>预算数</th>");
    expect(html).toContain(">门票<");
    expect(html).toContain(">购物<");
    const appendRowCount = (html.match(/<tr class="append-row">/g) ?? []).length;
    expect(appendRowCount).toBeGreaterThanOrEqual(20);
  });

  it("alt_recommendation 非 null → 逐日明细渲染「替代推荐：<name>（<reason>）+链接」行", () => {
    const itinerary = makeItinerary();
    itinerary.days[0].items[3].booking!.alt_recommendation = {
      name: "粉蒸牛肉馆",
      reason: "泡馍名气大但排队久，带老人小孩更适合粉蒸牛肉",
      url: "https://example.com/fenzheng",
      affiliate_url: null,
    };
    setupFixtureTrip({}, { days: itinerary.days });
    const data = buildManualData(tripId);
    // 数据层：alt 字段就位，链接口径 affiliate_url ?? url
    expect(data.dailyDetails[0].items[3].alt).toEqual({
      name: "粉蒸牛肉馆",
      reason: "泡馍名气大但排队久，带老人小孩更适合粉蒸牛肉",
      url: "https://example.com/fenzheng",
    });

    const html = renderManualHtml(data);
    expect(html).toContain("替代推荐：粉蒸牛肉馆（泡馍名气大但排队久，带老人小孩更适合粉蒸牛肉）");
    expect(html).toContain('<a href="https://example.com/fenzheng">');
  });

  it("alt_recommendation.affiliate_url 存在时替代链接优先用短链（⑧ 口径）", () => {
    const itinerary = makeItinerary();
    itinerary.days[0].items[3].booking!.alt_recommendation = {
      name: "粉蒸牛肉馆",
      reason: "排队久",
      url: "https://example.com/fenzheng",
      affiliate_url: "https://go-cn.example.cn/r/alt-rs-abc1234567?d=x&dt=2026-07-25",
    };
    itinerary.days[0].items[3].booking!.affiliate_url =
      "https://go-cn.example.cn/r/ht-abc1234567?d=x&dt=2026-07-25";
    setupFixtureTrip({}, { days: itinerary.days });
    const data = buildManualData(tripId);
    expect(data.dailyDetails[0].items[3].alt?.url).toBe(
      "https://go-cn.example.cn/r/alt-rs-abc1234567?d=x&dt=2026-07-25"
    );
    // 计划内 booking 链接同口径：affiliate_url 优先替代裸链接
    expect(data.dailyDetails[0].items[3].bookingUrl).toBe(
      "https://go-cn.example.cn/r/ht-abc1234567?d=x&dt=2026-07-25"
    );
  });

  it("危险 scheme（javascript:）URL 不被渲染为链接", () => {
    setupFixtureTrip(
      {},
      {
        days: [
          {
            day: 1,
            date: "2026-07-25",
            source_ref: null,
            items: [
              {
                time: "08:00",
                kind: "hotel",
                name: "恶意酒店",
                note: "javascript: 攻击测试",
                geo: null,
                cost_cny: 600,
                booking: {
                  type: "hotel",
                  name: "恶意",
                  url: "javascript:alert('xss')",
                  affiliate_url: null,
                  alt_recommendation: null,
                },
              },
            ],
          },
        ],
      }
    );
    const data = buildManualData(tripId);
    const html = renderManualHtml(data);

    // 验证 javascript: 链接不被渲染为 <a> 标签
    expect(html).not.toContain('<a href="javascript:');
    // 应该只显示转义后的文本或不显示
    expect(html).toContain("恶意");
  });
});

describe("runPdf / CLI", () => {
  it("生成 PDF 文件，非空且大于 30KB", async () => {
    setupFixtureTrip();
    const result = await runPdf(tripId);

    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("exports");
    expect(result.path.endsWith(".pdf")).toBe(true);
    const size = statSync(result.path).size;
    expect(size).toBeGreaterThan(30 * 1024);
    expect(result.bytes).toBe(size);

    // Task 26 review Important-2：接入点断言——progress.json 落到 stage=export，
    // 完成态 message 明确报出"导出完成"
    const progress = readJson<ProgressState>(tripId, "progress.json");
    expect(progress.stage).toBe("export");
    expect(progress.current).toBe(progress.total);
    expect(progress.message).toContain("PDF 导出完成");
  }, 20000);

  it("main 缺 --trip 抛 CliError", async () => {
    await expect(main(["run"])).rejects.toThrow(CliError);
  });

  it("main 未知子命令抛 CliError", async () => {
    await expect(main(["bogus", "--trip", "x"])).rejects.toThrow(CliError);
  });

  it("main 不支持的 --format 抛 CliError", async () => {
    setupFixtureTrip();
    await expect(main(["run", "--trip", tripId, "--format", "excel"])).rejects.toThrow(CliError);
  });
});
