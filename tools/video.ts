import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdir, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { tripDir, writeJson } from "./lib/workspace";
import { cookieFilePath } from "./lib/sites/cookies";
import { probeDuration, extractFrames } from "./lib/video-frames";
import { storageStateToNetscape, type StorageState } from "./lib/cookie-convert";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PILOT video.ts —— 视频预处理（yt-dlp 下载 + ffmpeg 均匀抽帧 + manifest）
//
//   prep --url <u> --trip <id> [--max-frames N]
//     yt-dlp 下载 720p 上限视频 → ffprobe 拿时长 → ffmpeg 均匀抽 N 帧
//     → raw/video-<sha1(url)>/{frame-001.jpg,...,manifest.json}
//     → 抽帧完成后删除 source.mp4（磁盘纪律，帧留着）
//
//   prep --meta-only --url <u> --trip <id>
//     降级路径：不下载不抽帧，只 yt-dlp --dump-json 拿标题/简介写 manifest
//     （duration=null, frames=[]），不依赖 ffmpeg/ffprobe
//
// 字幕提取与置顶评论抓取（需 B 站 wbi 签名 API）已移入 V1.5，本工具不做。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

export class DependencyError extends CliError {
  missing: string[];
  installHint: string;
  constructor(missing: string[]) {
    super(`缺少依赖: ${missing.join(", ")}`);
    this.missing = missing;
    this.installHint = installHintFor(missing);
  }
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const YT_DLP_MAX_BUFFER = 20 * 1024 * 1024;

const BREW_PACKAGE: Record<string, string> = {
  "yt-dlp": "yt-dlp",
  ffmpeg: "ffmpeg",
  ffprobe: "ffmpeg", // ffprobe 随 ffmpeg 包一起装，没有独立 brew 包
};

function installHintFor(missing: string[]): string {
  const packages = Array.from(new Set(missing.map((m) => BREW_PACKAGE[m] ?? m)));
  return `brew install ${packages.join(" ")}`;
}

export interface Binaries {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
}

export const DEFAULT_BINARIES: Binaries = { ytDlp: "yt-dlp", ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

// ffmpeg/ffprobe 的版本探测参数是单横线 -version（不是 --version）
const VERSION_FLAG: Record<string, string> = { ffmpeg: "-version", ffprobe: "-version" };

export function checkBinary(bin: string): boolean {
  const flag = VERSION_FLAG[bin] ?? "--version";
  try {
    execFileSync(bin, [flag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function checkDependencies(bins: string[]): { ok: boolean; missing: string[] } {
  const missing = bins.filter((bin) => !checkBinary(bin));
  return { ok: missing.length === 0, missing };
}

export interface Manifest {
  url: string;
  duration: number | null;
  frames: string[];
  description: string;
  title?: string;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function isBilibiliUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("bilibili.com") || host.includes("b23.tv");
  } catch {
    return false;
  }
}

/**
 * B 站需要登录态时，把 ~/.pilot/cookies/bilibili.json（playwright storageState）
 * 转换为 yt-dlp 认得的 Netscape cookies.txt，写到 tmpDir 下的临时文件，返回
 * 追加给 yt-dlp 的 ["--cookies", <path>] 参数；无 cookie 文件或非 B 站 URL
 * 则返回空数组（不视为失败，直接无 cookie 尝试）。
 */
export function resolveCookieArgs(url: string, tmpDir: string): string[] {
  if (!isBilibiliUrl(url)) return [];
  const cookiePath = cookieFilePath("bilibili.json");
  if (!existsSync(cookiePath)) return [];
  const storageState = JSON.parse(readFileSync(cookiePath, "utf-8")) as StorageState;
  const netscape = storageStateToNetscape(storageState);
  const netscapePath = path.join(tmpDir, "cookies.txt");
  writeFileSync(netscapePath, netscape, "utf-8");
  return ["--cookies", netscapePath];
}

interface YtDlpMeta {
  duration?: number;
  description?: string;
  title?: string;
}

function parseYtDlpJsonOutput(stdout: string, context: string): YtDlpMeta {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new CliError(`${context}: yt-dlp 未返回元数据 JSON`);
  try {
    return JSON.parse(lastLine) as YtDlpMeta;
  } catch {
    throw new CliError(`${context}: yt-dlp 元数据 JSON 解析失败`);
  }
}

async function ytDlpDownload(
  ytDlpBin: string,
  url: string,
  outputPath: string,
  cookieArgs: string[],
): Promise<YtDlpMeta> {
  const args = [
    "-f",
    "bv*[height<=720]+ba/b[height<=720]",
    "--no-playlist",
    "--print-json",
    "--quiet",
    "--no-warnings",
    ...cookieArgs,
    "-o",
    outputPath,
    url,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ytDlpBin, args, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: YT_DLP_MAX_BUFFER,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`yt-dlp 下载失败或超时（5 分钟上限）: ${message}`);
  }
  return parseYtDlpJsonOutput(stdout, "下载");
}

async function ytDlpMetaOnly(ytDlpBin: string, url: string, cookieArgs: string[]): Promise<YtDlpMeta> {
  const args = ["--dump-json", "--no-playlist", "--skip-download", "--quiet", "--no-warnings", ...cookieArgs, url];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ytDlpBin, args, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: YT_DLP_MAX_BUFFER,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`yt-dlp 元信息抓取失败: ${message}`);
  }
  return parseYtDlpJsonOutput(stdout, "meta-only");
}

function getConfigMaxFrames(): number {
  const configPath = process.env.PILOT_CONFIG || path.resolve(__dirname, "../config/pilot.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as { maxFrames?: number };
    return typeof config.maxFrames === "number" && config.maxFrames > 0 ? config.maxFrames : 20;
  } catch {
    return 20;
  }
}

export interface PrepOptions {
  maxFrames?: number;
  metaOnly?: boolean;
  binaries?: Binaries;
}

export async function runPrep(tripId: string, url: string, opts: PrepOptions = {}): Promise<Manifest> {
  const dir = tripDir(tripId); // trip 不存在会抛出，属于 trip 级错误
  const binaries = opts.binaries ?? DEFAULT_BINARIES;
  const hash = sha1(url);
  const videoRelDir = `raw/video-${hash}`;
  const videoDir = path.join(dir, videoRelDir);
  mkdirSync(videoDir, { recursive: true });

  // 创建临时目录用于 cookies.txt，用完即删
  const tmpCookiesDir = mkdtempSync(path.join(tmpdir(), "pilot-cookies-"));

  if (opts.metaOnly) {
    const deps = checkDependencies([binaries.ytDlp]);
    if (!deps.ok) throw new DependencyError(deps.missing);

    try {
      const cookieArgs = resolveCookieArgs(url, tmpCookiesDir);
      const meta = await ytDlpMetaOnly(binaries.ytDlp, url, cookieArgs);
      const manifest: Manifest = {
        url,
        duration: null,
        frames: [],
        description: meta.description ?? "",
        ...(meta.title ? { title: meta.title } : {}),
      };
      writeJson(tripId, `${videoRelDir}/manifest.json`, manifest);
      return manifest;
    } finally {
      // 清理 cookies 临时目录
      rmSync(tmpCookiesDir, { force: true, recursive: true });
    }
  }

  const deps = checkDependencies([binaries.ytDlp, binaries.ffmpeg, binaries.ffprobe]);
  if (!deps.ok) throw new DependencyError(deps.missing);

  const maxFrames = opts.maxFrames && opts.maxFrames > 0 ? opts.maxFrames : getConfigMaxFrames();
  const sourcePath = path.join(videoDir, "source.mp4");

  try {
    try {
      const cookieArgs = resolveCookieArgs(url, tmpCookiesDir);
      const meta = await ytDlpDownload(binaries.ytDlp, url, sourcePath, cookieArgs);

      const duration = await probeDuration(sourcePath, binaries.ffprobe);
      const frames = await extractFrames(sourcePath, videoDir, {
        duration,
        maxFrames,
        ffmpegBin: binaries.ffmpeg,
      });

      const manifest: Manifest = {
        url,
        duration,
        frames,
        description: meta.description ?? "",
        ...(meta.title ? { title: meta.title } : {}),
      };
      writeJson(tripId, `${videoRelDir}/manifest.json`, manifest);
      return manifest;
    } finally {
      // 磁盘纪律：无论抽帧或下载成功与否，下载的原视频与部分文件都不留存，帧留着
      rmSync(sourcePath, { force: true });
      // 清理同目录下的 .part 文件（yt-dlp 部分下载残留）
      const videoParentDir = path.dirname(sourcePath);
      if (existsSync(videoParentDir)) {
        try {
          const entries = readdirSync(videoParentDir);
          for (const entry of entries) {
            if (entry.endsWith(".part")) {
              const partPath = path.join(videoParentDir, entry);
              rmSync(partPath, { force: true });
            }
          }
        } catch {
          // 忽略清理失败（目录不存在等）
        }
      }
    }
  } finally {
    // 清理 cookies 临时目录
    rmSync(tmpCookiesDir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["meta-only"]);

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string | boolean> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < rest.length) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new CliError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      i += 1;
    } else {
      flags[name] = rest[i + 1] ?? "";
      i += 2;
    }
  }
  return { cmd, flags };
}

export async function main(argv: string[]): Promise<unknown> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd !== "prep") throw new CliError(`未知子命令: ${cmd ?? "(空)"}（仅支持 prep）`);

  const url = flags.url;
  const tripId = flags.trip;
  if (!url || typeof url !== "string") throw new CliError("--url 是必填参数");
  if (!tripId || typeof tripId !== "string") throw new CliError("--trip 是必填参数");

  const metaOnly = flags["meta-only"] === true;
  const maxFramesRaw = flags["max-frames"];
  let maxFrames: number | undefined;
  if (typeof maxFramesRaw === "string" && maxFramesRaw !== "") {
    maxFrames = parseInt(maxFramesRaw, 10);
    if (!Number.isFinite(maxFrames) || maxFrames <= 0) {
      throw new CliError(`--max-frames 必须是正整数: "${maxFramesRaw}"`);
    }
  }

  return runPrep(tripId, url, { metaOnly, maxFrames });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    },
    (err) => {
      if (err instanceof DependencyError) {
        process.stderr.write(
          `${JSON.stringify({ error: err.message, missing: err.missing, install_hint: err.installHint })}\n`,
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      }
      process.exit(1);
    },
  );
}
