import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { planSpawn } from "./video-deps";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PILOT lib/video-frames.ts —— 纯函数：均匀抽帧时间点计算 + ffprobe 时长探测
// + ffmpeg 逐时间点截帧。不涉及下载/CLI，供 video.ts 编排调用，也便于单测
// （用现场生成的 testsrc 视频跳过下载环节直接测本模块）。
//
// 2026-09-24 视频理解增强（参考 docs/recon/openmontage-recon.md「按镜头取帧」）：
//   ffmpeg 场景检测切镜 → 把切镜时刻转成镜头区间 → 在 ≤maxFrames 的前提下给
//   **每个镜头至少 1 帧** → 顺带产出节奏指标（pacing）给 AI 一条有锚点的时间轴。
//   均匀抽帧（computeFrameTimestamps）保留为**降级路径**，语义与测试均不变。
// ---------------------------------------------------------------------------

/**
 * 把 [0, duration] 均分为 count 段，取每段中点作为抽帧时间点（秒，保留两位小数）。
 * count<=0 或 duration<=0 时返回空数组。
 *
 * 降级路径的实现：场景检测不可用时 extractFrames 仍走这里（见 video.ts runPrep）。
 */
export function computeFrameTimestamps(duration: number, count: number): number[] {
  if (count <= 0 || duration <= 0) return [];
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (duration * (i + 0.5)) / count;
    timestamps.push(Number(t.toFixed(2)));
  }
  return timestamps;
}

// ---------------------------------------------------------------------------
// 切镜（场景检测）——纯函数部分
// ---------------------------------------------------------------------------

/** 一个镜头区间（秒，左闭右开语义：start 到 end 之间属于同一镜头） */
export interface Shot {
  start: number;
  end: number;
}

/** 节奏分档：slow / medium / fast；duration 非法时为 unknown */
export type PacingStyle = "slow" | "medium" | "fast" | "unknown";

export interface PacingProfile {
  shot_count: number;
  avg_shot_s: number;
  shortest_shot_s: number;
  longest_shot_s: number;
  cuts_per_minute: number;
  pacing_style: PacingStyle;
}

/** 场景切换阈值默认值：0.4（ffmpeg select 的 scene 分数，越大越不敏感） */
export const DEFAULT_SCENE_THRESHOLD = 0.4;

/** 相邻切换点差值小于该值视为同一处（同一刀被连续两帧检出） */
const SCENE_MERGE_EPSILON = 0.05;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * 解析 ffmpeg `select='gt(scene,0.4)',showinfo` 输出里的场景切换时刻。
 *
 * 真实输出形如：
 *   [Parsed_showinfo_1 @ 0x7f...] n:0 pts:  12345 pts_time:12.345 pos:... fmt:yuv420p ...
 * 逐行扫 `pts_time:<数字>`；数字去重（同一时刻只留一个）、升序返回。
 * 解析不出（空串 / 乱码 / 全是无 pts_time 的噪声行）返回 `[]`，**不抛异常**——
 * 调用方据此决定是否降级。
 */
