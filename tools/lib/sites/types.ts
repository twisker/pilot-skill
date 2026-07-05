import type { Page } from "playwright";

export interface ExtractResult {
  title: string;
  text: string;
}

/**
 * 站点适配层统一接口：每个站点一个小模块，导出 SiteAdapter。
 * match    —— 判定该 URL 是否归属本站点（可附带前置条件，如 xhs 的 cookie 门控）
 * prepare  —— 页面导航完成后的站点专属等待/预处理（等选择器渲染、滚动加载等）
 * extract  —— 从已渲染的 page 中抽取标题与正文
 */
export interface SiteAdapter {
  match(url: string): boolean;
  prepare(page: Page): Promise<void>;
  extract(page: Page): Promise<ExtractResult>;
  /**
   * 可选：登录态 cookie 文件名（相对 ~/.pilot/cookies/，如 "mafengwo.json"）。
   * scrape.ts 创建 browser context 时若该文件存在则加载为 playwright
   * storageState；不存在则正常无 cookie 抓取，不视为失败（xhs 是例外——
   * 见 xhs.ts 的硬门控，无 cookie 直接在 scrape.ts 的 selectAdapter 判 failed）。
   */
  cookieFile?: string;
}
