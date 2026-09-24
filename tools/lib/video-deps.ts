import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// PILOT lib/video-deps.ts —— 视频依赖（yt-dlp/ffmpeg/ffprobe）跨平台探测（Task 21）
//
// 探测顺序：~/.pilot/bin/<name>[.exe] 优先（tools/setup-video.ts 一键安装落点）
// → 找不到则回退裸命令名，交给 OS/PATH 解析（Windows 下 libuv 会按 PATHEXT
// 补全 .exe/.cmd 后缀，无需我们手动拼）。
//
// 纯函数（不碰网络/不 spawn），供 video.ts 编排调用，也便于单测：注入
// PILOT_HOME 与 existsSync 均可在测试里做到确定性。
// ---------------------------------------------------------------------------

export function getPilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PILOT_HOME || path.join(homedir(), ".pilot");
}

export function pilotBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPilotHome(env), "bin");
}

/** win32 下二进制名带 .exe 后缀；darwin/linux 不带 */
export function exeName(base: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 注入用于单测；默认 node:fs existsSync */
  exists?: (p: string) => boolean;
}

/**
 * 解析单个二进制的调用路径：~/.pilot/bin/ 下存在就返回绝对路径，否则返回裸命令名
 * （交给 PATH 兜底）。
 */
export function resolveBinaryPath(base: string, opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const bundled = path.join(pilotBinDir(env), exeName(base, platform));
  return exists(bundled) ? bundled : base;
}

export interface VideoBinaries {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
}

/** video.ts 用的默认三件套：优先 ~/.pilot/bin，否则裸名走 PATH */
export function resolveDefaultBinaries(opts: ResolveOptions = {}): VideoBinaries {
  return {
    ytDlp: resolveBinaryPath("yt-dlp", opts),
    ffmpeg: resolveBinaryPath("ffmpeg", opts),
    ffprobe: resolveBinaryPath("ffprobe", opts),
  };
}

// ---------------------------------------------------------------------------
// 跨平台执行计划（Windows .cmd/.bat 支持）
// ---------------------------------------------------------------------------

export interface SpawnPlan {
  file: string;
  args: string[];
  /** win32 + .cmd/.bat 时为 true：命令行由本模块手工构造，要求 Node 原样透传 */
  windowsVerbatimArguments?: boolean;
}

/**
 * cmd.exe 会把命令行再解析一遍，双引号内的 `& | < > ^` 均为字面量——这是
 * 参数里带 URL（可能含 `&` query 分隔符）仍然安全的前提。
 * 但 `"` 会破坏引号边界、换行无法表达，故直接拒绝而非静默构造出错误命令。
 */
function quoteForCmd(arg: string): string {
  if (/["\r\n]/.test(arg)) {
    throw new Error(`参数含无法安全传给 cmd.exe 的字符（双引号或换行）: ${JSON.stringify(arg)}`);
  }
  return `"${arg}"`;
}

/**
 * 生成调用外部二进制的执行计划。
 *
 * Windows 上 Node 自 CVE-2024-27980 起禁止无 shell 直接执行 .cmd/.bat
 * （execFile/execFileSync 直接抛 EINVAL）。而 PATH 上的 yt-dlp/ffmpeg 可能是
 * npm / pipx / scoop 风格的 .cmd shim，因此这里包装为：
 *
 *     cmd.exe /d /s /c ""<bin>" "<arg1>" "<arg2>""
 *
 * 最外层那一对引号是给 cmd 的 /s 剥离用的（cross-spawn 同款做法），剥掉后
 * 剩下 `"<bin>" "<arg1>" ...` 交给 cmd 执行，每个参数各自被引号保护。
 * 非 win32 或非 .cmd/.bat 一律原样返回，不引入 shell（保持 posix 行为不变）。
 */
export function planSpawn(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; comspec?: string } = {},
): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) {
    return { file: bin, args };
  }
  const comspec = opts.comspec ?? process.env.ComSpec ?? "cmd.exe";
  const inner = [bin, ...args].map(quoteForCmd).join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${inner}"`],
    windowsVerbatimArguments: true,
  };
}
