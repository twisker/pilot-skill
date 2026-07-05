import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";

// PILOT v4.0 四大冻结契约 schema 校验测试
// 每个 schema：加载 + 1 条合法 fixture 通过 + 1 条非法 fixture（缺 required 字段）被拒绝
//
// 说明：schema 里用了 format: "uri" / "date" / "date-time" 作为文档性标注，
// 但本项目未引入 ajv-formats（brief Step 1 未列出该依赖），故用 { strict: false }
// 让未知 format 只作注解、不参与校验——不影响本测试关注的 required 字段校验。

const schemaDir = path.resolve(__dirname, "../../shared/schema");

function loadSchema(name: string) {
  return JSON.parse(readFileSync(path.join(schemaDir, name), "utf-8"));
}

const ajv = new Ajv({ strict: false, allErrors: true });

function compile(name: string): ValidateFunction {
  return ajv.compile(loadSchema(name));
}

describe("intake.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compile("intake.schema.json");
  });

  it("接受合法 intake fixture", () => {
    const valid = {
      trip_id: "xinjiang-20260726",
      destination: "新疆",
      dates: { start: "2026-07-26", end: "2026-08-02" },
      party: { adults: 2, children: 0, seniors: 2 },
      budget_cny: 20000,
      transport: "self-drive",
      preferences: ["自驾", "摄影"],
      origin_city: "上海",
      locale: "zh",
    };
    expect(validate(valid)).toBe(true);
  });

  it("拒绝缺少 destination 的 intake fixture", () => {
    const invalid = {
      trip_id: "xinjiang-20260726",
      // destination 缺失
      dates: { start: "2026-07-26", end: "2026-08-02" },
      party: { adults: 2, children: 0, seniors: 2 },
      budget_cny: 20000,
      transport: "self-drive",
      preferences: ["自驾", "摄影"],
      origin_city: "上海",
      locale: "zh",
    };
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.some((e) => e.params?.missingProperty === "destination")).toBe(
      true,
    );
  });
});

describe("travelogue.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compile("travelogue.schema.json");
  });

  it("接受合法 travelogue fixture", () => {
    const valid = {
      id: "a1b2c3d4e5f6",
      meta: {
        title: "北疆9天自驾环线",
        author: "张三",
        source: {
          url: "https://www.mafengwo.cn/i/123456.html",
          platform: "mafengwo",
          media_type: "text",
        },
        published_at: "2026-05-01",
        fetch_quality: "full",
      },
      summary: {
        brief: "北疆9天自驾环线，涵盖禾木、喀纳斯、白哈巴。",
        tags: ["自驾", "摄影"],
      },
      route: {
        days: [
          {
            day: 1,
            pois: [{ name: "乌鲁木齐", kind: "sight", note: "抵达当天休整" }],
            transport: "飞机",
            stay: "乌鲁木齐",
          },
        ],
      },
      quality: {
        deterministic: {
          completeness: 0.8,
          granularity: 0.7,
          media_richness: 0.5,
          freshness: 0.9,
        },
        taste_score: 8,
        total: 8.2,
      },
    };
    expect(validate(valid)).toBe(true);
  });

  it("拒绝缺少 meta.fetch_quality 的 travelogue fixture", () => {
    const invalid = {
      id: "a1b2c3d4e5f6",
      meta: {
        title: "北疆9天自驾环线",
        author: "张三",
        source: {
          url: "https://www.mafengwo.cn/i/123456.html",
          platform: "mafengwo",
          media_type: "text",
        },
        published_at: "2026-05-01",
        // fetch_quality 缺失
      },
      summary: {
        brief: "北疆9天自驾环线，涵盖禾木、喀纳斯、白哈巴。",
        tags: ["自驾", "摄影"],
      },
      route: {
        days: [
          {
            day: 1,
            pois: [{ name: "乌鲁木齐", kind: "sight", note: "抵达当天休整" }],
            transport: "飞机",
            stay: "乌鲁木齐",
          },
        ],
      },
      quality: {
        deterministic: {
          completeness: 0.8,
          granularity: 0.7,
          media_richness: 0.5,
          freshness: 0.9,
        },
        taste_score: 8,
        total: 8.2,
      },
    };
    expect(validate(invalid)).toBe(false);
    expect(
      validate.errors?.some((e) => e.params?.missingProperty === "fetch_quality"),
    ).toBe(true);
  });
});

describe("itinerary.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compile("itinerary.schema.json");
  });

  it("接受合法 itinerary fixture（agency_recommendation 恒 null）", () => {
    const valid = {
      trip_id: "xinjiang-20260726",
      status: "draft",
      base_travelogue: "a1b2c3d4e5f6",
      days: [
        {
          day: 1,
          date: "2026-07-26",
          source_ref: { travelogue_id: "a1b2c3d4e5f6", day: 1 },
          items: [
            {
              time: "09:00",
              kind: "sight",
              name: "天山天池",
              note: "上午游览，注意防晒",
              geo: { lat: 43.88, lng: 88.13 },
              cost_cny: 150,
              booking: {
                type: "ticket",
                name: "天池门票",
                url: "https://example.com/ticket",
                affiliate_url: null,
                alt_recommendation: null,
              },
            },
          ],
        },
      ],
      agency_recommendation: null,
      conflicts_checked_at: null,
    };
    expect(validate(valid)).toBe(true);
  });

  it("拒绝缺少 status 的 itinerary fixture", () => {
    const invalid = {
      trip_id: "xinjiang-20260726",
      // status 缺失
      base_travelogue: "a1b2c3d4e5f6",
      days: [],
      agency_recommendation: null,
      conflicts_checked_at: null,
    };
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.some((e) => e.params?.missingProperty === "status")).toBe(
      true,
    );
  });
});

describe("search-plan.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compile("search-plan.schema.json");
  });

  it("接受合法 search-plan fixture", () => {
    const valid = {
      trip_id: "xinjiang-20260726",
      query_intent: "云南自驾6天带孩子",
      sources: [
        {
          name: "马蜂窝",
          category: "travelogue",
          method: "websearch",
          queries: ["云南自驾6天游记"],
          status: "pending",
          result_count: 0,
        },
      ],
      coverage_note: null,
    };
    expect(validate(valid)).toBe(true);
  });

  it("拒绝缺少 sources 的 search-plan fixture", () => {
    const invalid = {
      trip_id: "xinjiang-20260726",
      query_intent: "云南自驾6天带孩子",
      // sources 缺失
      coverage_note: null,
    };
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.some((e) => e.params?.missingProperty === "sources")).toBe(
      true,
    );
  });
});
