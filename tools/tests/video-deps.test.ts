import { describe, it, expect } from "vitest";
import path from "node:path";
import { getPilotHome, pilotBinDir, exeName, resolveBinaryPath, resolveDefaultBinaries } from "../lib/video-deps";

// ---------------------------------------------------------------------------
// lib/video-deps.ts —— 视频依赖跨平台探测（Task 21）
//
// 全部纯函数：env/platform/exists 均可注入，无需真实文件系统或真实二进制，
// 三平台（darwin/linux/win32）逻辑都能在任意开发机上跑单测。
// ---------------------------------------------------------------------------

describe("getPilotHome / pilotBinDir", () => {
  it("PILOT_HOME 未设置时落到 homedir()/.pilot", () => {
    const home = getPilotHome({});
    expect(home.endsWith(".pilot")).toBe(true);
  });

  it("PILOT_HOME 设置时优先使用", () => {
    expect(getPilotHome({ PILOT_HOME: "/tmp/fake-home" })).toBe("/tmp/fake-home");
    expect(pilotBinDir({ PILOT_HOME: "/tmp/fake-home" })).toBe(path.join("/tmp/fake-home", "bin"));
  });
});

describe("exeName", () => {
  it("win32 补 .exe 后缀，darwin/linux 不补", () => {
    expect(exeName("yt-dlp", "win32")).toBe("yt-dlp.exe");
    expect(exeName("yt-dlp", "darwin")).toBe("yt-dlp");
    expect(exeName("yt-dlp", "linux")).toBe("yt-dlp");
  });
});

describe("resolveBinaryPath", () => {
  it("~/.pilot/bin 下存在对应文件时返回绝对路径", () => {
    const env = { PILOT_HOME: "/tmp/fake-home" };
    const bundled = path.join("/tmp/fake-home", "bin", "ffmpeg");
    const resolved = resolveBinaryPath("ffmpeg", {
      env,
      platform: "darwin",
      exists: (p) => p === bundled,
    });
    expect(resolved).toBe(bundled);
  });

  it("~/.pilot/bin 下不存在时回退裸命令名（交给 PATH 解析）", () => {
    const resolved = resolveBinaryPath("ffmpeg", {
      env: { PILOT_HOME: "/tmp/fake-home" },
      platform: "darwin",
      exists: () => false,
    });
    expect(resolved).toBe("ffmpeg");
  });

  it("win32 下拼接 .exe 后缀再判断是否存在", () => {
    const env = { PILOT_HOME: "C:\\Users\\fake\\.pilot" };
    const bundled = path.join("C:\\Users\\fake\\.pilot", "bin", "yt-dlp.exe");
    const seen: string[] = [];
    const resolved = resolveBinaryPath("yt-dlp", {
      env,
      platform: "win32",
      exists: (p) => {
        seen.push(p);
        return p === bundled;
      },
    });
    expect(resolved).toBe(bundled);
    expect(seen[0]).toBe(bundled);
  });
});

describe("resolveDefaultBinaries", () => {
  it("三个二进制均回退裸命令名（无 bundle 时）", () => {
    const result = resolveDefaultBinaries({
      env: { PILOT_HOME: "/tmp/fake-home-empty" },
      platform: "linux",
      exists: () => false,
    });
    expect(result).toEqual({ ytDlp: "yt-dlp", ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  });

  it("三个二进制均在 bundle 目录命中时返回三个绝对路径", () => {
    const binDir = path.join("/tmp/fake-home-full", "bin");
    const result = resolveDefaultBinaries({
      env: { PILOT_HOME: "/tmp/fake-home-full" },
      platform: "linux",
      exists: () => true,
    });
    expect(result).toEqual({
      ytDlp: path.join(binDir, "yt-dlp"),
      ffmpeg: path.join(binDir, "ffmpeg"),
      ffprobe: path.join(binDir, "ffprobe"),
    });
  });
});
