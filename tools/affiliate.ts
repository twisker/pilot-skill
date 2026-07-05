import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./lib/workspace";
import { verifyPayload } from "./lib/signing";

// ---------------------------------------------------------------------------
// PILOT affiliate.ts —— go 短链生成 + 产品候选初筛（spec §10 一期，V1 不启用）
//
//   link --trip <id>       读 itinerary.json 的 booking 条目，按
//                          config/affiliate-map.<locale>.json（品类→短码前缀）
//                          生成 https://<GO_DOMAIN>/r/<code>?d=..&dt=.. 短链，
//                          写回 booking.affiliate_url。
//                          GO_DOMAIN 未配置 → exit 1（链接服务未部署）。
//
//   recommend --trip <id>  读 ~/.pilot/products/products.json（Ed25519 验签
//                          通过才使用，公钥内嵌本文件），按 intake 画像做
//                          **确定性初筛评分**（目的地硬匹配 + 人群/预算/偏好
//                          加权），stdout 输出 top1 候选：
//                          {candidate: {product, match_score, match_reasons, go_url}}
//                          match_score < 0.6 → {candidate: null}（宁缺毋滥，
//                          spec §10.4b）。go_url 为产品 go 短链（GO_DOMAIN 未
//                          配置时 null——链接服务未部署，SKILL 层应视同无候选）。
//
// 边界：语义终审与推荐语生成是 SKILL 的事（Task 23b），本工具只出候选，
// 不生成任何面向用户的文案。曝光遥测（reco_impression）也不在这里记——
// 候选产出 ≠ 曝光：SKILL 语义终审可能否决候选，只有真正向用户展示后才由
// SKILL 层调 telemetry-cli.ts 记曝光（spec §10.4b-5，SKILL.md ⑪）。
//
// 防线 1（spec §10.6）：本文件与全部客户端文件不含任何 tracking ID；
// 短码是不透明路由键，深链只在链接服务端拼装。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MATCH_THRESHOLD = 0.6;

/**
 * products.json 验签公钥（Ed25519 raw 32 字节 base64，spec §10.6 防线 2）。
 * 占位值：正式发布前由产品负责人执行
 *   npx tsx scripts/sign-products.ts keygen --out <发布机安全目录>
 * 生成密钥对后，把输出的公钥替换到这里（私钥仅存发布机，绝不入库）。
 * 测试/演练可用环境变量 PILOT_PRODUCTS_PUBKEY 覆盖。
 */
const PRODUCTS_PUBKEY_B64 = "REPLACE_WITH_RELEASE_PUBLIC_KEY_B64";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface Intake {
  trip_id: string;
  destination: string;
  dates: { start: string; end: string };
  party: { adults: number; children: number; seniors: number };
  budget_cny?: number | null;
  preferences: string[];
  locale: "zh" | "en";
}

interface Booking {
  type: "flight" | "hotel" | "car" | "restaurant" | "ticket";
  name: string;
  url?: string | null;
  affiliate_url: string | null;
  alt_recommendation: unknown;
}

interface ItineraryItem {
  name: string;
  booking?: Booking | null;
  [key: string]: unknown;
}

interface ItineraryDay {
  day: number;
  date: string;
  items: ItineraryItem[];
  [key: string]: unknown;
}

interface Itinerary {
  trip_id: string;
  days: ItineraryDay[];
  [key: string]: unknown;
}

export type PartyTag = "family" | "seniors" | "couple" | "solo" | "friends";
export type BudgetBand = "low" | "mid" | "high";

export interface Product {
  product_id: string;
  title: string;
  brief: string;
  code: string;
  destinations: string[];
  themes: string[];
  party_fit: PartyTag[];
  budget_band: BudgetBand;
  price_cny?: number | null;
  duration_days?: number | null;
}

interface ProductsFile {
  version: number;
  generated_at: string;
  products: Product[];
}

