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
