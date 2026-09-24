import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseShowinfoSceneTimes,
  shotBoundariesFromSceneChanges,
  timestampsPerShot,
  pacingProfile,
  classifyPacing,
  detectShotBoundaries,
  extractFrames,
  computeFrameTimestamps,
  type Shot,
} from "../lib/video-frames";
import { checkBinary } from "../video";

// ---------------------------------------------------------------------------
// 视频理解增强（切镜 + 按镜头取帧 + 节奏指标）单测
//
// 分两层：
//   ① 纯函数（parseShowinfo / 镜头区间 / 按镜头分配时间点 / 节奏指标）——无外部依赖，永远跑
//   ② 真实 ffmpeg（场景检测、按给定时间点抽帧）——ffmpeg/ffprobe 缺失时整组 skip，
//      与本仓 video.test.ts 同一套「未装则跳过、不制造假红灯」哲学
// ---------------------------------------------------------------------------

const HAS_FFMPEG = checkBinary("ffmpeg") && checkBinary("ffprobe");

// 场景检测产出的两刀：4.1s 与 8.2s（首尾夹着 ffmpeg 的常规噪声行）
const REAL_SHOWINFO_STDERR = [
  "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
  "  built with Apple clang version 16.0.0 (clang-1600.0.26.6)",
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.mp4':",
  "  Metadata:",
  "    major_brand     : isom",
  "  Duration: 00:00:10.00, start: 0.000000, bitrate: 96 kb/s",
  "  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), yuv420p(progressive), 320x240, 90 kb/s, 10 fps, 10 tbr, 10240 tbn",
  "[Parsed_showinfo_1 @ 0x7f8e4a5042c0] n:  41 pts:  41000 pts_time:4.1 pos:    48234 fmt:yuv420p sar:1/1 s:320x240 i:P iskey:1 type:I checksum:8B4C11F0 plane_checksum:[0F1F0F0F 0F0F0F0F 0F0F0F0F] mean:[128 128 128] stdev:[10.2 8.1 7.9]",
  "[Parsed_showinfo_1 @ 0x7f8e4a5042c0] n:  82 pts:  82000 pts_time:8.2 pos:    96468 fmt:yuv420p sar:1/1 s:320x240 i:P iskey:1 type:I checksum:1A2B3C4D plane_checksum:[1A1A1A1A 2B2B2B2B 3C3C3C3C] mean:[128 128 128] stdev:[9.9 8.0 7.7]",
  "[out#0/null @ 0x7f8e4b104200] video:14kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown",
  "frame=  100 fps=0.0 q=-0.0 Lsize=N/A time=00:00:10.00 bitrate=N/A speed= 118x",
].join("\n");

describe("lib/video-frames: parseShowinfoSceneTimes（场景切换时刻解析）", () => {
  it("真实 ffmpeg 输出片段：提取 pts_time 并忽略噪声行", () => {
    expect(parseShowinfoSceneTimes(REAL_SHOWINFO_STDERR)).toEqual([4.1, 8.2]);
  });

  it("去重：同一时刻出现多次只保留一个", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1] n:0 pts:5000 pts_time:5.0 pos:1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x1] n:1 pts:5000 pts_time:5.0 pos:1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x1] n:2 pts:5000 pts_time:5.00 pos:1 fmt:yuv420p",
    ].join("\n");
    expect(parseShowinfoSceneTimes(stderr)).toEqual([5]);
  });

  it("升序：输入顺序乱序也按时间升序返回", () => {
    const stderr = ["pts_time:9.5", "pts_time:1.25", "pts_time:4"].join("\n");
    expect(parseShowinfoSceneTimes(stderr)).toEqual([1.25, 4, 9.5]);
  });

  it("空串 → []（不抛异常）", () => {
    expect(parseShowinfoSceneTimes("")).toEqual([]);
  });

  it("乱码 → []（不抛异常）", () => {
    expect(parseShowinfoSceneTimes("\u0000\u0001\ufffd 乱码乱码 ??? \n###\n")).toEqual([]);
  });

  it("全是无 pts_time 的噪声行 → []", () => {
    const stderr = [
      "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
      "[Parsed_showinfo_1 @ 0x1] n:0 pts:0 pos:0 fmt:yuv420p s:320x240",
      "frame=  100 fps=0.0 time=00:00:10.00",
    ].join("\n");
    expect(parseShowinfoSceneTimes(stderr)).toEqual([]);
  });
});

