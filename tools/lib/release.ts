import { verifyPayload, publicKeyFromRawB64 } from "./signing";

// ---------------------------------------------------------------------------
// PILOT lib/release.ts —— 自升级「纯逻辑」层（v5.0 红线 6：升级通道完整性）
//
// 本模块只做可单测的纯计算：版本号解析/比较、GitHub Release 资产挑选、发布物
// 验签包装。**不碰网络、不碰磁盘、不抛非预期异常**——I/O 编排全部在
// tools/upgrade.ts，便于注入假下载函数做无网络单测。
//
// 发布物约定（公开发行仓 github.com/twisker/pilot-skill）：
//   - 资产：pilot-skill-<version>.tar.gz          （app/ 目录树打包，含 VERSION）
//   - 签名：pilot-skill-<version>.tar.gz.sig      （Ed25519 detached，base64）
//   - 公钥：raw 32 字节的 base64，内嵌于下方常量，由发布机生成
//
// 红线：验签失败一律拒用当前发布物并保留当前版本，绝不解压执行。
// ---------------------------------------------------------------------------

/** GitHub Releases「最新版」查询端点（判定「最新」由客户端比较版本号，不用 prerelease 语义） */
export const RELEASES_API = "https://api.github.com/repos/twisker/pilot-skill/releases/latest";

/**
 * 内嵌发布公钥（Ed25519 raw 32 字节 base64）。
 *
 * ⚠️ 占位值，尚未接线。由产品负责人在**发布机**执行：
 *     npx tsx scripts/release.ts keygen --out ~/.pilot/keys/
 * 生成密钥对后，把公钥（raw base64）替换到本常量。
 * 私钥仅存发布机（~/.pilot/keys/），**绝不入库、绝不分发**。
 * 未替换前 isPubkeyConfigured() 为 false，upgrade 会安全跳过自动升级（不下载）。
 */
export const RELEASE_PUBKEY_B64 = "REPLACE_WITH_RELEASE_PUBLIC_KEY_B64";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * 解析 SemVer。容忍前导 `v`（如 `v1.2.3`），忽略预发布/构建后缀（`-rc.1` / `+sha`）。
 * 无法解析返回 null（不抛异常，调用方自决）。
 */
export function parseSemver(v: string): Semver | null {
  if (typeof v !== "string") return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return { major, minor, patch };
}

/**
 * 比较两个 SemVer：a > b 返回 1，a === b 返回 0，a < b 返回 -1。
 * 任一侧无法解析时抛可读错误（版本号是升级决策的输入，静默按 0 处理会造成误升级）。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`无法解析版本号: "${a}"（期望 SemVer，如 1.2.3 或 v1.2.3）`);
  if (!pb) throw new Error(`无法解析版本号: "${b}"（期望 SemVer，如 1.2.3 或 v1.2.3）`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  return 0;
}

/** remote 是否比 local 新。任一版本号非法时抛错（同 compareSemver）。 */
export function isNewer(localVersion: string, remoteVersion: string): boolean {
  return compareSemver(remoteVersion, localVersion) > 0;
}

/** 把 tag 归一为纯版本号：`v1.2.3` → `1.2.3`（去前导 v 与首尾空白） */
export function normalizeVersion(tagName: string): string {
  return tagName.trim().replace(/^v/, "");
}

/** 发布物文件名前缀（客户端挑选资产 / 发布机打包签名，两侧共用这一个定义，避免命名漂移） */
export const RELEASE_ASSET_PREFIX = "pilot-skill-";

/**
 * 发布物 tar.gz 的规范文件名：`pilot-skill-<version>.tar.gz`（签名文件为其加 `.sig`）。
 * 发布机（`scripts/release.ts`）与客户端（`pickReleaseAssets`）都调本函数，
 * 保证「打包出的名字」与「客户端去找的名字」不会各自演化。
 */
export function releaseAssetName(version: string): string {
  return `${RELEASE_ASSET_PREFIX}${normalizeVersion(version)}.tar.gz`;
}

/**
 * 按约定资产名挑选发布物。版本号内部会先 normalize（容忍调用方直接喂 tag）。
 * 找不到的资产返回 null，**不抛异常**——缺资产是「发布不完整」，由编排层决定如何处理。
 */
export function pickReleaseAssets(
  release: { tag_name: string; assets: ReleaseAsset[] },
  version: string
): { tarball: ReleaseAsset | null; signature: ReleaseAsset | null } {
  const wanted = releaseAssetName(version);
  const assets = release.assets ?? [];
  return {
    tarball: assets.find((a) => a.name === wanted) ?? null,
    signature: assets.find((a) => a.name === `${wanted}.sig`) ?? null,
  };
}

/** 公钥是否已接线（非占位、非空、且能被解析为合法 Ed25519 raw 公钥） */
export function isPubkeyConfigured(pubkey: string = RELEASE_PUBKEY_B64): boolean {
  const trimmed = pubkey.trim();
  if (trimmed.length === 0 || trimmed === RELEASE_PUBKEY_B64) return false;
  try {
    publicKeyFromRawB64(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 发布物验签：tarball 原始字节 + base64 detached 签名 + raw base64 公钥。
 * 任何异常（非法 base64、公钥长度错、签名格式错）一律 false——红线 6 要求
 * 「验签失败拒用」，绝不能把异常逃逸成「当作通过」。
 */
export function verifyRelease(tarball: Buffer, signatureB64: string, pubkeyRawB64: string): boolean {
  try {
    // .sig 文件可能带换行/空白，先剔除；base64 体内允许换行
    const signature = (signatureB64 ?? "").replace(/\s+/g, "");
    return verifyPayload(tarball, signature, pubkeyRawB64.trim());
  } catch {
    return false;
  }
}