export function parseShowinfoSceneTimes(stderr: string): number[] {
  const times = new Set<number>();
  for (const match of stderr.matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) times.add(value);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * 把场景切换时刻转成镜头区间：起于 0、止于 duration，切换点按升序切分。
 * - 过滤掉 ≤0 / ≥duration / 非有限值（NaN/Infinity）的切换点
 * - 过滤后再做相邻去重：差值 < 0.05s 视为同一处（保留靠前那个）
 * - 结果至少 1 个镜头（无切换点即整段一个镜头；duration 非法则 [{0,0}]）
 */
export function shotBoundariesFromSceneChanges(changes: number[], duration: number): Shot[] {
  if (!Number.isFinite(duration) || duration <= 0) return [{ start: 0, end: 0 }];

  const cuts: number[] = [];
  for (const change of [...changes].sort((a, b) => a - b)) {
    if (!Number.isFinite(change) || change <= 0 || change >= duration) continue;
    const last = cuts[cuts.length - 1];
    if (last !== undefined && change - last < SCENE_MERGE_EPSILON) continue;
    cuts.push(change);
  }

  const shots: Shot[] = [];
  let start = 0;
  for (const cut of cuts) {
    shots.push({ start, end: cut });
    start = cut;
  }
  shots.push({ start, end: duration });
  return shots;
}

function shotMidpoint(shot: Shot): number {
  return round2((shot.start + shot.end) / 2);
}

/**
 * 在 ≤maxFrames 的前提下给**每个镜头至少 1 帧**，返回升序时间点列表。
 *
 * - 镜头数 ≥ maxFrames：从镜头里等间隔挑选 maxFrames 个（首尾镜头都取到，
 *   maxFrames===1 时取第一个镜头），每个取其区间中点
 * - 镜头数 < maxFrames：每镜先取 1 帧（区间中点），剩余额度按**镜头时长从长到短**
 *   轮转分配（时长相同按原始顺序，保证确定性），较长镜头额外补帧；补帧落在该
 *   镜头区间内的均分位置（count 帧时取第 m 段的 (m+0.5)/count 处）
 * - maxFrames<=0 或 shots 为空 → `[]`
 */
export function timestampsPerShot(shots: Shot[], maxFrames: number): number[] {
  if (maxFrames <= 0 || shots.length === 0) return [];
  const result: number[] = [];

  if (shots.length >= maxFrames) {
    for (let i = 0; i < maxFrames; i++) {
      const index = maxFrames === 1 ? 0 : Math.round((i * (shots.length - 1)) / (maxFrames - 1));
      result.push(shotMidpoint(shots[index]));
    }
  } else {
    const remaining = maxFrames - shots.length;
    // 从长到短的分配顺序：轮转第 i 个额度 → 排序后第 i%n 个镜头（最长镜先补）
    const order = shots
      .map((shot, index) => ({ index, length: shot.end - shot.start }))
      .sort((a, b) => b.length - a.length || a.index - b.index);
    const extra = new Array<number>(shots.length).fill(0);
    for (let i = 0; i < remaining; i++) extra[order[i % order.length].index] += 1;

    shots.forEach((shot, index) => {
      const count = 1 + extra[index];
      const span = shot.end - shot.start;
      for (let m = 0; m < count; m++) {
        result.push(round2(shot.start + (span * (m + 0.5)) / count));
      }
    });
  }

  return result.sort((a, b) => a - b);
}

/**
 * 节奏分档阈值（左闭右闭：cpm===6 → medium，cpm===15 → medium）：
 * - `slow`   —— cuts_per_minute < 6，平均镜头 >10s：风光/讲解/Vlog 慢剪
 * - `medium` —— 6 ≤ cpm ≤ 15，平均镜头 4~10s：主流旅拍/纪录片常态剪辑
 * - `fast`   —— cpm > 15，平均镜头 <4s：卡点混剪/攻略速览
 */
export function classifyPacing(cutsPerMinute: number): PacingStyle {
  if (!Number.isFinite(cutsPerMinute)) return "unknown";
  if (cutsPerMinute < 6) return "slow";
  if (cutsPerMinute <= 15) return "medium";
  return "fast";
}

/**
 * 节奏指标（喂给 AI 的「有锚点的时间轴」摘要）：
 * - 秒数保留 2 位小数；avg 取各镜头时长的算术平均（正常切镜铺满 [0,duration] 时等于 duration/shot_count）
 * - cuts_per_minute = (shot_count - 1) / (duration/60)，保留 2 位小数
 * - duration<=0 或 shots 为空 → 全 0 + pacing_style:"unknown"
 */
export function pacingProfile(shots: Shot[], duration: number): PacingProfile {
  const unknown: PacingProfile = {
    shot_count: 0,
    avg_shot_s: 0,
    shortest_shot_s: 0,
    longest_shot_s: 0,
    cuts_per_minute: 0,
    pacing_style: "unknown",
  };
  if (!Number.isFinite(duration) || duration <= 0 || shots.length === 0) return unknown;

  const lengths = shots.map((shot) => shot.end - shot.start).filter((len) => Number.isFinite(len) && len > 0);
  const cutsPerMinute = (shots.length - 1) / (duration / 60);
  return {
    shot_count: shots.length,
    avg_shot_s: round2(lengths.length > 0 ? lengths.reduce((sum, len) => sum + len, 0) / lengths.length : 0),
    shortest_shot_s: round2(lengths.length > 0 ? Math.min(...lengths) : 0),
    longest_shot_s: round2(lengths.length > 0 ? Math.max(...lengths) : 0),
    cuts_per_minute: round2(cutsPerMinute),
    pacing_style: classifyPacing(cutsPerMinute),
  };
}

/**
 * 场景检测一遍视频，返回场景切换时刻（秒，升序）。
 *
 * 命令：`ffmpeg -i <video> -filter:v "select='gt(scene,0.4)',showinfo" -f null -`
 * （阈值可参数化，默认 0.4）。showinfo 逐帧写 stderr，解析交给
 * parseShowinfoSceneTimes。**必须经 planSpawn 包装**：Windows 上的 .cmd/.bat
 * shim（npm/pipx/scoop 风格）需要 cmd.exe 包装才能执行（见 video-deps）。
 *
 * 失败（spawn 失败 / 非零退出 / 超时 / 输出不可解析）一律抛可读错误，由调用方
 * （video.ts runPrep）catch 后回退均匀抽帧——本函数不吞错、也不负责降级。
 */
export async function detectShotBoundaries(
  videoPath: string,
  ffmpegBin = "ffmpeg",
  opts: { threshold?: number; maxBuffer?: number; timeoutMs?: number } = {},
): Promise<number[]> {
  const threshold = opts.threshold ?? DEFAULT_SCENE_THRESHOLD;
  const plan = planSpawn(ffmpegBin, [
    "-hide_banner",
    "-nostdin",
    "-i",
    videoPath,
    "-filter:v",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ]);
  let stderr: string;
  try {
    ({ stderr } = await execFileAsync(plan.file, plan.args, {
      // showinfo 对每个命中帧打一行，长视频可能上万行；缓冲给足避免 maxBuffer 截断
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      // 超时即杀进程 → reject → 调用方回退均匀抽帧（不让视频环节挂死）
      timeout: opts.timeoutMs ?? 5 * 60 * 1000,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg 场景检测失败（可能不支持 select 滤镜或视频不可读）: ${message}`);
  }
  // 「解析不出」兜底：退出码 0 但输出里既无 showinfo 记录、也无 ffmpeg 进度行
  // （frame= N）⇒ 输出不是本次场景检测的产物（例如被 PATH 上的假 shim 顶替），
  // 视为失败让调用方回退。有进度行但无 showinfo 是合法的「整段无剪切」。
  if (!/Parsed_showinfo/i.test(stderr) && !/frame=\s*\d+/.test(stderr)) {
    throw new Error("ffmpeg 场景检测输出无法解析：未发现 showinfo 记录");
  }
  return parseShowinfoSceneTimes(stderr);
}

/**
 * 用 ffprobe 读取视频时长（秒）。
 */
export async function probeDuration(videoPath: string, ffprobeBin = "ffprobe"): Promise<number> {
  let stdout: string;
  // win32 下 .cmd/.bat 需经 cmd.exe 包装才能执行（见 video-deps.planSpawn）
  const plan = planSpawn(ffprobeBin, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  try {
    ({ stdout } = await execFileAsync(plan.file, plan.args, {
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ffprobe 探测时长失败: ${message}`);
  }
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe 返回的时长无法解析: "${stdout.trim()}"`);
  }
  return duration;
}

function frameFileName(index: number): string {
  return `frame-${String(index + 1).padStart(3, "0")}.jpg`;
}

/**
 * 抽帧并写入 outDir，返回相对文件名列表（frame-001.jpg 起）。outDir 不存在时自动创建。
 *
 * 时间点来源：
 * - 传了 `timestamps` 就**照它抽**（video.ts 切镜后走这条：每镜至少 1 帧）
 * - 没传则沿用 `computeFrameTimestamps(duration, maxFrames)` 均匀抽帧（降级路径，
 *   向后兼容：老调用方行为完全不变）
 */
export async function extractFrames(
  videoPath: string,
  outDir: string,
  opts: {
    duration: number;
    maxFrames: number;
    ffmpegBin?: string;
    /** 显式抽帧时间点（秒，升序）；不给则按时长均匀抽帧 */
    timestamps?: number[];
    /** 每成功抽完一帧回调一次（1-based current, 总帧数）；供 video.ts 接入长任务进度上报（spec §10.9）。 */
    onProgress?: (current: number, total: number) => void;
  },
): Promise<string[]> {
  const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
  mkdirSync(outDir, { recursive: true });
  const timestamps = opts.timestamps ?? computeFrameTimestamps(opts.duration, opts.maxFrames);
  const frameNames: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const frameName = frameFileName(i);
    const framePath = path.join(outDir, frameName);
    try {
      const plan = planSpawn(ffmpegBin, [
        "-ss",
        String(timestamps[i]),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        framePath,
      ]);
      await execFileAsync(plan.file, plan.args, {
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg 抽帧失败（第 ${i + 1} 帧，t=${timestamps[i]}s）: ${message}`);
    }
    frameNames.push(frameName);
    opts.onProgress?.(i + 1, timestamps.length);
  }
  return frameNames;
}
