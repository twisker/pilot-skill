import { describe, it, expect } from "vitest";
import path from "node:path";
import { getPilotHome, pilotBinDir, exeName, resolveBinaryPath, resolveFromPath, resolveDefaultBinaries, planSpawn } from "../lib/video-deps";

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

// ---------------------------------------------------------------------------
// planSpawn —— Windows .cmd/.bat 执行包装
//
// 背景：Node 自 CVE-2024-27980 起禁止无 shell 直接执行 .cmd/.bat
// （execFile/execFileSync 抛 EINVAL），而 PATH 上的 yt-dlp/ffmpeg 可能是
// npm/pipx/scoop 风格的 .cmd shim。planSpawn 是纯函数，win32 分支可在
// 任意开发机上断言，无需真实 Windows。
// ---------------------------------------------------------------------------

describe("resolveFromPath", () => {
  it("win32：按 PATHEXT 在 PATH 里找到 .cmd shim（libuv 自己不做这件事）", () => {
    const target = path.join("C:\\tools", "yt-dlp.CMD");
    const found = resolveFromPath("yt-dlp", {
      platform: "win32",
      env: { PATH: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      exists: (p) => p === target,
    });
    expect(found).toBe(target);
  });

  it("win32：PATH 中靠前的目录优先", () => {
    const first = path.join("C:\\a", "yt-dlp.EXE");
    const second = path.join("C:\\b", "yt-dlp.EXE");
    const found = resolveFromPath("yt-dlp", {
      platform: "win32",
      env: { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" },
      exists: (p) => p === first || p === second,
    });
    expect(found).toBe(first);
  });

  it("win32：PATHEXT 未设置时用系统默认集（含 .CMD）", () => {
    const target = path.join("C:\\tools", "yt-dlp.CMD");
    const found = resolveFromPath("yt-dlp", {
      platform: "win32",
      env: { PATH: "C:\\tools" },
      exists: (p) => p === target,
    });
    expect(found).toBe(target);
  });

  it("win32：找不到时返回 undefined", () => {
    expect(
      resolveFromPath("yt-dlp", {
        platform: "win32",
        env: { PATH: "C:\\tools", PATHEXT: ".EXE" },
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("posix：按 ':' 切分 PATH，不追加后缀", () => {
    const target = "/usr/local/bin/ffmpeg";
    const found = resolveFromPath("ffmpeg", {
      platform: "linux",
      env: { PATH: "/usr/bin:/usr/local/bin" },
      exists: (p) => p === target,
    });
    expect(found).toBe(target);
  });
});

describe("resolveBinaryPath 的 PATH 回退", () => {
  it("win32：bundle 缺失时解析 PATH 上的 .cmd 并返回绝对路径（供 planSpawn 包装）", () => {
    const target = path.join("C:\\tools", "yt-dlp.CMD");
    const resolved = resolveBinaryPath("yt-dlp", {
      platform: "win32",
      env: { PILOT_HOME: "C:\\Users\\me\\.pilot", PATH: "C:\\tools", PATHEXT: ".CMD" },
      exists: (p) => p === target,
    });
    expect(resolved).toBe(target);
  });

  it("posix：bundle 缺失时仍回退裸命令名（既有行为不变）", () => {
    const resolved = resolveBinaryPath("ffmpeg", {
      platform: "darwin",
      env: { PILOT_HOME: "/tmp/none", PATH: "/usr/local/bin" },
      exists: () => false,
    });
    expect(resolved).toBe("ffmpeg");
  });
});

describe("planSpawn", () => {
  it("非 win32 原样透传，不引入 shell", () => {
    const plan = planSpawn("yt-dlp", ["--version"], { platform: "darwin" });
    expect(plan).toEqual({ file: "yt-dlp", args: ["--version"] });
    expect(plan.windowsVerbatimArguments).toBeUndefined();
  });

  it("win32 但目标是 .exe 时原样透传（setup-video.ts 装的就是 .exe，生产主路径）", () => {
    const bin = "C:\\Users\\me\\.pilot\\bin\\yt-dlp.exe";
    const plan = planSpawn(bin, ["--version"], { platform: "win32" });
    expect(plan).toEqual({ file: bin, args: ["--version"] });
  });

  it("win32 + .cmd 包装成 cmd.exe /d /s /c，逐参数加引号（后缀大小写不敏感）", () => {
    const bin = "C:\\tools\\yt-dlp.CMD";
    const plan = planSpawn(bin, ["--version"], {
      platform: "win32",
      comspec: "C:\\Windows\\system32\\cmd.exe",
    });
    expect(plan.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", `""${bin}" "--version""`]);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("win32 + .bat 同样包装", () => {
    const plan = planSpawn("run.bat", ["a"], { platform: "win32", comspec: "cmd.exe" });
    expect(plan.file).toBe("cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", `""run.bat" "a""`]);
  });

  it("含 & 的 URL 被引号包裹，cmd 不会把 & 当作命令分隔符", () => {
    const url = "https://example.com/v?p=1&t=2";
    const plan = planSpawn("yt-dlp.cmd", ["-o", "out.mp4", url], {
      platform: "win32",
      comspec: "cmd.exe",
    });
    expect(plan.args[3]).toBe(`""yt-dlp.cmd" "-o" "out.mp4" "${url}""`);
  });

  it("参数含双引号或换行时抛错（无法安全表达，不静默构造错误命令）", () => {
    expect(() => planSpawn("yt-dlp.cmd", ['a"b'], { platform: "win32" })).toThrow(/cmd\.exe/);
    expect(() => planSpawn("yt-dlp.cmd", ["a\nb"], { platform: "win32" })).toThrow(/cmd\.exe/);
  });
});
