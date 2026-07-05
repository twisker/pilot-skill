import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, writeJson } from "../lib/workspace";
import type { Itinerary, Intake } from "../export/lib/render";
import { runWord, main, CliError } from "../export/word";

// ---------------------------------------------------------------------------
// fixture：与 export-pdf.test.ts / export-excel.test.ts 同款造数（3 天新疆
// 自驾行程，11 个 item，grandTotal=11500），保持三套导出器口径一致，便于
// 交叉核对。
//
// zip 内容校验取舍：docx 产物本质是 zip（OOXML）。项目依赖里没有 jszip，
// exceljs 不认识 docx 结构，直接用 node:zlib 手写 zip 解析成本高且脆弱。
// 系统自带 `unzip` CLI（macOS/Linux 均预装，`tests/video.test.ts` 已有用
// execFileSync 调用外部二进制的先例）足够胜任「列出压缩包内文件名」与
// 「提取指定条目内容」两件事，比引入新依赖或手撸 zip parser 更省成本。
//
// Windows 兼容（Task 21）：Windows 默认不带 `unzip` CLI，用到 extractZipEntry /
// `unzip -l` 的用例用 it.skipIf(win32) 跳过；不依赖 unzip 的用例（docx 文件存在
// 性 + PK 头 magic number 校验、main/CLI 参数校验等）三平台都跑。zip 内容深校验
// 的覆盖率在 win32 job 上因此比 ubuntu/macos job 弱一些——这是记录在案的取舍，
// 由 CI matrix 的 ubuntu-latest/macos-latest job 承担完整覆盖
// （.github/workflows/ci.yml），非疏漏。
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
              affiliate_url: null,
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
  const tripPath = createTrip("xinjiang-word-fixture");
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
    ]);
  }
}

/** unzip -p 提取压缩包内某条目内容为字符串 */
function extractZipEntry(zipPath: string, entryName: string): string {
  return execFileSync("unzip", ["-p", zipPath, entryName], { encoding: "utf-8" });
}

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-export-word-test-"));
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

