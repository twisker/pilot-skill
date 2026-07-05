import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureTelemetryState,
  telemetryEnabled,
  track,
  flush,
  readQueue,
  readTelemetryEndpoint,
  QUEUE_MAX,
} from "../lib/telemetry";

let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-telemetry-"));
  process.env.PILOT_HOME = testPilotHome;
  delete process.env.PILOT_TELEMETRY;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  delete process.env.PILOT_TELEMETRY;
  if (existsSync(testPilotHome)) rmSync(testPilotHome, { recursive: true });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("ensureTelemetryState", () => {
  it("首次生成 UUID + created_at + enabled，并入队 install 事件", () => {
    const state = ensureTelemetryState();
    expect(state.install_id).toMatch(UUID_PATTERN);
    expect(state.enabled).toBe(true);
    expect(new Date(state.created_at).toISOString()).toBe(state.created_at);

    const onDisk = JSON.parse(
      readFileSync(path.join(testPilotHome, "telemetry.json"), "utf-8")
    );
    expect(onDisk.install_id).toBe(state.install_id);

    const queue = readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].event).toBe("install");
  });

  it("二次调用不换 id、不重复 install 事件", () => {
    const first = ensureTelemetryState();
    const second = ensureTelemetryState();
    expect(second.install_id).toBe(first.install_id);
    expect(readQueue()).toHaveLength(1);
  });
});

