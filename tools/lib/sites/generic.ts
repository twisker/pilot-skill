import type { Page } from "playwright";
import { extractFromHtml } from "../extract";
import type { SiteAdapter } from "./types";

/**
 * 兜底适配器：任何未被专属站点适配器 match 的 URL 最终都落到这里。
 * 不假设任何站点特定结构，只做「等网络空闲」+ extract.ts 的通用启发式抽取。
 */
export const genericSite: SiteAdapter = {
  match(): boolean {
    return true;
  },

  async prepare(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // 超时不视为失败：可能是长轮询/埋点脚本导致网络永不空闲，
      // 继续用当前已渲染的 DOM 抽取，由上层按正文长度判 partial/failed
    }
  },

  async extract(page: Page) {
    const html = await page.content();
    return extractFromHtml(html);
  },
};