describe("lib/video-frames: shotBoundariesFromSceneChanges（切换点 → 镜头区间）", () => {
  it("无切换点：整段一个镜头", () => {
    expect(shotBoundariesFromSceneChanges([], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it("单切换点：切出两个镜头", () => {
    expect(shotBoundariesFromSceneChanges([5], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
  });

  it("多切换点：按升序切分成 N+1 个镜头", () => {
    expect(shotBoundariesFromSceneChanges([2, 5, 8], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 5 },
      { start: 5, end: 8 },
      { start: 8, end: 10 },
    ]);
  });

  it("越界/非有限切换点被过滤（<0 / >duration / NaN / Infinity）", () => {
    const shots = shotBoundariesFromSceneChanges([-1, 0, 5, 10, 12, NaN, Infinity, -Infinity], 10);
    expect(shots).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
  });

  it("相邻去重：靠得很近的两刀合并为一处（差值 >0.05s 保留）", () => {
    expect(shotBoundariesFromSceneChanges([5, 5.01, 5.02, 5.5, 7], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 5.5 },
      { start: 5.5, end: 7 },
      { start: 7, end: 10 },
    ]);
    // 0.06s 间距 > 0.05s：视为两刀（注意 0.05 恰好落在二进制浮点边界上，测试避开）
    expect(shotBoundariesFromSceneChanges([5, 5.06], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 5.06 },
      { start: 5.06, end: 10 },
    ]);
  });

  it("乱序输入先排序再切分", () => {
    expect(shotBoundariesFromSceneChanges([8, 2, 5], 10)).toEqual(
      shotBoundariesFromSceneChanges([2, 5, 8], 10),
    );
  });

  it("结果至少 1 个镜头（duration<=0 / NaN 时不产出 NaN）", () => {
    expect(shotBoundariesFromSceneChanges([1, 2], 0)).toEqual([{ start: 0, end: 0 }]);
    expect(shotBoundariesFromSceneChanges([], -5)).toEqual([{ start: 0, end: 0 }]);
    expect(shotBoundariesFromSceneChanges([1], NaN)).toEqual([{ start: 0, end: 0 }]);
  });
});

describe("lib/video-frames: timestampsPerShot（按镜头分配抽帧时间点）", () => {
  const fiveShots: Shot[] = [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
    { start: 4, end: 6 },
    { start: 6, end: 8 },
    { start: 8, end: 10 },
  ];

  it("镜头数 ≥ maxFrames：等间隔挑选 maxFrames 个镜头取中点（首尾都取到）", () => {
    expect(timestampsPerShot(fiveShots, 3)).toEqual([1, 5, 9]);
  });

  it("maxFrames===1 且镜头很多时取第一个镜头的中点", () => {
    expect(timestampsPerShot(fiveShots, 1)).toEqual([1]);
  });

  it("镜头数 < maxFrames：每镜至少 1 帧，剩余额度按镜头时长从长到短补", () => {
    const shots: Shot[] = [
      { start: 0, end: 2 }, // 2s
      { start: 2, end: 4 }, // 2s
      { start: 4, end: 10 }, // 6s（最长，先补）
    ];
    // 每镜各 1 帧（剩 2 帧）→ 最长镜补 1 帧、次长的第 1 个镜头补 1 帧
    expect(timestampsPerShot(shots, 5)).toEqual([0.5, 1.5, 3, 5.5, 8.5]);
  });

  it("镜头数 < maxFrames：额度超过镜头数时轮转分配（长镜拿到的帧数 ≥ 短镜）", () => {
    const shots: Shot[] = [
      { start: 0, end: 1 }, // 短镜 1s
      { start: 1, end: 10 }, // 长镜 9s
    ];
    // maxFrames=5 → 每镜先 1 帧，剩 3 帧按降序轮转：长镜 +2、短镜 +1
    const ts = timestampsPerShot(shots, 5);
    expect(ts).toHaveLength(5);
    expect(ts).toEqual([0.25, 0.75, 2.5, 5.5, 8.5]);
    expect(ts.filter((t) => t < 1)).toHaveLength(2); // 短镜 2 帧
    expect(ts.filter((t) => t >= 1)).toHaveLength(3); // 长镜 3 帧（≥ 短镜）
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("maxFrames<=0 或 shots 为空 → []", () => {
    expect(timestampsPerShot(fiveShots, 0)).toEqual([]);
    expect(timestampsPerShot(fiveShots, -3)).toEqual([]);
    expect(timestampsPerShot([], 5)).toEqual([]);
  });

  it("结果升序且不超过 maxFrames，/每个镜头至少 1 帧（镜头数 < maxFrames 时）", () => {
    for (let shotCount = 1; shotCount <= 24; shotCount++) {
      const shots: Shot[] = Array.from({ length: shotCount }, (_, i) => ({
        start: (i * 10) / shotCount,
        end: ((i + 1) * 10) / shotCount,
      }));
      for (const maxFrames of [1, 2, 3, 7, 20]) {
        const ts = timestampsPerShot(shots, maxFrames);
        expect(ts).toHaveLength(maxFrames);
        expect(ts).toEqual([...ts].sort((a, b) => a - b));
        if (shotCount < maxFrames) {
          for (const shot of shots) {
            expect(ts.some((t) => t >= shot.start && t <= shot.end)).toBe(true);
          }
        }
      }
    }
  });
});

describe("lib/video-frames: pacingProfile（节奏指标）", () => {
  it("正常多镜头：秒数保留 2 位，cuts_per_minute=(shot_count-1)/(duration/60)", () => {
    // 10s / 2 镜 → 1 刀 / (10/60) 分钟 = 6 刀/分钟（正好落在 medium 左边界）
    expect(pacingProfile([{ start: 0, end: 5 }, { start: 5, end: 10 }], 10)).toEqual({
      shot_count: 2,
      avg_shot_s: 5,
      shortest_shot_s: 5,
      longest_shot_s: 5,
      cuts_per_minute: 6,
      pacing_style: "medium",
    });
  });

  it("单镜头：cuts_per_minute=0", () => {
    const profile = pacingProfile([{ start: 0, end: 60 }], 60);
    expect(profile.shot_count).toBe(1);
    expect(profile.avg_shot_s).toBe(60);
    expect(profile.cuts_per_minute).toBe(0);
    expect(profile.pacing_style).toBe("slow");
  });

  it("秒数四舍五入到 2 位小数", () => {
    const profile = pacingProfile([{ start: 0, end: 3.333 }, { start: 3.333, end: 10 }], 10);
    expect(profile.avg_shot_s).toBe(5);
    expect(profile.shortest_shot_s).toBe(3.33);
    expect(profile.longest_shot_s).toBe(6.67);
  });

  it("duration<=0 → 全 0 且 pacing_style: unknown", () => {
    expect(pacingProfile([{ start: 0, end: 10 }], 0)).toEqual({
      shot_count: 0,
      avg_shot_s: 0,
      shortest_shot_s: 0,
      longest_shot_s: 0,
      cuts_per_minute: 0,
      pacing_style: "unknown",
    });
    expect(pacingProfile([{ start: 0, end: 10 }], -1).pacing_style).toBe("unknown");
  });

  it("shots 为空时同样给 unknown（不做除零）", () => {
    expect(pacingProfile([], 60).pacing_style).toBe("unknown");
    expect(pacingProfile([], 60).shot_count).toBe(0);
  });

  it("分档边界：cpm<6 → slow；6 与 15 → medium；>15 → fast", () => {
    const shotsOf = (count: number): Shot[] =>
      Array.from({ length: count }, (_, i) => ({ start: (i * 60) / count, end: ((i + 1) * 60) / count }));
    expect(pacingProfile(shotsOf(6), 60).cuts_per_minute).toBe(5);
    expect(pacingProfile(shotsOf(6), 60).pacing_style).toBe("slow");
    expect(pacingProfile(shotsOf(7), 60).cuts_per_minute).toBe(6);
    expect(pacingProfile(shotsOf(7), 60).pacing_style).toBe("medium");
    expect(pacingProfile(shotsOf(16), 60).cuts_per_minute).toBe(15);
    expect(pacingProfile(shotsOf(16), 60).pacing_style).toBe("medium");
    expect(pacingProfile(shotsOf(17), 60).cuts_per_minute).toBe(16);
    expect(pacingProfile(shotsOf(17), 60).pacing_style).toBe("fast");

    // classifyPacing 自身：非有限值一律 unknown
    expect(classifyPacing(NaN)).toBe("unknown");
    expect(classifyPacing(Infinity)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 真实 ffmpeg：场景检测 + 按给定时间点抽帧
// ---------------------------------------------------------------------------

let fixtureDir: string;
/** 3s testsrc + 3s smptebars 拼接 → 3s 处一刀硬切，供场景检测断言 */
let cutVideoPath: string;

beforeAll(() => {
  if (!HAS_FFMPEG) return;
  fixtureDir = mkdtempSync(path.join(tmpdir(), "pilot-video-shots-fixture-"));
  cutVideoPath = path.join(fixtureDir, "cut.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "smptebars=duration=3:size=320x240:rate=10",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
    "-y", cutVideoPath,
  ]);
}, 60000);

afterAll(() => {
  if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true });
});

describe.skipIf(!HAS_FFMPEG)("lib/video-frames: detectShotBoundaries（真实 ffmpeg 场景检测）", () => {
  it("检出硬切点（3s 处），返回升序有限数值", async () => {
    const changes = await detectShotBoundaries(cutVideoPath);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.every((t) => Number.isFinite(t))).toBe(true);
    expect(changes).toEqual([...changes].sort((a, b) => a - b));
    expect(changes.some((t) => Math.abs(t - 3) < 0.7)).toBe(true);

    // 端到端：切换点 → 镜头区间 → 每镜至少 1 帧
    const shots = shotBoundariesFromSceneChanges(changes, 6);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    const ts = timestampsPerShot(shots, 20);
    expect(ts).toHaveLength(20);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    for (const shot of shots) {
      expect(ts.some((t) => t >= shot.start && t <= shot.end)).toBe(true);
    }
  }, 60000);

  it("视频不可读时抛出可读错误（调用方据此回退）", async () => {
    await expect(detectShotBoundaries(path.join(fixtureDir, "does-not-exist.mp4"))).rejects.toThrow(/场景检测/);
  }, 30000);
});

describe.skipIf(!HAS_FFMPEG)("lib/video-frames: extractFrames 传 timestamps（按给定时刻抽帧）", () => {
  it("按给定时间点抽帧：帧数=时间点个数（不受 maxFrames 影响）", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "pilot-video-shots-frames-"));
    try {
      // 5 个时间点但 maxFrames=2：走均匀路径只会出 2 帧，说明确实用了传入的时间点
      const timestamps = [0.5, 1.5, 2.5, 4.5, 5.5];
      const frames = await extractFrames(cutVideoPath, outDir, { duration: 6, maxFrames: 2, timestamps });
      expect(frames).toEqual([
        "frame-001.jpg",
        "frame-002.jpg",
        "frame-003.jpg",
        "frame-004.jpg",
        "frame-005.jpg",
      ]);
      for (const frame of frames) {
        expect(existsSync(path.join(outDir, frame))).toBe(true);
        expect(readFileSync(path.join(outDir, frame)).length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(outDir, { recursive: true });
    }
  }, 60000);

  it("onProgress 按传入时间点个数回调（进度语义不变）", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "pilot-video-shots-progress-"));
    try {
      const calls: Array<[number, number]> = [];
      await extractFrames(cutVideoPath, outDir, {
        duration: 6,
        maxFrames: 2,
        timestamps: [1, 3, 5],
        onProgress: (current, total) => calls.push([current, total]),
      });
      expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    } finally {
      rmSync(outDir, { recursive: true });
    }
  }, 60000);

  it("不传 timestamps 时保持向后兼容：仍按时长均匀抽 maxFrames 帧", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "pilot-video-shots-uniform-"));
    try {
      const frames = await extractFrames(cutVideoPath, outDir, { duration: 6, maxFrames: 4 });
      expect(frames).toEqual(["frame-001.jpg", "frame-002.jpg", "frame-003.jpg", "frame-004.jpg"]);
      expect(computeFrameTimestamps(6, 4)).toEqual([0.75, 2.25, 3.75, 5.25]);
    } finally {
      rmSync(outDir, { recursive: true });
    }
  }, 60000);
});
