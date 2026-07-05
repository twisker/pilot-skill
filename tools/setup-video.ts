import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { tmpdir } from "node:os";
import { pilotBinDir, exeName } from "./lib/video-deps";

// ---------------------------------------------------------------------------
// PILOT setup-video.ts —— 视频依赖（yt-dlp / ffmpeg / ffprobe）一键安装（Task 21）
//
//   install [--yes] [--force] [--only yt-dlp|ffmpeg]
//     下载各平台官方静态二进制到 ~/.pilot/bin/，跑 --version 校验后即可用，
//     不依赖 brew / winget / apt，也不需要用户预装 python。
//
// 下载源（均为发行方官方静态构建，跟随重定向下载）：
//   yt-dlp   —— GitHub Releases 单文件二进制（yt-dlp_macos / yt-dlp_linux / yt-dlp.exe）
//   ffmpeg/ffprobe（静态构建，无需系统库）：
//     darwin —— evermeet.cx（ffmpeg 与 ffprobe 各一个 zip，包内即单个可执行文件）
//     linux  —— johnvansickle.com 静态构建 tar.xz（含 ffmpeg + ffprobe）
//     win32  —— gyan.dev release-essentials zip（bin/ffmpeg.exe + bin/ffprobe.exe）
//
// 解压策略——不引入新 npm 依赖（extract-zip 等），全部用操作系统自带工具：
//   darwin：unzip（BSD 自带）      linux：tar（GNU coreutils 自带）
//   win32 ：PowerShell Expand-Archive（Windows 10+/PowerShell 5.1+ 自带 cmdlet）
// 三者均为对应系统事实标准工具，比新增 npm 包更稳（无 native addon 编译风险、
// 无需处理 npm registry 不可达时的降级）。
//
// 幂等：目标文件已存在且 --version 正常 → 跳过；--force 强制重下。
// ---------------------------------------------------------------------------

export class SetupVideoError extends Error {}

type Platform = NodeJS.Platform;

// ---------------------------------------------------------------------------
// 纯函数部分：下载/解压计划（可单测，不碰网络/文件系统）
// ---------------------------------------------------------------------------

export interface DownloadSpec {
  url: string;
}

/** yt-dlp：各平台官方 PyInstaller 单文件构建，不依赖系统 python */
export function ytDlpDownloadSpec(platform: Platform): DownloadSpec {
  const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
  if (platform === "darwin") return { url: `${base}/yt-dlp_macos` };
  if (platform === "win32") return { url: `${base}/yt-dlp.exe` };
  return { url: `${base}/yt-dlp_linux` };
}

export type FfmpegPlanKind = "evermeet-dual-zip" | "johnvansickle-tar-xz" | "gyan-zip";

export interface FfmpegPlan {
  kind: FfmpegPlanKind;
  /** evermeet-dual-zip 时有两个独立下载；其余是单个打包体 */
  urls: string[];
}

export function ffmpegDownloadPlan(platform: Platform): FfmpegPlan {
  if (platform === "darwin") {
    return {
      kind: "evermeet-dual-zip",
      urls: ["https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip", "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"],
    };
  }
  if (platform === "win32") {
    return { kind: "gyan-zip", urls: ["https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"] };
  }
  return {
    kind: "johnvansickle-tar-xz",
    urls: ["https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"],
  };
}

export interface Dependency {
  name: string;
  /** 目标文件名（不含平台后缀，exeName() 会按需补 .exe） */
  files: string[];
}

export const DEPENDENCIES: Dependency[] = [
  { name: "yt-dlp", files: ["yt-dlp"] },
  { name: "ffmpeg", files: ["ffmpeg", "ffprobe"] },
];

// ---------------------------------------------------------------------------
// I/O 部分：下载（跟随重定向）/ 解压（平台原生工具）/ 校验
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const USER_AGENT = "pilot-setup-video/1.0 (+https://github.com/twisker/pilot-skill)";

export function downloadFile(url: string, destPath: string, redirectsLeft = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new SetupVideoError(`下载失败：重定向次数过多 / too many redirects: ${url}`));
          return;
        }
        downloadFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new SetupVideoError(`下载失败（HTTP ${status}）/ download failed: ${url}`));
        return;
      }
      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (err) => reject(err));
    });
    req.on("error", (err) => reject(err));
  });
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf-8", shell: process.platform === "win32" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 解压 archivePath 到 destDir（覆盖），平台原生工具，不新增 npm 依赖：
 *   darwin -> unzip -o；linux -> tar -xJf；win32 -> PowerShell Expand-Archive -Force
 */
