import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, CliError } from "../telemetry-cli";
import { readQueue, ensureTelemetryState } from "../lib/telemetry";

let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-tcli-"));
  process.env.PILOT_HOME = testPilotHome;
  delete process.env.PILOT_TELEMETRY;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  delete process.env.PILOT_TELEMETRY;
  if (existsSync(testPilotHome)) rmSync(testPilotHome, { recursive: true });
});

describe("telemetry-cli track", () => {
  it("白名单事件 + props → 入队，输出 tracked:true", async () => {
    const result = await main([
      "track",
      "trip_created",
      "--props",
      '{"destination":"新疆","days":10}',
    ]);
    expect(result).toEqual({ tracked: true, event: "trip_created" });
    const evt = readQueue().find((e) => e.event === "trip_created");
    expect(evt?.props).toEqual({ destination: "新疆", days: 10 });
  });

  it("白名单外 props 被剥离（对话内容永不采集）", async () => {
    const result = await main([
      "track",
      "export",
      "--props",
      '{"format":"pdf","conversation":"用户的私密对话","reason":"太贵"}',
    ]);
    expect(result).toEqual({ tracked: true, event: "export" });
    const evt = readQueue().find((e) => e.event === "export");
    expect(evt?.props).toEqual({ format: "pdf" });
  });

  it("--props 省略 → 空 props 入队", async () => {
    const result = await main(["track", "trip_created"]);
    expect(result).toEqual({ tracked: true, event: "trip_created" });
    const evt = readQueue().find((e) => e.event === "trip_created");
    expect(evt?.props).toEqual({});
  });

  it("【回归】install 是保留事件 → 手动 track 恒为 no-op，不会让安装量翻倍", async () => {
    // ensureTelemetryState 首次运行已自动入队 1 条 install
    ensureTelemetryState();
    const before = readQueue().filter((e) => e.event === "install").length;
    expect(await main(["track", "install"])).toEqual({ tracked: false, event: "install" });
    expect(readQueue().filter((e) => e.event === "install")).toHaveLength(before);
  });

  it("白名单外事件 → tracked:false（正常 no-op，不报错）", async () => {
    const result = await main(["track", "page_view", "--props", "{}"]);
    expect(result).toEqual({ tracked: false, event: "page_view" });
    expect(readQueue().filter((e) => (e.event as string) === "page_view")).toHaveLength(0);
  });

  it("PILOT_TELEMETRY=off → tracked:false，不入队", async () => {
    process.env.PILOT_TELEMETRY = "off";
    const result = await main(["track", "export", "--props", '{"format":"pdf"}']);
    expect(result).toEqual({ tracked: false, event: "export" });
    expect(readQueue()).toHaveLength(0);
  });

  it("--props 非法 JSON / 非对象 → CliError", async () => {
    await expect(main(["track", "export", "--props", "{oops"])).rejects.toThrow(CliError);
    await expect(main(["track", "export", "--props", '["a"]'])).rejects.toThrow(/JSON 对象/);
  });

  it("缺事件名 → CliError 用法提示", async () => {
    await expect(main(["track"])).rejects.toThrow(/用法/);
  });
});

describe("telemetry-cli flush", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // 网络隔离：真实 config/pilot.json 的 endpoint 已接线，单元测试绝不能打真网络。
    // 把 fetch 换成必然失败的实现 → 任何意外触网都会走「失败保留队列」分支。
    globalThis.fetch = (() => Promise.reject(new Error("单元测试禁止真实网络请求"))) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("上报失败（网络不可用）→ 队列原样保留，sent=0，且不抛异常", async () => {
    await main(["track", "export", "--props", '{"format":"pdf"}']);
    const before = readQueue().length;
    const result = (await main(["flush"])) as { sent: number; kept: number };
    expect(result.sent).toBe(0);
    expect(result.kept).toBe(before);
  });
});

describe("telemetry-cli 未知子命令", () => {
  it("exit 路径抛 CliError", async () => {
    await expect(main(["nope"])).rejects.toThrow(/未知子命令/);
  });
});