interface AffiliateMap {
  categories: Record<string, string>;
  product_prefix: string;
}

// ---------------------------------------------------------------------------
// .env / config 读取
// ---------------------------------------------------------------------------

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function readEnvVar(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = PROJECT_ROOT
): string | null {
  for (const name of names) {
    if (env[name]) return env[name] as string;
  }
  const envPath = path.join(projectRoot, ".env");
  if (existsSync(envPath)) {
    const parsed = parseDotEnv(readFileSync(envPath, "utf-8"));
    for (const name of names) {
      if (parsed[name]) return parsed[name];
    }
  }
  return null;
}

function readLocale(): "zh" | "en" {
  try {
    const config = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, "config", "pilot.json"), "utf-8")
    ) as { locale?: string };
    return config.locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

function loadAffiliateMap(locale: string): AffiliateMap {
  const mapPath = path.join(PROJECT_ROOT, "config", `affiliate-map.${locale}.json`);
  if (!existsSync(mapPath)) {
    throw new CliError(`缺少品类路由表: ${mapPath}`);
  }
  const parsed = JSON.parse(readFileSync(mapPath, "utf-8")) as Partial<AffiliateMap>;
  if (!parsed.categories || !parsed.product_prefix) {
    throw new CliError(`品类路由表格式错误: ${mapPath}（需要 categories + product_prefix）`);
  }
  return parsed as AffiliateMap;
}

/**
 * GO_DOMAIN 解析：显式 GO_DOMAIN 优先；否则按 locale 取
 * GO_DOMAIN_CN（zh）/ GO_DOMAIN_OVERSEAS（en），再兜底取另一套。
 * （双套竞速自动路由做进 SessionStart hook 之前，先静态解析。）
 */
export function resolveGoDomain(
  locale: "zh" | "en",
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = PROJECT_ROOT
): string | null {
  const preferred = locale === "zh" ? "GO_DOMAIN_CN" : "GO_DOMAIN_OVERSEAS";
  const fallback = locale === "zh" ? "GO_DOMAIN_OVERSEAS" : "GO_DOMAIN_CN";
  return readEnvVar(["GO_DOMAIN", preferred, fallback], env, projectRoot);
}

// ---------------------------------------------------------------------------
// link —— booking 条目 → go 短链
// ---------------------------------------------------------------------------

/** 确定性短码：<品类前缀>-<sha256(type|name) 前 10 hex> */
export function buildShortCode(prefix: string, bookingType: string, name: string): string {
  const digest = createHash("sha256").update(`${bookingType}|${name}`).digest("hex");
  return `${prefix}-${digest.slice(0, 10)}`;
}

export function buildGoUrl(
  domain: string,
  code: string,
  destination: string,
  date: string
): string {
  return `https://${domain}/r/${code}?d=${encodeURIComponent(destination)}&dt=${encodeURIComponent(date)}`;
}

/**
 * booking.type → 建议投放联盟网络的默认映射（spec 短码对接断链修复）。
 * 与 services/link-service/link-config.example.json 的示例分布保持一致；
 * 仅作 merge-link-config.ts 生成新条目时的默认建议，运营可在 --templates
 * 参数中按需覆盖。
 */
export const SUGGESTED_NETWORK_BY_TYPE: Record<Booking["type"], string> = {
  flight: "trip_com",
  hotel: "trip_com",
  car: "ctrip_union",
  restaurant: "klook",
  ticket: "klook",
};

export interface LinkManifestEntry {
  code: string;
  type: Booking["type"];
  name: string;
  dest: string;
  dt: string;
  suggested_network: string;
}

