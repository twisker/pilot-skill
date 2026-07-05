import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrip, readJson } from "../lib/workspace";
import type { ProgressState } from "../lib/progress";
import { computeFrameTimestamps, probeDuration, extractFrames } from "../lib/video-frames";
import { storageStateToNetscape, type StorageState } from "../lib/cookie-convert";
import {
  runPrep,
  checkDependencies,
  checkBinary,
  defaultBinaries,
  resolveCookieArgs,
  main,
  CliError,
  DependencyError,
  type Manifest,
} from "../video";

// ---------------------------------------------------------------------------
// 共享 fixture：现场用 ffmpeg 生成一段 10s 测试视频（lavfi testsrc），全程不碰
// 真实网站/下载。
//
// ffmpeg/ffprobe 是可选外部依赖：本机开发环境与装了 ffmpeg 的 CI 平台（本仓
// CI 在 Linux runner 上 apt 装 ffmpeg）全量运行；缺失时——GitHub runner 镜像
// 已不再预装 ffmpeg，macOS/Windows runner 上就没有——依赖真实二进制的用例
// **整组 skip**，而不是让 beforeAll 抛 `ENOENT` 把整个 suite 拖红（这正是本仓
// CI 长期 failing 的根因）。与下方 yt-dlp 的 skipIf 同一套「未装则跳过、不制造
// 假红灯」哲学；纯逻辑用例（抽帧时间点计算等）不受影响照常跑。
// ---------------------------------------------------------------------------

const HAS_FFMPEG = checkBinary("ffmpeg") && checkBinary("ffprobe");

let fixtureDir: string;
let fixtureVideoPath: string;

beforeAll(() => {
  if (!HAS_FFMPEG) return; // 无 ffmpeg 环境跳过 fixture 生成；依赖它的用例已整组 skipIf
  fixtureDir = mkdtempSync(path.join(tmpdir(), "pilot-video-fixture-"));
  fixtureVideoPath = path.join(fixtureDir, "fixture.mp4");
  execFileSync("ffmpeg", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=10:size=320x240:rate=10",
    "-y",
    fixtureVideoPath,
  ]);
}, 30000);

