import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, readJson, tripDir } from "../lib/workspace";
import { reportProgress, clearProgress, truncateForLog, shouldReportTick } from "../lib/progress";

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-progress-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("progress-test");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

describe("reportProgress", () => {
  it("原子写 progress.json，字段齐全（stage/current/total/message/updated_at）", () => {
    const before = Date.now();
    const state = reportProgress(tripId, {
      stage: "fetch",
      current: 3,
      total: 10,
      message: "抓取中: https://example.com",
    });

    expect(state.stage).toBe("fetch");
    expect(state.current).toBe(3);
    expect(state.total).toBe(10);
    expect(state.message).toBe("抓取中: https://example.com");
    expect(new Date(state.updated_at).getTime()).toBeGreaterThanOrEqual(before);

    const onDisk = readJson<typeof state>(tripId, "progress.json");
    expect(onDisk).toEqual(state);
  });

  it("current/total 省略时落盘为 null（total 未知 → UI 显示沙漏）", () => {
    const state = reportProgress(tripId, { stage: "video", message: "下载中" });
    expect(state.current).toBeNull();
    expect(state.total).toBeNull();

    const onDisk = readJson<typeof state>(tripId, "progress.json");
    expect(onDisk.current).toBeNull();
    expect(onDisk.total).toBeNull();
  });

  it("current/total 显式传 null 时同样落盘为 null", () => {
    const state = reportProgress(tripId, { stage: "video", current: null, total: null, message: "下载中" });
    expect(state.current).toBeNull();
    expect(state.total).toBeNull();
  });

  it("重复调用会原子覆盖上一次的内容（不残留旧字段）", () => {
    reportProgress(tripId, { stage: "search", current: 1, total: 5, message: "第一条" });
    const second = reportProgress(tripId, { stage: "fetch", message: "第二条（total 未知）" });

    const onDisk = readJson<typeof second>(tripId, "progress.json");
    expect(onDisk).toEqual(second);
    expect(onDisk.stage).toBe("fetch");
    expect(onDisk.total).toBeNull();
  });

  it("向 stderr 打一行人类可读进度：有 total 时带 current/total 计数", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      reportProgress(tripId, { stage: "fetch", current: 12, total: 50, message: "抓取中: 示例" });
      expect(spy).toHaveBeenCalledWith("[fetch 12/50] 抓取中: 示例\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("向 stderr 打一行人类可读进度：total 未知时不带计数", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      reportProgress(tripId, { stage: "video", message: "下载中" });
      expect(spy).toHaveBeenCalledWith("[video] 下载中\n");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("clearProgress", () => {
  it("删除已存在的 progress.json", () => {
    reportProgress(tripId, { stage: "export", current: 1, total: 1, message: "完成" });
    const filePath = path.join(tripDir(tripId), "progress.json");
    expect(existsSync(filePath)).toBe(true);

    clearProgress(tripId);
    expect(existsSync(filePath)).toBe(false);
  });

  it("progress.json 不存在时 no-op，不抛错", () => {
    expect(() => clearProgress(tripId)).not.toThrow();
  });
});

describe("truncateForLog", () => {
  it("不超长时原样返回", () => {
    expect(truncateForLog("短字符串")).toBe("短字符串");
  });

  it("超长时截断并加省略号，长度不超过 maxLen", () => {
    const long = "a".repeat(100);
    const result = truncateForLog(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("shouldReportTick", () => {
  it("total<=0 恒为 false", () => {
    expect(shouldReportTick(0, 0)).toBe(false);
    expect(shouldReportTick(0, -1)).toBe(false);
  });

  it("首条、每 10 条、末条上报，其余不报（everyN 默认 10）", () => {
    const total = 23;
    const reported = Array.from({ length: total }, (_, i) => i).filter((i) => shouldReportTick(i, total));
    expect(reported).toEqual([0, 9, 19, 22]);
  });

  it("everyN 可自定义", () => {
    const total = 12;
    const reported = Array.from({ length: total }, (_, i) => i).filter((i) => shouldReportTick(i, total, 5));
    expect(reported).toEqual([0, 4, 9, 11]);
  });
});