function runLink(tripId: string): unknown {
  const locale = readLocale();
  const domain = resolveGoDomain(locale);
  if (!domain) {
    throw new CliError(
      "链接服务未部署：请在 .env 配置 GO_DOMAIN（或 GO_DOMAIN_CN / GO_DOMAIN_OVERSEAS）。部署步骤见 services/link-service/DEPLOY.md"
    );
  }
  const map = loadAffiliateMap(locale);
  const itinerary = readJson<Itinerary>(tripId, "itinerary.json");
  const intake = readJson<Intake>(tripId, "intake.json");

  const links: { day: number; name: string; code: string; url: string }[] = [];
  const manifest: LinkManifestEntry[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const booking = item.booking;
      if (!booking || typeof booking !== "object") continue;
      const prefix = map.categories[booking.type];
      if (!prefix) continue; // 品类不在路由表 → 跳过（保持普通直链）
      const code = buildShortCode(prefix, booking.type, booking.name);
      const url = buildGoUrl(domain, code, intake.destination, day.date);
      booking.affiliate_url = url;
      links.push({ day: day.day, name: booking.name, code, url });
      manifest.push({
        code,
        type: booking.type,
        name: booking.name,
        dest: intake.destination,
        dt: day.date,
        suggested_network: SUGGESTED_NETWORK_BY_TYPE[booking.type],
      });
    }
  }

  writeJson(tripId, "itinerary.json", itinerary);
  // 短码对接断链修复：除了写回 booking.affiliate_url，同时导出 manifest 供
  // scripts/merge-link-config.ts 消费，生成/合并链接服务侧的 link-config
  // （否则短码只在客户端生成，服务端 link-config 永远追不上，/r/<code> 404）。
  writeJson(tripId, "exports/link-manifest.json", manifest);
  return { trip_id: tripId, updated: links.length, links, manifest_path: "exports/link-manifest.json" };
}

// ---------------------------------------------------------------------------
// recommend —— products.json 验签 + 确定性初筛评分
// ---------------------------------------------------------------------------

function productsDir(): string {
  const pilotHome = process.env.PILOT_HOME || path.join(homedir(), ".pilot");
  return path.join(pilotHome, "products");
}

export function loadVerifiedProducts(
  publicKeyRawB64: string = process.env.PILOT_PRODUCTS_PUBKEY || PRODUCTS_PUBKEY_B64
): ProductsFile {
  const jsonPath = path.join(productsDir(), "products.json");
  const sigPath = path.join(productsDir(), "products.json.sig");
  if (!existsSync(jsonPath) || !existsSync(sigPath)) {
    throw new CliError(
      `无产品缓存：需要 ${jsonPath} 与 ${jsonPath}.sig（由产品库分发渠道下发，签名缺一不可）`
    );
  }
  const payload = readFileSync(jsonPath);
  const signature = readFileSync(sigPath, "utf-8").trim();
  if (!verifyPayload(payload, signature, publicKeyRawB64)) {
    throw new CliError(
      "products.json 验签失败，拒绝使用该资源（可能被篡改，或公钥不匹配）。请重新获取产品库分发包；若为本地演练，用 PILOT_PRODUCTS_PUBKEY 指定演练公钥"
    );
  }
  return JSON.parse(payload.toString("utf-8")) as ProductsFile;
}

/** intake.party → 人群标签 */
export function partyTags(party: Intake["party"]): PartyTag[] {
  const tags: PartyTag[] = [];
  if (party.children > 0) tags.push("family");
  if (party.seniors > 0) tags.push("seniors");
  if (party.children === 0 && party.seniors === 0) {
    if (party.adults === 1) tags.push("solo");
    else if (party.adults === 2) tags.push("couple");
    else if (party.adults >= 3) tags.push("friends");
  }
  return tags;
}