export function extractArchive(archivePath: string, destDir: string, platform: Platform = process.platform): void {
  mkdirSync(destDir, { recursive: true });
  if (platform === "win32") {
    const psCmd = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const result = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd]);
    if (!result.ok) throw new SetupVideoError(`Expand-Archive 解压失败 / archive extraction failed: ${result.stderr}`);
    return;
  }
  if (platform === "linux") {
    const result = run("tar", ["-xJf", archivePath, "-C", destDir]);
    if (!result.ok) throw new SetupVideoError(`tar 解压失败 / archive extraction failed: ${result.stderr}`);
    return;
  }
  // darwin
  const result = run("unzip", ["-o", archivePath, "-d", destDir]);
  if (!result.ok) throw new SetupVideoError(`unzip 解压失败 / archive extraction failed: ${result.stderr}`);
}

/** 在目录树里递归找到名为 name 的文件（用于从 tar/zip 解出的嵌套发行目录里定位二进制） */
export function findFileRecursive(root: string, name: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

export function verifyBinary(binPath: string, versionFlag: "--version" | "-version" = "--version"): boolean {
  if (!existsSync(binPath)) return false;
  const result = spawnSync(binPath, [versionFlag], { stdio: "ignore" });
  return result.status === 0;
}

function ensureExecutable(binPath: string, platform: Platform): void {
  if (platform === "win32") return; // Windows 不需要 chmod
  chmodSync(binPath, 0o755);
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface InstallOptions {
  force?: boolean;
  only?: "yt-dlp" | "ffmpeg";
  platform?: Platform;
  log?: (msg: string) => void;
}

export interface InstallResult {
  name: string;
  path: string;
  outcome: "installed" | "skipped-already-ok" | "failed";
  error?: string;
}

async function installYtDlp(binDir: string, opts: InstallOptions): Promise<InstallResult> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? (() => {});
  const destPath = path.join(binDir, exeName("yt-dlp", platform));

  if (!opts.force && verifyBinary(destPath, "--version")) {
    return { name: "yt-dlp", path: destPath, outcome: "skipped-already-ok" };
  }

  const spec = ytDlpDownloadSpec(platform);
  log(`下载 yt-dlp / downloading yt-dlp ... (${spec.url})`);
  try {
    await downloadFile(spec.url, destPath);
    ensureExecutable(destPath, platform);
    if (!verifyBinary(destPath, "--version")) {
      throw new SetupVideoError(
        macQuarantineHint(platform, destPath, "yt-dlp --version 校验失败 / verification failed"),
      );
    }
    return { name: "yt-dlp", path: destPath, outcome: "installed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "yt-dlp", path: destPath, outcome: "failed", error: message };
  }
}

function macQuarantineHint(platform: Platform, binPath: string, base: string): string {
  if (platform !== "darwin") return base;
  return `${base}；如提示"无法验证开发者"，执行 xattr -d com.apple.quarantine "${binPath}" 后重试 / if macOS Gatekeeper blocks it, run the xattr command above and retry`;
}

async function installFfmpeg(binDir: string, opts: InstallOptions): Promise<InstallResult[]> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? (() => {});
  const ffmpegDest = path.join(binDir, exeName("ffmpeg", platform));
  const ffprobeDest = path.join(binDir, exeName("ffprobe", platform));

  if (!opts.force && verifyBinary(ffmpegDest, "-version") && verifyBinary(ffprobeDest, "-version")) {
    return [
      { name: "ffmpeg", path: ffmpegDest, outcome: "skipped-already-ok" },
      { name: "ffprobe", path: ffprobeDest, outcome: "skipped-already-ok" },
    ];
  }

  const plan = ffmpegDownloadPlan(platform);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "pilot-setup-video-"));
  try {
    if (plan.kind === "evermeet-dual-zip") {
      const [ffmpegZipUrl, ffprobeZipUrl] = plan.urls;
      log(`下载 ffmpeg / downloading ffmpeg ... (${ffmpegZipUrl})`);
      const ffmpegZip = path.join(tmpDir, "ffmpeg.zip");
      await downloadFile(ffmpegZipUrl, ffmpegZip);
      extractArchive(ffmpegZip, path.join(tmpDir, "ffmpeg-extract"), platform);
      const ffmpegBin = findFileRecursive(path.join(tmpDir, "ffmpeg-extract"), "ffmpeg");
      if (!ffmpegBin) throw new SetupVideoError("evermeet ffmpeg.zip 内未找到 ffmpeg 可执行文件");
      copyFileSync(ffmpegBin, ffmpegDest);

      log(`下载 ffprobe / downloading ffprobe ... (${ffprobeZipUrl})`);
      const ffprobeZip = path.join(tmpDir, "ffprobe.zip");
      await downloadFile(ffprobeZipUrl, ffprobeZip);
      extractArchive(ffprobeZip, path.join(tmpDir, "ffprobe-extract"), platform);
      const ffprobeBin = findFileRecursive(path.join(tmpDir, "ffprobe-extract"), "ffprobe");
      if (!ffprobeBin) throw new SetupVideoError("evermeet ffprobe.zip 内未找到 ffprobe 可执行文件");
      copyFileSync(ffprobeBin, ffprobeDest);
    } else {
      const [bundleUrl] = plan.urls;
      log(`下载 ffmpeg+ffprobe 打包体 / downloading ffmpeg+ffprobe bundle ... (${bundleUrl})`);
      const archivePath = path.join(tmpDir, plan.kind === "gyan-zip" ? "ffmpeg.zip" : "ffmpeg.tar.xz");
      await downloadFile(bundleUrl, archivePath);
      const extractDir = path.join(tmpDir, "extract");
      extractArchive(archivePath, extractDir, platform);

      const ffmpegName = exeName("ffmpeg", platform);
      const ffprobeName = exeName("ffprobe", platform);
      const ffmpegBin = findFileRecursive(extractDir, ffmpegName);
      const ffprobeBin = findFileRecursive(extractDir, ffprobeName);
      if (!ffmpegBin || !ffprobeBin) {
        throw new SetupVideoError(`发行包内未找到 ffmpeg/ffprobe 可执行文件 / binaries not found in archive: ${extractDir}`);
      }
      copyFileSync(ffmpegBin, ffmpegDest);
      copyFileSync(ffprobeBin, ffprobeDest);
    }

    ensureExecutable(ffmpegDest, platform);
    ensureExecutable(ffprobeDest, platform);

    const results: InstallResult[] = [];
    for (const [name, destPath] of [
      ["ffmpeg", ffmpegDest],
      ["ffprobe", ffprobeDest],
    ] as const) {
      if (!verifyBinary(destPath, "-version")) {
        results.push({
          name,
          path: destPath,
          outcome: "failed",
          error: macQuarantineHint(platform, destPath, `${name} -version 校验失败 / verification failed`),
        });
      } else {
        results.push({ name, path: destPath, outcome: "installed" });
      }
    }
    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      { name: "ffmpeg", path: ffmpegDest, outcome: "failed", error: message },
      { name: "ffprobe", path: ffprobeDest, outcome: "failed", error: message },
    ];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runInstall(opts: InstallOptions = {}): Promise<InstallResult[]> {
  const platform = opts.platform ?? process.platform;
  const binDir = pilotBinDir();
  mkdirSync(binDir, { recursive: true });

  const results: InstallResult[] = [];
  if (!opts.only || opts.only === "yt-dlp") {
    results.push(await installYtDlp(binDir, { ...opts, platform }));
  }
  if (!opts.only || opts.only === "ffmpeg") {
    results.push(...(await installFfmpeg(binDir, { ...opts, platform })));
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { cmd: string | undefined; force: boolean; only?: "yt-dlp" | "ffmpeg"; yes: boolean } {
  const [cmd, ...rest] = argv;
  let force = false;
  let yes = false;
  let only: "yt-dlp" | "ffmpeg" | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--force") force = true;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--only") {
      const value = rest[i + 1];
      if (value !== "yt-dlp" && value !== "ffmpeg") {
        throw new SetupVideoError(`--only 只支持 yt-dlp/ffmpeg，收到: ${value ?? "(缺失)"}`);
      }
      only = value;
      i++;
    }
  }
  return { cmd, force, only, yes };
}

if (require.main === module) {
  (async () => {
    try {
      const { cmd, force, only } = parseArgs(process.argv.slice(2));
      if (cmd !== "install") {
        throw new SetupVideoError(`未知子命令: ${cmd ?? "(空)"}（仅支持 install）`);
      }
      const results = await runInstall({
        force,
        only,
        log: (msg) => process.stderr.write(`[setup-video] ${msg}\n`),
      });
      const failed = results.filter((r) => r.outcome === "failed");
      process.stdout.write(`${JSON.stringify(results)}\n`);
      process.exit(failed.length > 0 ? 1 : 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    }
  })();
}