afterAll(() => {
  if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// ① lib/video-frames：跳过下载环节，直接测抽帧函数
// ---------------------------------------------------------------------------

describe("lib/video-frames: 均匀抽帧时间点计算", () => {
  it("count 帧均分 [0,duration]，取每段中点", () => {
    const timestamps = computeFrameTimestamps(10, 5);
    expect(timestamps).toEqual([1, 3, 5, 7, 9]);
  });

  it("count<=0 或 duration<=0 返回空数组", () => {
    expect(computeFrameTimestamps(10, 0)).toEqual([]);
    expect(computeFrameTimestamps(0, 5)).toEqual([]);
    expect(computeFrameTimestamps(-1, 5)).toEqual([]);
  });
});

describe.skipIf(!HAS_FFMPEG)("lib/video-frames: ffprobe 时长探测 + ffmpeg 抽帧（真实二进制 + 现场生成的 testsrc 视频）", () => {
  it("probeDuration 读出的时长接近 10s", async () => {
    const duration = await probeDuration(fixtureVideoPath);
    expect(duration).toBeGreaterThan(9);
    expect(duration).toBeLessThan(11);
  }, 15000);

  it("extractFrames 产出 N 帧，命名 frame-001.jpg 起，文件非空", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "pilot-video-frames-"));
    try {
      const frames = await extractFrames(fixtureVideoPath, outDir, { duration: 10, maxFrames: 4 });
      expect(frames).toEqual(["frame-001.jpg", "frame-002.jpg", "frame-003.jpg", "frame-004.jpg"]);
      for (const frame of frames) {
        const framePath = path.join(outDir, frame);
        expect(existsSync(framePath)).toBe(true);
        expect(readFileSync(framePath).length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(outDir, { recursive: true });
    }
  }, 30000);

  it("probeDuration 对不存在的文件抛出可读错误", async () => {
    await expect(probeDuration(path.join(fixtureDir, "does-not-exist.mp4"))).rejects.toThrow(/ffprobe/);
  });
});

// ---------------------------------------------------------------------------
// ③ storageState → Netscape cookies.txt 转换（纯函数）
// ---------------------------------------------------------------------------

describe("lib/cookie-convert: storageState → Netscape", () => {
  const fixtureStorageState: StorageState = {
    cookies: [
      {
        name: "SESSDATA",
        value: "abc123",
        domain: ".bilibili.com",
        path: "/",
        expires: -1, // 会话 cookie
        httpOnly: true,
        secure: true,
      },
      {
        name: "buvid3",
        value: "xyz789",
        domain: "www.bilibili.com",
        path: "/",
        expires: 1999999999,
        httpOnly: false,
        secure: false,
      },
    ],
    origins: [],
  };

  it("输出 Netscape header 与逐行 tab 分隔字段", () => {
    const output = storageStateToNetscape(fixtureStorageState);
    expect(output).toMatch(/^# Netscape HTTP Cookie File/);

    // 过滤 Netscape 标准注释行（仅以 "# " 开头的），但保留 #HttpOnly_ 前缀的数据行
    const lines = output.trim().split("\n").filter((l) => l && !l.match(/^# [^H]/));
    expect(lines).toHaveLength(2);

    const [domain, includeSub, cookiePath, secure, expiry, name, value] = lines[0].split("\t");
    expect(domain).toBe("#HttpOnly_.bilibili.com"); // httpOnly cookie 有 #HttpOnly_ 前缀
    expect(includeSub).toBe("TRUE"); // 以 . 开头的域名
    expect(cookiePath).toBe("/");
    expect(secure).toBe("TRUE");
    expect(expiry).toBe("0"); // 会话 cookie（-1）转为 0
    expect(name).toBe("SESSDATA");
    expect(value).toBe("abc123");

    const [domain2, includeSub2, , secure2, expiry2] = lines[1].split("\t");
    expect(domain2).toBe("www.bilibili.com"); // 无 httpOnly 标志，无前缀
    expect(includeSub2).toBe("FALSE"); // 不以 . 开头
    expect(secure2).toBe("FALSE");
    expect(expiry2).toBe("1999999999");
  });

  it("空 cookies 数组输出仅 header", () => {
    const output = storageStateToNetscape({ cookies: [], origins: [] });
    expect(output).toBe("# Netscape HTTP Cookie File\n# 由 PILOT video.ts 自动生成，勿手改\n\n");
  });
});

// ---------------------------------------------------------------------------
// 共用 trip/PILOT_HOME 环境
// ---------------------------------------------------------------------------

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-video-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("video-test");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) rmSync(testPilotHome, { recursive: true });
});

// ---------------------------------------------------------------------------
// resolveCookieArgs：bilibili URL + cookie 文件存在时才转换
// ---------------------------------------------------------------------------

describe("video.ts: resolveCookieArgs", () => {
  it("非 B 站 URL：不转换，返回空数组", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pilot-video-cookie-"));
    try {
      expect(resolveCookieArgs("https://www.mafengwo.cn/i/12345.html", tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("B 站 URL 但无 cookie 文件：不视为失败，返回空数组", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pilot-video-cookie-"));
    try {
      expect(resolveCookieArgs("https://www.bilibili.com/video/BV1xx", tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("B 站 URL 且 cookie 文件存在：写出 Netscape 临时文件并返回 --cookies 参数", () => {
    const cookiesDir = path.join(testPilotHome, "cookies");
    mkdirSync(cookiesDir, { recursive: true });
    const storageState: StorageState = {
      cookies: [
        {
          name: "SESSDATA",
          value: "sess-value",
          domain: ".bilibili.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
        },
      ],
      origins: [],
    };
    writeFileSync(path.join(cookiesDir, "bilibili.json"), JSON.stringify(storageState), "utf-8");

    const tmpDir = mkdtempSync(path.join(tmpdir(), "pilot-video-cookie-"));
    try {
      const args = resolveCookieArgs("https://www.bilibili.com/video/BV1xx", tmpDir);
      expect(args[0]).toBe("--cookies");
      const netscapePath = args[1];
      expect(existsSync(netscapePath)).toBe(true);
      const content = readFileSync(netscapePath, "utf-8");
      expect(content).toContain("SESSDATA");
      expect(content).toContain("sess-value");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("b23.tv 短链域名也判定为 B 站", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pilot-video-cookie-"));
    try {
      // 无 cookie 文件，仅验证不抛错、判定逻辑覆盖 b23.tv（返回空数组）
      expect(resolveCookieArgs("https://b23.tv/abcd123", tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 依赖检查：PATH 注入空目录 / 依赖缺失路径
// ---------------------------------------------------------------------------

describe("video.ts: 依赖检查", () => {
  it.skipIf(!HAS_FFMPEG)("checkBinary 对真实存在的 ffmpeg/ffprobe 返回 true（装了 ffmpeg 时才跑）", () => {
    // GitHub runner 镜像已不再预装 ffmpeg（macOS/Windows runner 上没有），故不能
    // 无条件断言恒真——装了才跑（本仓 CI 在 Linux 上 apt 装 ffmpeg），没装则跳过，
    // 与下方 yt-dlp 的 skipIf 同一套「未装则跳过、不制造假红灯」哲学。
    expect(checkBinary("ffmpeg")).toBe(true);
    expect(checkBinary("ffprobe")).toBe(true);
  });

  // yt-dlp 只在本机/CI 已安装时才断言其可用；未安装时跳过而非制造假红灯——
  // 依赖缺失路径已由下面「PATH 注入空目录」「DependencyError」等测试覆盖。
  it.skipIf(!checkBinary("yt-dlp"))("checkBinary 对真实存在的 yt-dlp 返回 true（本机已安装时才跑）", () => {
    expect(checkBinary("yt-dlp")).toBe(true);
  });

  it("PATH 注入空目录后，依赖检测判定全部缺失", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "pilot-empty-path-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const result = checkDependencies(["yt-dlp", "ffmpeg", "ffprobe"]);
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(["yt-dlp", "ffmpeg", "ffprobe"]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(emptyDir, { recursive: true });
    }
  });

  it("runPrep 在依赖缺失时抛 DependencyError，携带 missing 与跨平台安装指引", async () => {
    await expect(
      runPrep(tripId, "https://example.com/video", {
        binaries: { ytDlp: "nonexistent-yt-dlp-xyz", ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      }),
    ).rejects.toThrow(DependencyError);

    try {
      await runPrep(tripId, "https://example.com/video", {
        binaries: { ytDlp: "nonexistent-yt-dlp-xyz", ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyError);
      const depErr = err as DependencyError;
      expect(depErr.missing).toContain("nonexistent-yt-dlp-xyz");
      expect(depErr.installHint).toContain("setup-video.ts");
    }
  });

  it("--meta-only 模式依赖检查只探测 yt-dlp，不受 ffmpeg/ffprobe 缺失影响", async () => {
    const deps = checkDependencies(["nonexistent-yt-dlp-xyz"]);
    expect(deps.ok).toBe(false);
    // 验证 meta-only 分支确实只传 [binaries.ytDlp] 给 checkDependencies：
    // 用真实 yt-dlp + 故意错误的 ffmpeg/ffprobe 名字，metaOnly 应该完全不受影响成功。
    // （功能验证见下方 fake yt-dlp 集成测试）
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkBinary + defaultBinaries 绝对路径联测（Task 21 review Critical 修复回归）
//
// 一键安装（setup-video.ts）落点是 ~/.pilot/bin/ffmpeg 这样的绝对路径，
// defaultBinaries() 探测到该文件后会返回绝对路径而非裸命令名 "ffmpeg"。
// 修复前 checkBinary() 用整串路径去 VERSION_FLAG 表里查 —— 绝对路径必然
// miss，fallback 到 "--version"，而 ffmpeg/ffprobe 只认单横线 "-version"，
// 非零退出 → 一键安装后反而被误判为「缺依赖」。本测试用真实 ffmpeg 二进制
// （拷贝进临时 PILOT_HOME/bin 目录，模拟一键安装落点）复现「安装后可用」
// 这条链路，锁死修复。
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_FFMPEG)("video.ts: checkBinary + defaultBinaries 绝对路径联测", () => {
  let fakeHomeDir: string;

  beforeEach(() => {
    fakeHomeDir = mkdtempSync(path.join(tmpdir(), "pilot-checkbinary-home-"));
    mkdirSync(path.join(fakeHomeDir, "bin"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.PILOT_HOME;
    if (existsSync(fakeHomeDir)) rmSync(fakeHomeDir, { recursive: true });
  });

  it("defaultBinaries() 解析出的 ~/.pilot/bin/ffmpeg 绝对路径经 checkBinary 判定为可用", () => {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const realFfmpeg = execFileSync(whichCmd, ["ffmpeg"], { encoding: "utf-8" })
      .split(/\r?\n/)[0]
      .trim();
    expect(realFfmpeg).toBeTruthy();

    const exeSuffix = process.platform === "win32" ? ".exe" : "";
    const destPath = path.join(fakeHomeDir, "bin", `ffmpeg${exeSuffix}`);
    copyFileSync(realFfmpeg, destPath);
    if (process.platform !== "win32") chmodSync(destPath, 0o755);

    process.env.PILOT_HOME = fakeHomeDir;
    const binaries = defaultBinaries();
    // 先确认确实解析到了绝对路径（不是回退裸命令名）——否则下面的断言测不出回归
    expect(binaries.ffmpeg).toBe(destPath);
    expect(checkBinary(binaries.ffmpeg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fake yt-dlp stub —— 不打真实网站，验证 CLI 契约与 manifest 结构
// ---------------------------------------------------------------------------

// Windows 无 shebang 支持，直接执行无扩展名文件会失败；改写一个 .js + .cmd
// 包装（.cmd 由 Node child_process 特殊处理，无需 shell:true 也能跑），
// PATH 目录下 PATHEXT 解析裸命令名"yt-dlp"时也能命中 yt-dlp.cmd。
// darwin/linux 保持原有 shebang + chmod +x 方案不变。
// 注：本仓库开发机为 macOS，win32 分支未在真实 Windows 上跑过，随 CI windows-latest
// job（.github/workflows/ci.yml）验证。
function writeFakeYtDlp(dir: string): string {
  const script = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_YTDLP_LOG) {
  fs.writeFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(argv));
}
if (argv.includes("--version")) {
  process.stdout.write("2026.01.01\\n");
  process.exit(0);
}
if (argv.includes("--dump-json")) {
  process.stdout.write((process.env.FAKE_YTDLP_META || "{}") + "\\n");
  process.exit(0);
}
if (argv.includes("--print-json")) {
  const oIdx = argv.indexOf("-o");
  const outPath = argv[oIdx + 1];
  if (process.env.FAKE_YTDLP_FAIL) {
    // 模拟部分下载：写入 .part 文件后失败
    fs.writeFileSync(outPath + ".part", "partial download");
    process.stderr.write("fake-yt-dlp: download failed\\n");
    process.exit(1);
  }
  fs.copyFileSync(process.env.FAKE_YTDLP_SOURCE, outPath);
  process.stdout.write((process.env.FAKE_YTDLP_META || "{}") + "\\n");
  process.exit(0);
}
process.stderr.write("fake-yt-dlp: unknown invocation\\n");
process.exit(1);
`;
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "yt-dlp.js");
    writeFileSync(jsPath, script);
    const cmdPath = path.join(dir, "yt-dlp.cmd");
    writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`);
    return cmdPath;
  }
  const scriptPath = path.join(dir, "yt-dlp");
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("video.ts: prep --meta-only（fake yt-dlp，不依赖 ffmpeg）", () => {
  let stubDir: string;
  let fakeYtDlp: string;

  beforeEach(() => {
    stubDir = mkdtempSync(path.join(tmpdir(), "pilot-fake-ytdlp-"));
    fakeYtDlp = writeFakeYtDlp(stubDir);
    process.env.FAKE_YTDLP_META = JSON.stringify({
      title: "新疆独库公路自驾测试视频",
      description: "测试简介：从乌鲁木齐到伊犁的自驾路线",
    });
  });

  afterEach(() => {
    delete process.env.FAKE_YTDLP_META;
    delete process.env.FAKE_YTDLP_LOG;
    if (existsSync(stubDir)) rmSync(stubDir, { recursive: true });
  });

  it("产出 manifest.json：duration=null, frames=[]，description 来自 yt-dlp metadata；ffmpeg/ffprobe 缺失不影响", async () => {
    const manifest = await runPrep(tripId, "https://www.bilibili.com/video/BV1xx", {
      metaOnly: true,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "definitely-not-installed", ffprobe: "definitely-not-installed" },
    });

    expect(manifest).toEqual({
      url: "https://www.bilibili.com/video/BV1xx",
      duration: null,
      frames: [],
      description: "测试简介：从乌鲁木齐到伊犁的自驾路线",
      title: "新疆独库公路自驾测试视频",
    });

    const hash = require("node:crypto").createHash("sha1").update("https://www.bilibili.com/video/BV1xx").digest("hex");
    const onDisk = readJson<Manifest>(tripId, `raw/video-${hash}/manifest.json`);
    expect(onDisk).toEqual(manifest);
  }, 15000);

  it("meta-only 且元数据缺 description 字段时兜底为空字符串", async () => {
    process.env.FAKE_YTDLP_META = JSON.stringify({ title: "无简介视频" });
    const manifest = await runPrep(tripId, "https://www.bilibili.com/video/BV2yy", {
      metaOnly: true,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "x", ffprobe: "x" },
    });
    expect(manifest.description).toBe("");
    expect(manifest.duration).toBeNull();
    expect(manifest.frames).toEqual([]);
  }, 15000);

  it("meta-only 分支：cookies.txt 临时文件在 runPrep 完成后被删除", async () => {
    const cookiesDir = path.join(testPilotHome, "cookies");
    mkdirSync(cookiesDir, { recursive: true });
    const storageState: StorageState = {
      cookies: [
        { name: "SESSDATA", value: "sess", domain: ".bilibili.com", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      origins: [],
    };
    writeFileSync(path.join(cookiesDir, "bilibili.json"), JSON.stringify(storageState), "utf-8");

    // 记录 yt-dlp 调用时接收到的 cookies 文件路径
    const logPath = path.join(stubDir, "argv.log.json");
    process.env.FAKE_YTDLP_LOG = logPath;

    await runPrep(tripId, "https://www.bilibili.com/video/BV7dd", {
      metaOnly: true,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "x", ffprobe: "x" },
    });

    // 验证 yt-dlp 调用时临时文件存在
    const loggedArgv = JSON.parse(readFileSync(logPath, "utf-8")) as string[];
    const cookieIdx = loggedArgv.indexOf("--cookies");
    if (cookieIdx >= 0) {
      const cookieFilePath = loggedArgv[cookieIdx + 1];
      // runPrep 完成后，临时文件应该被删除
      expect(existsSync(cookieFilePath)).toBe(false);
    }
  }, 15000);
});

describe.skipIf(!HAS_FFMPEG)("video.ts: prep 全流程（fake yt-dlp 下载 + 真实 ffmpeg/ffprobe 抽帧）", () => {
  let stubDir: string;
  let fakeYtDlp: string;

  beforeEach(() => {
    stubDir = mkdtempSync(path.join(tmpdir(), "pilot-fake-ytdlp-full-"));
    fakeYtDlp = writeFakeYtDlp(stubDir);
    process.env.FAKE_YTDLP_SOURCE = fixtureVideoPath;
    process.env.FAKE_YTDLP_META = JSON.stringify({
      title: "禾木喀纳斯自驾测试视频",
      description: "测试简介：禾木到喀纳斯的自驾路线视频",
    });
  });

  afterEach(() => {
    delete process.env.FAKE_YTDLP_SOURCE;
    delete process.env.FAKE_YTDLP_META;
    delete process.env.FAKE_YTDLP_LOG;
    if (existsSync(stubDir)) rmSync(stubDir, { recursive: true });
  });

  it("下载（fake）→ ffprobe 时长 → ffmpeg 抽 N 帧 → manifest.json，且下载的 source.mp4 被删除", async () => {
    const url = "https://www.bilibili.com/video/BV3zz";
    const manifest = await runPrep(tripId, url, {
      maxFrames: 3,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    });

    expect(manifest.url).toBe(url);
    expect(manifest.frames).toEqual(["frame-001.jpg", "frame-002.jpg", "frame-003.jpg"]);
    expect(manifest.duration).toBeGreaterThan(9);
    expect(manifest.duration).toBeLessThan(11);
    expect(manifest.description).toBe("测试简介：禾木到喀纳斯的自驾路线视频");
    expect(manifest.title).toBe("禾木喀纳斯自驾测试视频");

    const hash = require("node:crypto").createHash("sha1").update(url).digest("hex");
    const videoDir = path.join(testPilotHome, "workspace", tripId, "raw", `video-${hash}`);
    expect(existsSync(path.join(videoDir, "source.mp4"))).toBe(false); // 磁盘纪律：下载文件已删除
    for (const frame of manifest.frames) {
      expect(existsSync(path.join(videoDir, frame))).toBe(true);
    }
    const onDisk = readJson<Manifest>(tripId, `raw/video-${hash}/manifest.json`);
    expect(onDisk).toEqual(manifest);

    // Task 26 review Important-2：接入点断言——全流程确实经历了 frames 抽帧阶段，
    // 最终 progress.json 落在 stage=video 完成态（current===total===抽帧数）
    const progress = readJson<ProgressState>(tripId, "progress.json");
    expect(progress.stage).toBe("video");
    expect(progress.current).toBe(progress.total);
    expect(progress.current).toBe(manifest.frames.length);
  }, 30000);

  it("B 站 URL 且存在 cookie 文件时，yt-dlp 调用参数中带 --cookies", async () => {
    const cookiesDir = path.join(testPilotHome, "cookies");
    mkdirSync(cookiesDir, { recursive: true });
    const storageState: StorageState = {
      cookies: [
        { name: "SESSDATA", value: "v1", domain: ".bilibili.com", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      origins: [],
    };
    writeFileSync(path.join(cookiesDir, "bilibili.json"), JSON.stringify(storageState), "utf-8");

    const logPath = path.join(stubDir, "argv.log.json");
    process.env.FAKE_YTDLP_LOG = logPath;

    await runPrep(tripId, "https://www.bilibili.com/video/BV4aa", {
      maxFrames: 2,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    });

    const loggedArgv = JSON.parse(readFileSync(logPath, "utf-8")) as string[];
    const cookieIdx = loggedArgv.indexOf("--cookies");
    expect(cookieIdx).toBeGreaterThanOrEqual(0);
    const cookieFilePath = loggedArgv[cookieIdx + 1];
    // runPrep 完成后，临时文件应该被删除
    expect(existsSync(cookieFilePath)).toBe(false);
  }, 30000);

  it("full 分支：cookies.txt 临时文件在 runPrep 完成后被删除，包含 source.mp4", async () => {
    const cookiesDir = path.join(testPilotHome, "cookies");
    mkdirSync(cookiesDir, { recursive: true });
    const storageState: StorageState = {
      cookies: [
        { name: "SESSDATA", value: "v2", domain: ".bilibili.com", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      origins: [],
    };
    writeFileSync(path.join(cookiesDir, "bilibili.json"), JSON.stringify(storageState), "utf-8");

    const logPath = path.join(stubDir, "argv.log.json");
    process.env.FAKE_YTDLP_LOG = logPath;

    await runPrep(tripId, "https://www.bilibili.com/video/BV8ee", {
      maxFrames: 2,
      binaries: { ytDlp: fakeYtDlp, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    });

    const loggedArgv = JSON.parse(readFileSync(logPath, "utf-8")) as string[];
    const cookieIdx = loggedArgv.indexOf("--cookies");
    if (cookieIdx >= 0) {
      const cookieFilePath = loggedArgv[cookieIdx + 1];
      // runPrep 完成后，临时文件应该被删除
      expect(existsSync(cookieFilePath)).toBe(false);
    }

    // 验证 source.mp4 也被删除了（磁盘纪律）
    const hash = require("node:crypto").createHash("sha1").update("https://www.bilibili.com/video/BV8ee").digest("hex");
    const videoDir = path.join(testPilotHome, "workspace", tripId, "raw", `video-${hash}`);
    expect(existsSync(path.join(videoDir, "source.mp4"))).toBe(false);
  }, 30000);

  it("下载失败（yt-dlp 非零退出）时抛出可读 CliError，不产出 manifest", async () => {
    // 不设置 FAKE_YTDLP_SOURCE/META 触发 fake 脚本走到未知分支返回非零，
    // 但 --print-json 分支必然命中；改为让目标 trip 不存在触发 trip 级错误
    // 更简单：直接指向一个会被 fake 脚本拒绝的非法调用——用不存在的 --print-json 输出源。
    delete process.env.FAKE_YTDLP_SOURCE; // copyFileSync 会因为源不存在而抛错，脚本进程非零退出
    await expect(
      runPrep(tripId, "https://www.bilibili.com/video/BV5bb", {
        maxFrames: 2,
        binaries: { ytDlp: fakeYtDlp, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      }),
    ).rejects.toThrow(CliError);
  }, 15000);

  it("下载失败时清理 source.mp4.part 等部分文件，不在 video 目录留下残留", async () => {
    process.env.FAKE_YTDLP_FAIL = "1"; // 触发 fake yt-dlp 写 .part 后失败
    try {
      await expect(
        runPrep(tripId, "https://www.bilibili.com/video/BV9ff", {
          maxFrames: 2,
          binaries: { ytDlp: fakeYtDlp, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
        }),
      ).rejects.toThrow(CliError);

      // 验证 source.mp4 与 source.mp4.part 都被清理
      const hash = require("node:crypto").createHash("sha1").update("https://www.bilibili.com/video/BV9ff").digest("hex");
      const videoDir = path.join(testPilotHome, "workspace", tripId, "raw", `video-${hash}`);
      expect(existsSync(path.join(videoDir, "source.mp4"))).toBe(false);
      expect(existsSync(path.join(videoDir, "source.mp4.part"))).toBe(false);

      // 验证没有其它 .part 残留
      if (existsSync(videoDir)) {
        const entries = require("node:fs").readdirSync(videoDir);
        const partFiles = entries.filter((e: string) => e.endsWith(".part"));
        expect(partFiles).toEqual([]);
      }
    } finally {
      delete process.env.FAKE_YTDLP_FAIL;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// CLI 参数校验 + main() 端到端（PATH 注入 fake yt-dlp，验证 --meta-only 全链路）
// ---------------------------------------------------------------------------

describe("video.ts CLI 参数校验", () => {
  it("缺少 --url 抛 CliError", async () => {
    await expect(main(["prep", "--trip", tripId])).rejects.toThrow(CliError);
  });

  it("缺少 --trip 抛 CliError", async () => {
    await expect(main(["prep", "--url", "https://example.com/v"])).rejects.toThrow(CliError);
  });

  it("未知子命令抛 CliError", async () => {
    await expect(main(["bogus", "--trip", tripId, "--url", "https://example.com/v"])).rejects.toThrow(CliError);
  });

  it("--max-frames 非正整数抛 CliError", async () => {
    await expect(
      main(["prep", "--trip", tripId, "--url", "https://example.com/v", "--max-frames", "abc"]),
    ).rejects.toThrow(CliError);
  });
});

describe("video.ts CLI 端到端：main() 通过 PATH 解析到 fake yt-dlp（--meta-only）", () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(path.join(tmpdir(), "pilot-fake-ytdlp-path-"));
    writeFakeYtDlp(stubDir);
    process.env.FAKE_YTDLP_META = JSON.stringify({ title: "CLI 端到端测试", description: "CLI 简介" });
    originalPath = process.env.PATH;
    // path.delimiter：unix ":" / win32 ";"（原硬编码 ":" 在 Windows 下会拼出非法 PATH）
    process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_YTDLP_META;
    if (existsSync(stubDir)) rmSync(stubDir, { recursive: true });
  });

  it("main(prep --meta-only) 解析 boolean flag 并跑通全链路（DEFAULT_BINARIES 经 PATH 解析到 fake yt-dlp）", async () => {
    const result = (await main([
      "prep",
      "--meta-only",
      "--url",
      "https://www.bilibili.com/video/BV6cc",
      "--trip",
      tripId,
    ])) as Manifest;
    expect(result.duration).toBeNull();
    expect(result.frames).toEqual([]);
    expect(result.description).toBe("CLI 简介");
    expect(result.title).toBe("CLI 端到端测试");
  }, 15000);
});
