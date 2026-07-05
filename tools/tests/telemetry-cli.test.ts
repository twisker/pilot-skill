import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, CliError } from "../telemetry-cli";
import { readQueue } from "../lib/telemetry";

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
      "reco_impression",
      "--props",
      '{"product_id":"pd-xj001","match_score":0.85}',
    ]);
    expect(result).toEqual({ tracked: true, event: "reco_impression" });
    const evt = readQueue().find((e) => e.event === "reco_impression");
    expect(evt?.props).toEqual({ product_id: "pd-xj001", match_score: 0.85 });
  });

  it("reco_dismissed 在白名单内，props 只留 product_id", async () => {
    const result = await main([
      "track",
      "reco_dismissed",
      "--props",
      '{"product_id":"pd-xj001","reason":"用户嫌贵"}',
    ]);
    expect(result).toEqual({ tracked: true, event: "reco_dismissed" });
    const evt = readQueue().find((e) => e.event === "reco_dismissed");
    // reason 不在 props 白名单 → 被剥离（拒绝原因属对话内容，不采集）
    expect(evt?.props).toEqual({ product_id: "pd-xj001" });
  });

  it("booking_link_shown 在白名单内，props 只留 code", async () => {
    const result = await main([
      "track",
      "booking_link_shown",
      "--props",
      '{"code":"hotel-abc1234567","match_score":0.9}',
    ]);
    expect(result).toEqual({ tracked: true, event: "booking_link_shown" });
    const evt = readQueue().find((e) => e.event === "booking_link_shown");
    expect(evt?.props).toEqual({ code: "hotel-abc1234567" });
  });

  it("--props 省略 → 空 props 入队", async () => {
    const result = await main(["track", "export", "--props", '{"format":"pdf"}']);
    expect(result).toEqual({ tracked: true, event: "export" });
    expect(await main(["track", "install"])).toEqual({ tracked: true, event: "install" });
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
  it("endpoint 未配置（当前默认）→ 队列保留，不上报", async () => {
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
