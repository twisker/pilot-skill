// ---------------------------------------------------------------------------
// PILOT lib/cookie-convert.ts —— playwright storageState JSON → Netscape
// cookies.txt 格式转换（纯函数）。
//
// B 站等站点的登录态以 playwright storageState 格式存在 ~/.pilot/cookies/*.json
// （与 lib/sites/cookies.ts 抓取路径共用同一份 cookie 文件），但 yt-dlp 的
// --cookies 参数只认 Netscape HTTP Cookie File 格式，因此 video.ts 在调用
// yt-dlp 前需要现场转换成临时文件。
// ---------------------------------------------------------------------------

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // -1 = session cookie（playwright 约定）
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: unknown[];
}

const HEADER = "# Netscape HTTP Cookie File\n# 由 PILOT video.ts 自动生成，勿手改\n\n";

function toNetscapeLine(cookie: StorageStateCookie): string {
  // yt-dlp 的 MozillaCookieJar 要求 httpOnly cookie 的 domain 字段加 #HttpOnly_ 前缀
  const domain = cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain;
  const includeSubdomains = cookie.domain.startsWith(".") ? "TRUE" : "FALSE";
  const cookiePath = cookie.path || "/";
  const secure = cookie.secure ? "TRUE" : "FALSE";
  // playwright 用 -1 表示会话 cookie；Netscape 格式里会话 cookie 用 0 表示
  const expiry = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
  return [domain, includeSubdomains, cookiePath, secure, String(expiry), cookie.name, cookie.value].join("\t");
}

/**
 * 把 playwright storageState 转换为 Netscape cookies.txt 文本内容。
 */
export function storageStateToNetscape(storageState: StorageState): string {
  const lines = (storageState.cookies ?? []).map(toNetscapeLine);
  return HEADER + lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
