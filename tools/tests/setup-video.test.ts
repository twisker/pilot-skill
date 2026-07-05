import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ytDlpDownloadSpec,
  ffmpegDownloadPlan,
  findFileRecursive,
  parseArgs,
  DEPENDENCIES,
  SetupVideoError,
} from "../setup-video";

// ---------------------------------------------------------------------------
// setup-video.ts —— 纯函数/文件系统部分单测（Task 21）
//
// 下载（downloadFile）/ 解压（extractArchive 需要 unzip/tar/PowerShell 等外部
// 工具）/ --version 校验（verifyBinary 需要真实二进制）均不在此覆盖 —— 这些
// 是需要网络或需要真实平台工具链的 I/O 分支，本机（macOS 单平台）无法验证
// win32/linux 分支的实际解压行为，随 .github/workflows/ci.yml 的三平台 matrix
// 跑通验证。这里只测三平台下载计划的确定性与目录递归查找的纯逻辑。
// ---------------------------------------------------------------------------

describe("ytDlpDownloadSpec", () => {
  it("darwin → yt-dlp_macos", () => {
    expect(ytDlpDownloadSpec("darwin").url).toMatch(/yt-dlp_macos$/);
  });
  it("win32 → yt-dlp.exe", () => {
    expect(ytDlpDownloadSpec("win32").url).toMatch(/yt-dlp\.exe$/);
  });
  it("linux（及其他未知平台兜底）→ yt-dlp_linux", () => {
    expect(ytDlpDownloadSpec("linux").url).toMatch(/yt-dlp_linux$/);
    expect(ytDlpDownloadSpec("freebsd" as NodeJS.Platform).url).toMatch(/yt-dlp_linux$/);
  });
});

describe("ffmpegDownloadPlan", () => {
  it("darwin → evermeet 双 zip（ffmpeg + ffprobe 各一个）", () => {
    const plan = ffmpegDownloadPlan("darwin");
    expect(plan.kind).toBe("evermeet-dual-zip");
    expect(plan.urls).toHaveLength(2);
    expect(plan.urls[0]).toContain("evermeet.cx");
  });

  it("win32 → gyan.dev 单 zip", () => {
    const plan = ffmpegDownloadPlan("win32");
    expect(plan.kind).toBe("gyan-zip");
    expect(plan.urls).toHaveLength(1);
    expect(plan.urls[0]).toContain("gyan.dev");
  });

  it("linux → johnvansickle 单 tar.xz", () => {
    const plan = ffmpegDownloadPlan("linux");
    expect(plan.kind).toBe("johnvansickle-tar-xz");
    expect(plan.urls).toHaveLength(1);
    expect(plan.urls[0]).toContain("johnvansickle.com");
  });
});

describe("DEPENDENCIES", () => {
  it("声明 yt-dlp 与 ffmpeg（含 ffprobe）两组依赖", () => {
    expect(DEPENDENCIES.map((d) => d.name)).toEqual(["yt-dlp", "ffmpeg"]);
    expect(DEPENDENCIES.find((d) => d.name === "ffmpeg")?.files).toEqual(["ffmpeg", "ffprobe"]);
  });
});

describe("findFileRecursive", () => {
  let dir: string;

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it("在嵌套目录中找到目标文件名", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pilot-setup-video-find-"));
    mkdirSync(path.join(dir, "release-1.2.3", "bin"), { recursive: true });
    const target = path.join(dir, "release-1.2.3", "bin", "ffmpeg");
    writeFileSync(target, "fake-binary");
    expect(findFileRecursive(dir, "ffmpeg")).toBe(target);
  });

  it("找不到时返回 null", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pilot-setup-video-find-"));
    mkdirSync(path.join(dir, "empty"), { recursive: true });
    expect(findFileRecursive(dir, "ffmpeg")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("解析 install --force --yes --only yt-dlp", () => {
    expect(parseArgs(["install", "--force", "--yes", "--only", "yt-dlp"])).toEqual({
      cmd: "install",
      force: true,
      yes: true,
      only: "yt-dlp",
    });
  });

  it("无参数时全部为默认值", () => {
    expect(parseArgs(["install"])).toEqual({ cmd: "install", force: false, yes: false, only: undefined });
  });

  it("--only 传非法值抛 SetupVideoError", () => {
    expect(() => parseArgs(["install", "--only", "bogus"])).toThrow(SetupVideoError);
  });
});
