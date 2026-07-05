import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// PILOT cookies.ts —— 站点适配层共享的 cookie（playwright storageState）加载。
//
// 全站点 cookie 支持（Task 7.5）：每个 SiteAdapter 可选声明 cookieFile 字段
// （相对 ~/.pilot/cookies/ 的文件名），scrape.ts 创建 browser context 时若该
// 文件存在则加载为 storageState；不存在则正常无 cookie 抓取，不视为失败。
// ---------------------------------------------------------------------------

export function getPilotHome(): string {
  return process.env.PILOT_HOME || path.join(homedir(), ".pilot");
}

export function cookieFilePath(cookieFile: string): string {
  return path.join(getPilotHome(), "cookies", cookieFile);
}

export function hasCookie(cookieFile: string): boolean {
  return existsSync(cookieFilePath(cookieFile));
}

export function loadStorageState(cookieFile: string): unknown {
  return JSON.parse(readFileSync(cookieFilePath(cookieFile), "utf-8"));
}