describe("track", () => {
  it("白名单事件入队，props 按白名单过滤", () => {
    expect(track("trip_created", { destination: "新疆", days: 10, conversation: "秘密" })).toBe(true);
    const queue = readQueue();
    const evt = queue.find((e) => e.event === "trip_created");
    expect(evt?.props).toEqual({ destination: "新疆", days: 10 });
  });

  it("reco_dismissed 在白名单内，props 留 product_id/scope/item_ref，拒绝原因剥离", () => {
    expect(
      track("reco_dismissed", {
        product_id: "pd-xj001",
        scope: "item",
        item_ref: "2:羊肉泡馍老店",
        reason: "太贵",
      })
    ).toBe(true);
    const evt = readQueue().find((e) => e.event === "reco_dismissed");
    expect(evt?.props).toEqual({
      product_id: "pd-xj001",
      scope: "item",
      item_ref: "2:羊肉泡馍老店",
    });
  });

  it("reco_impression 可选 scope/item_ref 通过白名单（trip 级可不带）", () => {
    expect(
      track("reco_impression", {
        product_id: "pd-xj001",
        match_score: 0.85,
        scope: "item",
        item_ref: "2:羊肉泡馍老店",
        conversation: "推荐语全文不许进来",
      })
    ).toBe(true);
    const evt = readQueue().find((e) => e.event === "reco_impression");
    expect(evt?.props).toEqual({
      product_id: "pd-xj001",
      match_score: 0.85,
      scope: "item",
      item_ref: "2:羊肉泡馍老店",
    });
  });

  it("booking_link_shown 在白名单内，props 只留 code（不带 match_score）", () => {
    expect(
      track("booking_link_shown", { code: "hotel-abc1234567", match_score: 0.9 })
    ).toBe(true);
    const evt = readQueue().find((e) => e.event === "booking_link_shown");
    expect(evt?.props).toEqual({ code: "hotel-abc1234567" });
  });

  it("白名单外事件 no-op", () => {
    expect(track("page_view", {})).toBe(false);
    expect(readQueue()).toHaveLength(0);
  });

  it("PILOT_TELEMETRY=off → no-op（不建状态文件、不入队）", () => {
    process.env.PILOT_TELEMETRY = "off";
    expect(track("export", { format: "pdf" })).toBe(false);
    expect(existsSync(path.join(testPilotHome, "telemetry.json"))).toBe(false);
    expect(readQueue()).toHaveLength(0);
  });

  it("telemetry.json 损坏（非法 JSON）→ 按 disabled 处理，不重建/不重发 install", () => {
    const p = path.join(testPilotHome, "telemetry.json");
    writeFileSync(p, "{not valid json");
    expect(telemetryEnabled()).toBe(false);
    expect(track("export", { format: "pdf" })).toBe(false);
    expect(readQueue()).toHaveLength(0);
    // 文件本身未被覆盖/重建
    expect(readFileSync(p, "utf-8")).toBe("{not valid json");
  });

  it("ensureTelemetryState 遇损坏文件返回保守占位状态，不落盘不入队", () => {
    const p = path.join(testPilotHome, "telemetry.json");
    writeFileSync(p, "{not valid json");
    const state = ensureTelemetryState();
    expect(state.enabled).toBe(false);
    expect(state.install_id).toBe("");
    expect(readFileSync(p, "utf-8")).toBe("{not valid json");
    expect(readQueue()).toHaveLength(0);
  });

  it("telemetry.json enabled:false → no-op", () => {
    writeFileSync(
      path.join(testPilotHome, "telemetry.json"),
      JSON.stringify({ install_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", created_at: "2026-07-01T00:00:00.000Z", enabled: false })
    );
    expect(track("export", { format: "pdf" })).toBe(false);
    expect(readQueue()).toHaveLength(0);
  });

  it("队列超上限丢最旧", () => {
    ensureTelemetryState(); // 占 1 条 install
    for (let i = 0; i < QUEUE_MAX + 10; i++) {
      track("export", { format: `f${i}` });
    }
    const queue = readQueue();
    expect(queue).toHaveLength(QUEUE_MAX);
    // 最旧的 install 与前几条 export 被丢弃，最新一条保留
    expect(queue[0].event).toBe("export");
    expect(queue[queue.length - 1].props.format).toBe(`f${QUEUE_MAX + 9}`);
  });
});

describe("flush", () => {
  it("endpoint 为 null（当前默认）→ 只落盘不上报，队列保留", async () => {
    track("export", { format: "pdf" });
    const before = readQueue().length;
    const result = await flush({ endpoint: null });
    expect(result.sent).toBe(0);
    expect(result.kept).toBe(before);
    expect(readQueue()).toHaveLength(before);
  });

  it("上报成功 → 清空队列，body 含 install_id + events", async () => {
    const state = ensureTelemetryState();
    track("export", { format: "pdf" });
    let posted: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      posted = { url: String(url), body: JSON.parse(String(init?.body)) };
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const result = await flush({ endpoint: "https://go.example.com/t", fetchImpl });
    expect(result.sent).toBe(2); // install + export
    expect(readQueue()).toHaveLength(0);
    expect(posted!.url).toBe("https://go.example.com/t");
    expect((posted!.body as { install_id: string }).install_id).toBe(state.install_id);
  });

  it("上报失败（HTTP 500 / 网络错误）→ 队列保留", async () => {
    track("export", { format: "pdf" });
    const n = readQueue().length;
    const fail500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const result = await flush({ endpoint: "https://go.example.com/t", fetchImpl: fail500 });
    expect(result.sent).toBe(0);
    expect(readQueue()).toHaveLength(n);

    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result2 = await flush({ endpoint: "https://go.example.com/t", fetchImpl: throwing });
    expect(result2.sent).toBe(0);
    expect(result2.reason).toBe("offline");
    expect(readQueue()).toHaveLength(n);
  });

  it("遥测关闭 → flush no-op", async () => {
    track("export", { format: "pdf" });
    process.env.PILOT_TELEMETRY = "off";
    const result = await flush({ endpoint: "https://go.example.com/t" });
    expect(result.sent).toBe(0);
  });
});

describe("readTelemetryEndpoint", () => {
  it("config 缺 telemetry 或 endpoint null → null", () => {
    const p = path.join(testPilotHome, "pilot.json");
    writeFileSync(p, JSON.stringify({ locale: "zh" }));
    expect(readTelemetryEndpoint(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ telemetry: { endpoint: null } }));
    expect(readTelemetryEndpoint(p)).toBeNull();
  });

  it("配置了 endpoint → 返回 URL", () => {
    const p = path.join(testPilotHome, "pilot.json");
    writeFileSync(p, JSON.stringify({ telemetry: { endpoint: "https://go-cn.example.cn/t" } }));
    expect(readTelemetryEndpoint(p)).toBe("https://go-cn.example.cn/t");
  });

  it("项目默认 config/pilot.json 当前 endpoint 为 null（默认不上报）", () => {
    expect(readTelemetryEndpoint()).toBeNull();
  });
});

describe("telemetryEnabled", () => {
  it("默认 true；off 环境变量 false", () => {
    expect(telemetryEnabled()).toBe(true);
    process.env.PILOT_TELEMETRY = "OFF";
    expect(telemetryEnabled()).toBe(false);
  });
});
