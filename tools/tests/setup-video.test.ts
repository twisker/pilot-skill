import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ytDlpDownloadSpec,
  ffmpegDownloadPlan,
  findFileRecursive,
  parseArgs,
  parseSha256Sums,
  sha256File,
  ytDlpChecksumsUrl,
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

describe("ytDlpChecksumsUrl", () => {
  it("指向 yt-dlp latest release 同目录的 SHA2-256SUMS", () => {
    expect(ytDlpChecksumsUrl()).toBe("https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS");
  });
});

describe("parseSha256Sums（Task 21 review Minor 修复：yt-dlp 校验和）", () => {
  it("解析标准 sha256sum 清单为 文件名 → 小写哈希 映射", () => {
    const content = [
      "495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd  yt-dlp",
      "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b  yt-dlp_macos",
      "6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae  yt-dlp_linux",
    ].join("\n");
    const sums = parseSha256Sums(content);
    expect(sums.get("yt-dlp_macos")).toBe("498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b");
    expect(sums.get("yt-dlp_linux")).toBe("6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae");
    expect(sums.size).toBe(3);
  });

  it("兼容 binary mode 的 '*' 前缀", () => {
    const content = "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b *yt-dlp_macos";
    expect(parseSha256Sums(content).get("yt-dlp_macos")).toBe(
      "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
    );
  });

  it("大写十六进制哈希归一化为小写", () => {
    const content = "498BD0DAE17855C599D371D68EC5BAFC439A9D8640E838BE25C765A9792F261B  yt-dlp_macos";
    expect(parseSha256Sums(content).get("yt-dlp_macos")).toBe(
      "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
    );
  });

  it("空行/格式不符的行被忽略，不抛错", () => {
    const content = "\n\nnot-a-valid-line\n498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b  yt-dlp_macos\n";
    const sums = parseSha256Sums(content);
    expect(sums.size).toBe(1);
    expect(sums.has("yt-dlp_macos")).toBe(true);
  });

  it("空字符串返回空映射", () => {
    expect(parseSha256Sums("").size).toBe(0);
  });
});

describe("sha256File", () => {
  let dir: string;

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it("计算出的哈希与 node:crypto 直接计算一致", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pilot-sha256file-"));
    const filePath = path.join(dir, "sample.bin");
    const content = "PILOT setup-video 校验和测试内容 / checksum test content\n".repeat(100);
    writeFileSync(filePath, content);

    const expected = createHash("sha256").update(content).digest("hex");
    await expect(sha256File(filePath)).resolves.toBe(expected);
  });

  it("对不存在的文件拒绝（reject）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pilot-sha256file-"));
    await expect(sha256File(path.join(dir, "does-not-exist.bin"))).rejects.toThrow();
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
