import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tripDir, writeJson } from "./workspace";

// ---------------------------------------------------------------------------
// PILOT lib/progress.ts —— 长任务体验（spec §10.9，产品负责人 UX 红线）
//
// 后台耗时工具（scrape/video/distill/export）统一在处理每个单元时调用
// reportProgress()：原子写 <trip>/progress.json（server /api/state 聚合，
// SSE 自然覆盖），并向 stderr 打一行人类可读进度，终端直接跑工具时也有
// 滚动反馈，不让用户以为死机。
//
// stage 枚举 = 主链路九阶段（intake/search/fetch/structure/distill/
// itinerary/refine/check/export）+ video（视频预处理支线，⑤ 4.4 与文字
// distill 可并行跑，不计入九阶段 stepper 的顺序索引）。
//
// total 未知时（如下载阶段尚不知道总字节数/总步数）current/total 均填
// null——UI 按此展示沙漏动画而非进度条。
// ---------------------------------------------------------------------------

export const PROGRESS_STAGES = [
  "intake",
  "search",
  "fetch",
  "structure",
  "distill",
  "itinerary",
  "refine",
  "check",
  "export",
  "video",
] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export interface ProgressState {
  stage: ProgressStage;
  current: number | null;
  total: number | null;
  message: string;
  updated_at: string;
}

export interface ReportProgressInput {
  stage: ProgressStage;
  current?: number | null;
  total?: number | null;
  message: string;
}

const LOG_TRUNCATE_LEN = 60;

/**
 * 截断易超长字段（URL/文件名等）后再塞进 message，如 `"抓取中: " + truncateForLog(url)`。
 * 超长时保留前 maxLen-1 个字符 + "…"。
 */
export function truncateForLog(value: string, maxLen: number = LOG_TRUNCATE_LEN): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * 上报一次进度：原子写 <trip>/progress.json（复用 workspace.ts 的
 * atomicWriteFileSync）+ 打一行 stderr 人类可读日志。
 * current/total 省略或显式传 null 时统一落盘为 null（total 未知场景）。
 */
export function reportProgress(tripId: string, input: ReportProgressInput): ProgressState {
  const state: ProgressState = {
    stage: input.stage,
    current: input.current ?? null,
    total: input.total ?? null,
    message: input.message,
    updated_at: new Date().toISOString(),
  };
  writeJson(tripId, "progress.json", state);

  const counter = state.current != null && state.total != null ? ` ${state.current}/${state.total}` : "";
  process.stderr.write(`[${state.stage}${counter}] ${state.message}\n`);

  return state;
}

/** 清除进度文件（如整段长任务收尾）；文件不存在时 no-op，不抛错。 */
export function clearProgress(tripId: string): void {
  const filePath = path.join(tripDir(tripId), "progress.json");
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/**
 * 判断第 index 个（0-based，共 total 个）单元是否该上报一次进度：
 * 首条、每 everyN 条、末条都上报——用于"快操作可 N 条一报"的批量场景
 * （distill.ts validate/dedupe/score）。total<=0 时恒为 false。
 */
export function shouldReportTick(index: number, total: number, everyN: number = 10): boolean {
  if (total <= 0) return false;
  return index === 0 || (index + 1) % everyN === 0 || index === total - 1;
}
