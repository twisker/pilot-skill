import type { Page } from "playwright";
import { extractFromHtml } from "../extract";
import type { SiteAdapter } from "./types";
import { cookieFilePath, hasCookie, loadStorageState } from "./cookies";

const XHS_DOMAINS = ["xiaohongshu.com", "xhslink.com"];
const COOKIE_FILE = "xhs.json";

export function isXhsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return XHS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function xhsCookiePath(): string {
  return cookieFilePath(COOKIE_FILE);
}

export function hasXhsCookie(): boolean {
  return hasCookie(COOKIE_FILE);
}

export function loadXhsStorageState(): unknown {
  return loadStorageState(COOKIE_FILE);
}

/**
 * cookie 门控：~/.pilot/cookies/xhs.json（playwright storageState 格式）
 * 不存在时 match 恒为 false，让上游 scrape.ts 把该条目直接判 failed
 * （reason: no-cookie），不会跌落到 generic 兜底去硬抓一个反爬/登录墙页面。
 * 这是 xhs 独有的硬门控，其余站点（mafengwo/zhihu/qyer）无 cookie 时仍会
 * 正常尝试抓取，只是登录态可用时体验更好（见 cookieFile 字段的通用处理）。
 */
export const xhsSite: SiteAdapter = {
  match(url: string): boolean {
    return isXhsUrl(url) && hasXhsCookie();
  },

  async prepare(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // 继续抽取当前渲染结果，交由上层按正文长度判 partial/failed
    }
  },

  async extract(page: Page) {
    const html = await page.content();
    return extractFromHtml(html);
  },

  cookieFile: COOKIE_FILE,
};
