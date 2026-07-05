import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { main, CliError } from "../trip";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 用临时 PILOT_HOME 隔离测试
let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-trip-test-"));
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

describe("trip CLI", () => {
  it("new <slug> 创建 trip 目录树并返回 trip_id + path", () => {
    const result = main(["new", "xinjiang-selfdrive"]) as {
      trip_id: string;
      path: string;
    };

    expect(result.trip_id).toMatch(/^xinjiang-selfdrive-\d{8}$/);
    expect(result.path).toContain(path.join("workspace", result.trip_id));
    expect(existsSync(path.join(result.path, "raw"))).toBe(true);
    expect(existsSync(path.join(result.path, "travelogues"))).toBe(true);
    expect(existsSync(path.join(result.path, "exports"))).toBe(true);
    // current-trip.json 指针写入
    expect(existsSync(path.join(testPilotHome, "current-trip.json"))).toBe(true);
  });

  it("new 缺 slug 抛 CliError", () => {
    expect(() => main(["new"])).toThrow(CliError);
  });

  it("new 非法 slug（大写/空格/下划线）抛 CliError", () => {
    expect(() => main(["new", "Bad Slug"])).toThrow(CliError);
    expect(() => main(["new", "UPPER"])).toThrow(CliError);
    expect(() => main(["new", "under_score"])).toThrow(CliError);
  });

  it("current 无指针文件时返回 trip_id null", () => {
    const result = main(["current"]) as { trip_id: string | null };
    expect(result.trip_id).toBe(null);
  });

  it("current 在 new 之后返回新建的 trip_id", () => {
    const created = main(["new", "beijing-walk"]) as { trip_id: string };
    const result = main(["current"]) as { trip_id: string | null };
    expect(result.trip_id).toBe(created.trip_id);
  });

  it("未知子命令抛 CliError", () => {
    expect(() => main(["bogus"])).toThrow(CliError);
    expect(() => main([])).toThrow(CliError);
  });
});
