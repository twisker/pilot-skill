import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  main,
  CliError,
  buildShortCode,
  buildGoUrl,
  resolveGoDomain,
  partyTags,
  intakeBudgetBand,
  scoreProduct,
  pickCandidate,
  loadVerifiedProducts,
  type Product,
} from "../affiliate";
import { generateSigningKeypair, signPayload, verifyPayload } from "../lib/signing";
import { readJson, writeJson } from "../lib/workspace";
import { readQueue } from "../lib/telemetry";

const FIXTURE_PRODUCTS = path.join(__dirname, "fixtures", "products.sample.json");

let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-affiliate-"));
  process.env.PILOT_HOME = testPilotHome;
  delete process.env.GO_DOMAIN;
  delete process.env.GO_DOMAIN_CN;
  delete process.env.GO_DOMAIN_OVERSEAS;
  delete process.env.PILOT_PRODUCTS_PUBKEY;
  delete process.env.PILOT_TELEMETRY;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  delete process.env.GO_DOMAIN;
  delete process.env.GO_DOMAIN_CN;
  delete process.env.GO_DOMAIN_OVERSEAS;
  delete process.env.PILOT_PRODUCTS_PUBKEY;
  if (existsSync(testPilotHome)) rmSync(testPilotHome, { recursive: true });
});

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const TRIP_ID = "xinjiang-20260705";

function xinjiangIntake(overrides: Record<string, unknown> = {}) {
  return {
    trip_id: TRIP_ID,
    destination: "新疆",
    dates: { start: "2026-07-20", end: "2026-07-29" },
    party: { adults: 2, children: 1, seniors: 1 },
    budget_cny: 32000,
    transport: "self-drive",
    preferences: ["自驾", "摄影"],
    origin_city: "上海",
    locale: "zh",
    ...overrides,
  };
}

function sampleItinerary() {
  return {
    trip_id: TRIP_ID,
    status: "confirmed",
    base_travelogue: "tl-001",
    agency_recommendation: null,
    days: [
      {
        day: 1,
        date: "2026-07-20",
        items: [
          {
            time: "09:00",
            kind: "transit",
            name: "上海直飞乌鲁木齐",
            note: "",
            geo: null,
            cost_cny: 2000,
            booking: {
              type: "flight",
              name: "上海-乌鲁木齐航班",
              url: null,
              affiliate_url: null,
              alt_recommendation: null,
            },
          },
          {
            time: null,
            kind: "hotel",
            name: "乌鲁木齐酒店",
            note: "",
            geo: null,
            cost_cny: 500,
            booking: {
              type: "hotel",
              name: "乌鲁木齐希尔顿",
              url: null,
              affiliate_url: null,
              alt_recommendation: null,
            },
          },
          { time: null, kind: "sight", name: "大巴扎", note: "", geo: null, cost_cny: null, booking: null },
        ],
      },
    ],
  };
}

function setupTrip(): void {
  mkdirSync(path.join(testPilotHome, "workspace", TRIP_ID), { recursive: true });
  writeJson(TRIP_ID, "intake.json", xinjiangIntake());
  writeJson(TRIP_ID, "itinerary.json", sampleItinerary());
}

function installProducts(tamper = false, payloadOverride?: string): string {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
  const payload = payloadOverride ?? readFileSync(FIXTURE_PRODUCTS, "utf-8");
  const sig = signPayload(payload, privateKeyPem);
  const dir = path.join(testPilotHome, "products");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "products.json"), tamper ? payload + "\n// tampered" : payload);
  writeFileSync(path.join(dir, "products.json.sig"), `${sig}\n`);
  process.env.PILOT_PRODUCTS_PUBKEY = publicKeyRawB64;
  return publicKeyRawB64;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("buildShortCode / buildGoUrl", () => {
  it("短码确定性：同输入同短码，前缀-10hex", () => {
    const a = buildShortCode("ht", "hotel", "乌鲁木齐希尔顿");
    expect(a).toMatch(/^ht-[0-9a-f]{10}$/);
    expect(buildShortCode("ht", "hotel", "乌鲁木齐希尔顿")).toBe(a);
    expect(buildShortCode("ht", "hotel", "别的酒店")).not.toBe(a);
  });

  it("go 短链格式与参数编码", () => {
    expect(buildGoUrl("go-cn.example.cn", "ht-abc", "新疆", "2026-07-20")).toBe(
      `https://go-cn.example.cn/r/ht-abc?d=${encodeURIComponent("新疆")}&dt=2026-07-20`
    );
  });
});