function tripDays(intake: Intake): number {
  const ms = new Date(intake.dates.end).getTime() - new Date(intake.dates.start).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/** 人均每天预算 → 价位档（与 products.schema.json 的 budget_band 口径一致） */
export function intakeBudgetBand(intake: Intake): BudgetBand | null {
  if (intake.budget_cny === null || intake.budget_cny === undefined) return null;
  const persons = intake.party.adults + intake.party.children + intake.party.seniors;
  if (persons <= 0) return null;
  const perPersonPerDay = intake.budget_cny / persons / tripDays(intake);
  if (perPersonPerDay < 500) return "low";
  if (perPersonPerDay <= 1500) return "mid";
  return "high";
}

export interface ScoredProduct {
  product: Product;
  match_score: number;
  match_reasons: string[];
}

/**
 * 确定性初筛评分（spec §10.4b 门槛的机械部分；语义终审在 SKILL 层）：
 *   目的地硬匹配   0.5（不匹配直接 0 分出局）
 *   人群适配       +0.25
 *   预算档吻合     +0.15
 *   偏好×主题交集  +0.10
 * 总分 ∈ [0,1]；< MATCH_THRESHOLD(0.6) 不出候选。
 */
export function scoreProduct(product: Product, intake: Intake): ScoredProduct {
  const reasons: string[] = [];
  let score = 0;

  const dest = intake.destination.trim();
  const destHit = product.destinations.find(
    (d) => d.trim() && (dest.includes(d.trim()) || d.trim().includes(dest))
  );
  if (!destHit || !dest) {
    return { product, match_score: 0, match_reasons: [] };
  }
  score += 0.5;
  reasons.push(`目的地匹配：${destHit}（intake.destination=${dest}）`);

  const tags = partyTags(intake.party);
  const partyHit = tags.filter((t) => product.party_fit.includes(t));
  if (partyHit.length > 0) {
    score += 0.25;
    reasons.push(`人群适配：${partyHit.join("/")}（intake.party 推导）`);
  }

  const band = intakeBudgetBand(intake);
  if (band !== null && band === product.budget_band) {
    score += 0.15;
    reasons.push(`预算档吻合：${band}（intake.budget_cny 人均每天换算）`);
  }

  const themeHit = intake.preferences.filter((p) =>
    product.themes.some((t) => t.includes(p) || p.includes(t))
  );
  if (themeHit.length > 0) {
    score += 0.1;
    reasons.push(`偏好命中主题：${themeHit.join("/")}`);
  }

  return { product, match_score: Math.round(score * 100) / 100, match_reasons: reasons };
}

/** 全库评分取 top1；低于门槛 → null（宁缺毋滥） */
export function pickCandidate(products: Product[], intake: Intake): ScoredProduct | null {
  let best: ScoredProduct | null = null;
  for (const product of products) {
    const scored = scoreProduct(product, intake);
    if (!best || scored.match_score > best.match_score) best = scored;
  }
  if (!best || best.match_score < MATCH_THRESHOLD) return null;
  return best;
}

function runRecommend(tripId: string): unknown {
  const intake = readJson<Intake>(tripId, "intake.json");
  const products = loadVerifiedProducts();
  const candidate = pickCandidate(products.products, intake);
  if (!candidate) {
    return { candidate: null };
  }
  // 产品 go 短链：链接服务未部署（无 GO_DOMAIN）→ null，SKILL 层视同无候选
  // （没有可用链接的推荐给不出行动引导，不如不推）。
  const domain = resolveGoDomain(readLocale());
  const go_url = domain
    ? buildGoUrl(domain, candidate.product.code, intake.destination, intake.dates.start)
    : null;
  // 注意：这里不记 reco_impression —— 候选 ≠ 曝光，SKILL 语义终审通过并
  // 实际展示后才由 SKILL 调 telemetry-cli.ts track（见文件头「边界」）。
  return { candidate: { ...candidate, go_url } };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new CliError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    flags[key.slice(2)] = rest[i + 1] ?? "";
  }
  return { cmd, flags };
}

export function main(argv: string[]): unknown {
  const { cmd, flags } = parseArgs(argv);
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  switch (cmd) {
    case "link":
      return runLink(flags.trip);
    case "recommend":
      return runRecommend(flags.trip);
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 link/recommend）`);
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  }
}