describe("runWord", () => {
  it("生成 docx 文件：存在、位于 exports/、.docx 后缀、体积 >10KB、PK 头", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("exports");
    expect(result.path.endsWith(".docx")).toBe(true);

    const size = statSync(result.path).size;
    expect(size).toBeGreaterThan(10 * 1024);
    expect(result.bytes).toBe(size);

    // docx 本质是 zip 包，文件头恒为 PK\x03\x04（本地文件头 magic number）
    const head = readFileSync(result.path).subarray(0, 4);
    expect(head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("① zip 内含 word/document.xml", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const listing = execFileSync("unzip", ["-l", result.path], { encoding: "utf-8" });
    expect(listing).toContain("word/document.xml");
  });

  it.skipIf(process.platform === "win32")("② document.xml 含首日日期与目的地字符串", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const xml = extractZipEntry(result.path, "word/document.xml");
    expect(xml).toContain("2026-07-25");
    expect(xml).toContain("新疆北疆");
  });

  it.skipIf(process.platform === "win32")("④ 章节数抽查：document.xml 中 Heading 样式引用计数 ≥9", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const xml = extractZipEntry(result.path, "word/document.xml");
    const headingMatches = xml.match(/w:pStyle w:val="Heading[12]"/g) ?? [];
    expect(headingMatches.length).toBeGreaterThanOrEqual(9);
  });

  it.skipIf(process.platform === "win32")("封面/预算/装备/应急关键内容均出现在正文中", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const xml = extractZipEntry(result.path, "word/document.xml");
    expect(xml).toContain("新疆北疆 3天自驾路书"); // 封面标题
    expect(xml).toContain("11500"); // 预算总计
    expect(xml).toContain("天山天池"); // 逐日详情
    expect(xml).toContain("120"); // 应急信息：急救电话
    expect(xml).toContain("f10180a5bf08"); // 附录：参考游记
  });

  it.skipIf(process.platform === "win32")("Task 19：四段主结构标题均出现，原住宿/应急内容仍保留在对应段落中", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const xml = extractZipEntry(result.path, "word/document.xml");
    // 四段主结构标题（对齐 Excel 四 sheet 命名）
    expect(xml).toContain("一、行程安排及费用预算");
    expect(xml).toContain("二、每日详细行程");
    expect(xml).toContain("三、出行必备自检清单（模板）");
    expect(xml).toContain("四、消费流水及费用核算（模板）");
    // 原住宿汇总/交通汇总/餐饮推荐降级为第一段附注小节，内容仍保留
    expect(xml).toContain("住宿汇总");
    expect(xml).toContain("乌鲁木齐大酒店");
    expect(xml).toContain("交通汇总");
    // 原应急信息并入第三段末尾，内容仍保留
    expect(xml).toContain("应急信息");
    expect(xml).toContain("边防证");
  });

  it.skipIf(process.platform === "win32")("Task 19：消费流水模板含空白手写表格与核算小表（含门票/购物等类别）", async () => {
    setupFixtureTrip();
    const result = await runWord(tripId);

    const xml = extractZipEntry(result.path, "word/document.xml");
    expect(xml).toContain("消费流水");
    expect(xml).toContain("费用核算（按类别）");
    expect(xml).toContain("预算数");
    expect(xml).toContain("门票");
    expect(xml).toContain("购物");
    // 20 行空白流水 + 6 行清单追加行等模板留白，令行数明显多于纯内容行数
    const trCount = (xml.match(/<w:tr[ >]/g) ?? []).length;
    expect(trCount).toBeGreaterThanOrEqual(60);
  });

  it.skipIf(process.platform === "win32")(
    "alt_recommendation 非 null → 逐日明细含「替代推荐：<name>（<reason>）」行",
    async () => {
      const itinerary = makeItinerary();
      itinerary.days[0].items[3].booking!.alt_recommendation = {
        name: "粉蒸牛肉馆",
        reason: "泡馍名气大但排队久，带老人小孩更适合粉蒸牛肉",
        url: "https://example.com/fenzheng",
        affiliate_url: null,
      };
      setupFixtureTrip({}, { days: itinerary.days });
      const result = await runWord(tripId);

      const xml = extractZipEntry(result.path, "word/document.xml");
      expect(xml).toContain("替代推荐：粉蒸牛肉馆（泡馍名气大但排队久，带老人小孩更适合粉蒸牛肉）");
      expect(xml).toContain("https://example.com/fenzheng");
    }
  );

  it("行程状态为 draft 时报错透传（由 buildManualData 抛出）", async () => {
    setupFixtureTrip({}, { status: "draft" });
    await expect(runWord(tripId)).rejects.toThrow();
  });

  it("itinerary.json 缺失时报错透传", async () => {
    const tripPath = createTrip("xinjiang-word-missing-itinerary");
    tripId = path.basename(tripPath);
    writeJson(tripId, "intake.json", makeIntake());
    await expect(runWord(tripId)).rejects.toThrow();
  });

  it("无 travelogues/index.json 时正常生成（附录为空）", async () => {
    setupFixtureTrip({}, {}, false);
    const result = await runWord(tripId);
    expect(existsSync(result.path)).toBe(true);
  });
});

describe("main / CLI", () => {
  it("③ --format 非 docx 时抛 CliError", async () => {
    setupFixtureTrip();
    await expect(main(["run", "--trip", tripId, "--format", "pdf"])).rejects.toThrow(CliError);
  });

  it("缺 --trip 抛 CliError", async () => {
    await expect(main(["run", "--format", "docx"])).rejects.toThrow(CliError);
  });

  it("未知子命令抛 CliError", async () => {
    await expect(main(["bogus", "--trip", "x", "--format", "docx"])).rejects.toThrow(CliError);
  });

  it("正常参数：生成文件并返回路径", async () => {
    setupFixtureTrip();
    const result = (await main(["run", "--trip", tripId, "--format", "docx"])) as { path: string };
    expect(existsSync(result.path)).toBe(true);
  });
});