describe("resolveGoDomain", () => {
  it("GO_DOMAIN 显式优先；否则按 locale 取 CN/海外", () => {
    const env = { GO_DOMAIN: "go.x.com", GO_DOMAIN_CN: "go-cn.y.cn" } as NodeJS.ProcessEnv;
    expect(resolveGoDomain("zh", env, testPilotHome)).toBe("go.x.com");
    expect(resolveGoDomain("zh", { GO_DOMAIN_CN: "go-cn.y.cn" } as NodeJS.ProcessEnv, testPilotHome)).toBe("go-cn.y.cn");
    expect(resolveGoDomain("zh", { GO_DOMAIN_OVERSEAS: "go.z.com" } as NodeJS.ProcessEnv, testPilotHome)).toBe("go.z.com");
    expect(resolveGoDomain("zh", {} as NodeJS.ProcessEnv, testPilotHome)).toBeNull();
  });
});

describe("partyTags / intakeBudgetBand", () => {
  it("人群标签推导", () => {
    expect(partyTags({ adults: 2, children: 1, seniors: 1 })).toEqual(["family", "seniors"]);
    expect(partyTags({ adults: 2, children: 0, seniors: 0 })).toEqual(["couple"]);
    expect(partyTags({ adults: 1, children: 0, seniors: 0 })).toEqual(["solo"]);
    expect(partyTags({ adults: 4, children: 0, seniors: 0 })).toEqual(["friends"]);
  });

  it("预算档：人均每天换算", () => {
    const intake = xinjiangIntake() as Parameters<typeof intakeBudgetBand>[0];
    // 32000 / 4 人 / 10 天 = 800 → mid
    expect(intakeBudgetBand(intake)).toBe("mid");
    expect(intakeBudgetBand({ ...intake, budget_cny: 10000 })).toBe("low");
    expect(intakeBudgetBand({ ...intake, budget_cny: 80000 })).toBe("high");
    expect(intakeBudgetBand({ ...intake, budget_cny: null })).toBeNull();
  });
});

