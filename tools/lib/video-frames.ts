import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PILOT lib/video-frames.ts —— 纯函数：均匀抽帧时间点计算 + ffprobe 时长探测
// + ffmpeg 逐时间点截帧。不涉及下载/CLI，供 video.ts 编排调用，也便于单测
// （用现场生成的 testsrc 视频跳过下载环节直接测本模块）。
// ---------------------------------------------------------------------------

/**
 * 把 [0, duration] 均分为 count 段，取每段中点作为抽帧时间点（秒，保留两位小数）。
 * count<=0 或 duration<=0 时返回空数组。
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

/**
 * 用 ffprobe 读取视频时长（秒）。
 */
export async function probeDuration(videoPath: string, ffprobeBin = "ffprobe"): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobeBin, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]));
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
 * 按时长均匀抽 maxFrames 帧，写入 outDir，返回相对文件名列表（frame-001.jpg 起）。
 * outDir 不存在时自动创建。
 */
export async function extractFrames(
  videoPath: string,
  outDir: string,
  opts: {
    duration: number;
    maxFrames: number;
    ffmpegBin?: string;
    /** 每成功抽完一帧回调一次（1-based current, 总帧数）；供 video.ts 接入长任务进度上报（spec §10.9）。 */
    onProgress?: (current: number, total: number) => void;
  },
): Promise<string[]> {
  const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
  mkdirSync(outDir, { recursive: true });
  const timestamps = computeFrameTimestamps(opts.duration, opts.maxFrames);
  const frameNames: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const frameName = frameFileName(i);
    const framePath = path.join(outDir, frameName);
    try {
      await execFileAsync(ffmpegBin, [
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg 抽帧失败（第 ${i + 1} 帧，t=${timestamps[i]}s）: ${message}`);
    }
    frameNames.push(frameName);
    opts.onProgress?.(i + 1, timestamps.length);
  }
  return frameNames;
}