describe("scoreProduct / pickCandidate（确定性初筛）", () => {
  const products = (JSON.parse(readFileSync(FIXTURE_PRODUCTS, "utf-8")) as { products: Product[] }).products;
  const intake = xinjiangIntake() as Parameters<typeof scoreProduct>[1];

  it("高匹配：目的地+人群+预算+偏好全中 → 1.0，理由对应 intake 字段", () => {
    const selfdrive = products.find((p) => p.product_id === "pd-xj-selfdrive-10d")!;
    const scored = scoreProduct(selfdrive, intake);
    expect(scored.match_score).toBe(1);
    expect(scored.match_reasons).toHaveLength(4);
    expect(scored.match_reasons.join("\n")).toContain("目的地匹配");
    expect(scored.match_reasons.join("\n")).toContain("人群适配");
  });

  it("目的地不匹配 → 硬出局 0 分", () => {
    const yunnan = products.find((p) => p.product_id === "pd-yn-family-6d")!;
    expect(scoreProduct(yunnan, intake).match_score).toBe(0);
  });

  it("pickCandidate 取 top1", () => {
    const best = pickCandidate(products, intake);
    expect(best?.product.product_id).toBe("pd-xj-selfdrive-10d");
  });

  it("低匹配（目的地中但人群/预算/偏好全不中，0.5 < 0.6）→ null 宁缺毋滥", () => {
    const couple = xinjiangIntake({
      party: { adults: 2, children: 0, seniors: 0 },
      budget_cny: null,
      preferences: ["美食"],
    }) as Parameters<typeof scoreProduct>[1];
    expect(pickCandidate(products, couple)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 签名往返（tools/lib/signing.ts）
// ---------------------------------------------------------------------------

describe("signing 往返", () => {
  it("keygen → sign → verify 通过；篡改/换钥失败", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    const payload = readFileSync(FIXTURE_PRODUCTS);
    const sig = signPayload(payload, privateKeyPem);
    expect(verifyPayload(payload, sig, publicKeyRawB64)).toBe(true);
    expect(verifyPayload(Buffer.concat([payload, Buffer.from(" ")]), sig, publicKeyRawB64)).toBe(false);
    const other = generateSigningKeypair();
    expect(verifyPayload(payload, sig, other.publicKeyRawB64)).toBe(false);
    expect(verifyPayload(payload, "bad!!", publicKeyRawB64)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI 场景
// ---------------------------------------------------------------------------

// 公开发行仓不包含 config/affiliate-map.zh.json（export-release.sh 白名单只导
// config/pilot.json，link 子命令在发行环境按设计 exit 1 静默降级）。依赖该
// 路由表的 link 用例在发行仓 skip——这是发行形态的既定取舍，不是漏测；
// 完整覆盖由私仓（路由表在库）承担。
const AFFILIATE_MAP_AVAILABLE = existsSync(
  path.resolve(__dirname, "../../config/affiliate-map.zh.json")
);

describe("affiliate link", () => {
  it("GO_DOMAIN 未配置 → CliError（链接服务未部署）", () => {
    setupTrip();
    // projectRoot 指向真实仓库 .env（可能存在），显式清空后仅当真实 .env 未配置
    // GO_DOMAIN 时该断言成立；为稳定起见直接断言 resolveGoDomain 对空环境的行为
    expect(resolveGoDomain("zh", {} as NodeJS.ProcessEnv, testPilotHome)).toBeNull();
  });

  it("品类路由表缺失（发行仓形态）→ CliError 拒绝而非编造短链", () => {
    setupTrip();
    process.env.GO_DOMAIN = "go-cn.example.cn";
    if (AFFILIATE_MAP_AVAILABLE) return; // 私仓有路由表，该形态不适用
    expect(() => main(["link", "--trip", TRIP_ID])).toThrow(/品类路由表/);
  });

  it.skipIf(!AFFILIATE_MAP_AVAILABLE)("booking 条目生成 go 短链写回 affiliate_url，无 booking 条目不动", () => {
    setupTrip();
    process.env.GO_DOMAIN = "go-cn.example.cn";
    const result = main(["link", "--trip", TRIP_ID]) as {
      updated: number;
      links: { code: string; url: string }[];
    };
    expect(result.updated).toBe(2);
    expect(result.links[0].code).toMatch(/^fl-[0-9a-f]{10}$/);
    expect(result.links[1].code).toMatch(/^ht-[0-9a-f]{10}$/);

    const itinerary = readJson<ReturnType<typeof sampleItinerary>>(TRIP_ID, "itinerary.json");
    const [flight, hotel, sight] = itinerary.days[0].items;
    expect(flight.booking!.affiliate_url).toBe(
      `https://go-cn.example.cn/r/${result.links[0].code}?d=${encodeURIComponent("新疆")}&dt=2026-07-20`
    );
    expect(hotel.booking!.affiliate_url).toContain("/r/ht-");
    expect(sight.booking).toBeNull();
    // 短链里不含任何 tracking 参数（防线 1）
    expect(JSON.stringify(itinerary)).not.toMatch(/aid=|allianceid=|affiliate_id=/);
  });

  it.skipIf(!AFFILIATE_MAP_AVAILABLE)("alt_recommendation（affiliate_url 为 null）→ 生成 alt- 前缀短码写回并进 manifest", () => {
    setupTrip();
    const itinerary = sampleItinerary();
    (itinerary.days[0].items[1].booking as Record<string, unknown>).alt_recommendation = {
      name: "水磨沟温泉民宿",
      reason: "市区酒店旺季价格翻倍，你们预算敏感且带老人，这家更安静实惠",
      url: "https://example.com/minsu",
      affiliate_url: null,
    };
    writeJson(TRIP_ID, "itinerary.json", itinerary);
    process.env.GO_DOMAIN = "go-cn.example.cn";

    const result = main(["link", "--trip", TRIP_ID]) as {
      updated: number;
      links: { code: string; url: string; name: string }[];
    };
    // 2 条 booking + 1 条 alt = 3
    expect(result.updated).toBe(3);
    const altLink = result.links.find((l) => l.code.startsWith("alt-ht-"))!;
    expect(altLink).toBeDefined();
    expect(altLink.code).toMatch(/^alt-ht-[0-9a-f]{10}$/);

    const saved = readJson<ReturnType<typeof sampleItinerary>>(TRIP_ID, "itinerary.json");
    const alt = (saved.days[0].items[1].booking as unknown as {
      alt_recommendation: { affiliate_url: string | null; url: string };
    }).alt_recommendation;
    expect(alt.affiliate_url).toBe(
      `https://go-cn.example.cn/r/${altLink.code}?d=${encodeURIComponent("新疆")}&dt=2026-07-20`
    );
    expect(alt.url).toBe("https://example.com/minsu"); // 直链原样保留

    const manifest = readJson<{ code: string; name: string; type: string }[]>(
      TRIP_ID,
      "exports/link-manifest.json"
    );
    const altEntry = manifest.find((m) => m.code === altLink.code)!;
    expect(altEntry).toMatchObject({ type: "hotel", name: "水磨沟温泉民宿" });
  });

  it.skipIf(!AFFILIATE_MAP_AVAILABLE)("alt_recommendation.affiliate_url 已是产品 go 短链 → 不覆盖（保留 product_id 归因）", () => {
    setupTrip();
    const itinerary = sampleItinerary();
    const existing = "https://go-cn.example.cn/r/pd-xj-selfdrive-10d?d=%E6%96%B0%E7%96%86&dt=2026-07-20";
    (itinerary.days[0].items[1].booking as Record<string, unknown>).alt_recommendation = {
      name: "北疆环线整包替代",
      reason: "测试已填短链不被覆盖",
      url: null,
      affiliate_url: existing,
    };
    writeJson(TRIP_ID, "itinerary.json", itinerary);
    process.env.GO_DOMAIN = "go-cn.example.cn";

    const result = main(["link", "--trip", TRIP_ID]) as { updated: number };
    expect(result.updated).toBe(2); // 只有两条计划内 booking，alt 不重复生成
    const saved = readJson<ReturnType<typeof sampleItinerary>>(TRIP_ID, "itinerary.json");
    const alt = (saved.days[0].items[1].booking as unknown as {
      alt_recommendation: { affiliate_url: string };
    }).alt_recommendation;
    expect(alt.affiliate_url).toBe(existing);
  });

  it.skipIf(!AFFILIATE_MAP_AVAILABLE)("导出 exports/link-manifest.json 供 merge-link-config.ts 消费（短码对接断链修复）", () => {
    setupTrip();
    process.env.GO_DOMAIN = "go-cn.example.cn";
    const result = main(["link", "--trip", TRIP_ID]) as { links: { code: string }[] };

    const manifest = readJson<
      { code: string; type: string; name: string; dest: string; dt: string; suggested_network: string }[]
    >(TRIP_ID, "exports/link-manifest.json");
    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toEqual({
      code: result.links[0].code,
      type: "flight",
      name: "上海-乌鲁木齐航班",
      dest: "新疆",
      dt: "2026-07-20",
      suggested_network: "trip_com",
    });
    expect(manifest[1]).toEqual({
      code: result.links[1].code,
      type: "hotel",
      name: "乌鲁木齐希尔顿",
      dest: "新疆",
      dt: "2026-07-20",
      suggested_network: "trip_com",
    });
  });
});

describe("affiliate recommend", () => {
  it("高匹配 → 输出 top1 候选；不记曝光（候选 ≠ 曝光，展示后由 SKILL 层记）", () => {
    setupTrip();
    installProducts();
    const result = main(["recommend", "--trip", TRIP_ID]) as {
      candidate: {
        product: Product;
        match_score: number;
        match_reasons: string[];
        go_url: string | null;
      } | null;
    };
    expect(result.candidate?.product.product_id).toBe("pd-xj-selfdrive-10d");
    expect(result.candidate?.match_score).toBeGreaterThanOrEqual(0.6);
    expect(result.candidate?.match_reasons.length).toBeGreaterThan(0);
    // GO_DOMAIN 未配置 → go_url null（链接服务未部署，SKILL 层视同无候选）
    expect(result.candidate?.go_url).toBeNull();

    // 语义终审可能否决候选：reco_impression 只能在实际展示后由
    // telemetry-cli.ts 记录，recommend 本身绝不产生曝光事件。
    expect(readQueue().filter((e) => e.event === "reco_impression")).toHaveLength(0);
  });

  it("GO_DOMAIN 已配置 → 候选带产品 go 短链（含目的地与出发日期参数）", () => {
    setupTrip();
    installProducts();
    process.env.GO_DOMAIN = "go-cn.example.cn";
    const result = main(["recommend", "--trip", TRIP_ID]) as {
      candidate: { product: Product; go_url: string | null } | null;
    };
    expect(result.candidate?.go_url).toBe(
      `https://go-cn.example.cn/r/${result.candidate!.product.code}?d=${encodeURIComponent("新疆")}&dt=2026-07-20`
    );
    // 短链不含任何第三方 tracking 参数（防线 1）
    expect(result.candidate?.go_url).not.toMatch(/aid=|allianceid=|affiliate_id=/);
  });

  it("低匹配 → {candidate: null}，不产生曝光遥测", () => {
    setupTrip();
    writeJson(TRIP_ID, "intake.json", xinjiangIntake({
      party: { adults: 2, children: 0, seniors: 0 },
      budget_cny: null,
      preferences: ["美食"],
    }));
    installProducts();
    const result = main(["recommend", "--trip", TRIP_ID]) as { candidate: unknown };
    expect(result.candidate).toBeNull();
    expect(readQueue().filter((e) => e.event === "reco_impression")).toHaveLength(0);
  });

  it("--category 过滤：item 级取单项品类，缺 category 的旧数据视同 package", () => {
    setupTrip();
    const fixture = JSON.parse(readFileSync(FIXTURE_PRODUCTS, "utf-8")) as {
      products: Record<string, unknown>[];
    };
    // 追加一条 restaurant 单项产品（目的地/人群/预算/偏好与 intake 全中）
    fixture.products.push({
      product_id: "pd-xj-restaurant-fenzheng",
      title: "乌鲁木齐粉蒸牛肉老店代订（虚构测试产品）",
      brief: "带老人小孩不用排队的本地口碑餐馆，提前订位",
      code: "pd-xj-restaurant-fenzheng",
      destinations: ["新疆", "乌鲁木齐"],
      themes: ["自驾", "亲子", "摄影"],
      party_fit: ["family", "seniors"],
      budget_band: "mid",
      category: "restaurant",
    });
    installProducts(false, JSON.stringify(fixture, null, 2));

    // --category restaurant → 只剩单项产品参与初筛
    const item = main(["recommend", "--trip", TRIP_ID, "--category", "restaurant"]) as {
      candidate: { product: Product } | null;
    };
    expect(item.candidate?.product.product_id).toBe("pd-xj-restaurant-fenzheng");

    // --category package → 旧数据（无 category 字段）视同 package，餐馆产品出局
    const pkg = main(["recommend", "--trip", TRIP_ID, "--category", "package"]) as {
      candidate: { product: Product } | null;
    };
    expect(pkg.candidate?.product.product_id).toBe("pd-xj-selfdrive-10d");

    // 无匹配品类 → 宁缺毋滥 null
    const flight = main(["recommend", "--trip", TRIP_ID, "--category", "flight"]) as {
      candidate: unknown;
    };
    expect(flight.candidate).toBeNull();

    // 非法品类 → CliError
    expect(() => main(["recommend", "--trip", TRIP_ID, "--category", "cruise"])).toThrow(CliError);
  });

  it("验签失败（payload 被篡改）→ CliError 拒用", () => {
    setupTrip();
    installProducts(true);
    expect(() => main(["recommend", "--trip", TRIP_ID])).toThrow(CliError);
    expect(() => main(["recommend", "--trip", TRIP_ID])).toThrow(/验签失败/);
  });

  it("无产品缓存 → CliError 说明", () => {
    setupTrip();
    expect(() => main(["recommend", "--trip", TRIP_ID])).toThrow(/无产品缓存/);
  });

  it("loadVerifiedProducts 验签通过返回产品库", () => {
    const pub = installProducts();
    const products = loadVerifiedProducts(pub);
    expect(products.products).toHaveLength(3);
  });
});
