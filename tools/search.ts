import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { readJson, writeJson, tripDir } from "./lib/workspace";

// ---------------------------------------------------------------------------
// PILOT search.ts —— 搜索计划生成 + 结果登记 + 候选挑选
//
// 纯本地工具，不发任何网络请求。真正的 WebSearch/WebFetch 由 Skill 指挥
// Claude 完成后落盘，本工具只负责：
//   plan      读 intake.json，按 config/pilot.json 的 sources 路由表生成
//             每源查询词，写 search-plan.json
//   register  校验 Skill 落盘的 serp 文件（ajv 入口边界），规范化去重后
//             并入 raw/serp-<source>.json，回写 search-plan 状态
//   pick      跨源合并，按类别配额 + 标题相关度粗排选出候选清单 raw/pick.json
// ---------------------------------------------------------------------------

const CATEGORIES = ["travelogue", "community", "video", "photo"] as const;
type Category = (typeof CATEGORIES)[number];

interface Intake {
  trip_id: string;
  destination: string;
  dates: { start: string; end: string };
  party: { adults: number; children: number; seniors: number };
  budget_cny: number | null;
  transport: "self-drive" | "public" | "mixed";
  preferences: string[];
  origin_city: string;
  locale: "zh" | "en";
}

interface QueryTemplates {
  category_suffixes: Record<Category, string[]>;
  transport_keywords: Record<Intake["transport"], string>;
}

interface Config {
  topN: number;
  keepN: number;
  maxFrames: number;
  locale: string;
  sources: Record<string, Partial<Record<Category, string[]>>>;
  query_templates: QueryTemplates;
  pick_quota?: Partial<Record<Category, number>>;
  scrape_domains?: string[];
  media_domains?: Record<string, string[]>;
  preferred_domains?: Record<string, number>;
  map: { tile_url: string | null };
}

interface SearchPlanSource {
  name: string;
  category: Category;
  method: "websearch" | "webfetch" | "scrape";
  queries: string[];
  status: "pending" | "done" | "partial" | "failed";
  result_count: number;
}

interface SearchPlan {
  trip_id: string;
  query_intent: string;
  sources: SearchPlanSource[];
  coverage_note: string | null;
}

interface SerpEntry {
  title: string;
  url: string;
  snippet: string;
}

type PickStatus = "pending" | "fetched" | "fetch_failed" | "scraped" | "failed";

interface PickEntry {
  url: string;
  source: string;
  media_type_guess: string;
  method: "webfetch" | "scrape";
  status: PickStatus;
}

export class CliError extends Error {}

// ---------------------------------------------------------------------------
// 共享小工具
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return process.env.PILOT_CONFIG || path.resolve(__dirname, "../config/pilot.json");
}
const SCHEMA_DIR = path.resolve(__dirname, "../shared/schema");

const REQUIRED_CATEGORY_SUFFIXES: Category[] = ["travelogue", "community", "video", "photo"];
const REQUIRED_TRANSPORT_KEYWORDS: Intake["transport"][] = ["self-drive", "public", "mixed"];

function assertQueryTemplates(config: Config): void {
  const qt = config.query_templates;
  if (!qt || !qt.category_suffixes || !qt.transport_keywords) {
    throw new CliError(
      "config 缺少 query_templates 字段（category_suffixes/transport_keywords）：这是冻结契约的一部分，不做静默 fallback",
    );
  }
  for (const category of REQUIRED_CATEGORY_SUFFIXES) {
    if (!Array.isArray(qt.category_suffixes[category])) {
      throw new CliError(`config.query_templates.category_suffixes 缺少类别 "${category}"`);
    }
  }
  for (const transport of REQUIRED_TRANSPORT_KEYWORDS) {
    if (typeof qt.transport_keywords[transport] !== "string") {
      throw new CliError(`config.query_templates.transport_keywords 缺少 transport "${transport}"`);
    }
  }
}

export function loadConfig(): Config {
  const config = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Config;
  assertQueryTemplates(config);
  return config;
}

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, name), "utf-8"));
}

const ajv = new Ajv({ strict: false, allErrors: true });
let searchPlanValidator: ValidateFunction | null = null;
function validateSearchPlan(plan: SearchPlan): void {
  if (!searchPlanValidator) {
    searchPlanValidator = ajv.compile(loadSchema("search-plan.schema.json"));
  }
  if (!searchPlanValidator(plan)) {
    const msg = ajv.errorsText(searchPlanValidator.errors, { separator: "; " });
    throw new CliError(`search-plan 未通过 schema 校验: ${msg}`);
  }
}

export function computeDays(dates: { start: string; end: string }): number {
  const start = new Date(`${dates.start}T00:00:00`);
  const end = new Date(`${dates.end}T00:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

export function buildQueries(
  sourceName: string,
  category: Category,
  intake: Intake,
  config: Config,
): string[] {
  const days = computeDays(intake.dates);
  const prefs = intake.preferences.join(" ");
  const base = [intake.destination, `${days}天`, prefs].filter(Boolean).join(" ");
  const suffixes = [...config.query_templates.category_suffixes[category]];
  const transportKeyword = config.query_templates.transport_keywords[intake.transport];
  if (transportKeyword) suffixes.push(transportKeyword);
  return suffixes.map((suf) => `${base} ${suf} ${sourceName}`.replace(/\s+/g, " ").trim());
}

/**
 * 归一化 URL：host 小写、去 utm_* 查询参数、去 fragment。
 * 剩余查询参数按 key 排序以得到确定性的规范形式。
 * 抛出异常表示 URL 不合法。
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  const params = new URLSearchParams(u.search);
  for (const key of [...params.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) params.delete(key);
  }
  const sortedEntries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sorted = new URLSearchParams(sortedEntries);
  const qs = sorted.toString();
  u.search = qs ? `?${qs}` : "";
  return u.toString();
}

function guessMediaType(url: string, config: Config): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [type, domains] of Object.entries(config.media_domains ?? {})) {
      if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return type;
    }
  } catch {
    // fall through to default
  }
  return "text";
}

function guessMethod(url: string, config: Config): "webfetch" | "scrape" {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const scrapeDomains = config.scrape_domains ?? [];
    if (scrapeDomains.some((d) => host === d || host.endsWith(`.${d}`))) return "scrape";
  } catch {
    // unparsable URL: default to webfetch, scrape.ts will retry on fetch_failed
  }
  return "webfetch";
}

function relevanceScore(title: string, terms: string[]): number {
  return terms.reduce((score, term) => (term && title.includes(term) ? score + 1 : score), 0);
}

/**
 * 配额倾斜（Task 7.5）：命中 config.preferred_domains 的 URL 相关度得分乘以
 * 该域名配置的倍率；未命中或未配置 preferred_domains 时倍率恒为 1（不影响
 * 现有排序）。域名匹配同 scrape_domains/media_domains 的规则：精确 host 或
 * 其子域名。
 */
export function domainWeight(url: string, preferredDomains: Record<string, number> | undefined): number {
  if (!preferredDomains) return 1;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [domain, weight] of Object.entries(preferredDomains)) {
      const d = domain.toLowerCase();
      if (host === d || host.endsWith(`.${d}`)) return weight;
    }
  } catch {
    // 非法 URL：不加权，交由上层其他校验处理
  }
  return 1;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export function buildSearchPlan(tripId: string, intake: Intake, config: Config): SearchPlan {
  const localeSources = config.sources[intake.locale] ?? {};
  const sources: SearchPlanSource[] = [];
  for (const category of CATEGORIES) {
    const names = localeSources[category] ?? [];
    for (const name of names) {
      sources.push({
        name,
        category,
        method: "websearch",
        queries: buildQueries(name, category, intake, config),
        status: "pending",
        result_count: 0,
      });
    }
  }
  const days = computeDays(intake.dates);
  const prefs = intake.preferences.join("/");
  const query_intent = `${intake.destination} ${days}天 ${intake.transport}${prefs ? ` ${prefs}` : ""}`;
  return { trip_id: tripId, query_intent, sources, coverage_note: null };
}

export function runPlan(tripId: string): SearchPlan {
  const intake = readJson<Intake>(tripId, "intake.json");
  const config = loadConfig();
  const plan = buildSearchPlan(tripId, intake, config);
  validateSearchPlan(plan);
  writeJson(tripId, "search-plan.json", plan);
  return plan;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

const serpArraySchema = {
  type: "array",
  items: {
    type: "object",
    required: ["title", "url", "snippet"],
    properties: {
      title: { type: "string" },
      url: { type: "string" },
      snippet: { type: "string" },
    },
  },
};
const serpArrayValidator = ajv.compile(serpArraySchema);

function indexFromInstancePath(instancePath: string): number | null {
  const m = instancePath.match(/^\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export interface RegisterResult {
  source: string;
  added: number;
  total: number;
}

export function runRegister(tripId: string, source: string, file: string): RegisterResult {
  const raw = readFileSync(path.resolve(file), "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(`serp 文件不是合法 JSON: ${file}`);
  }

  if (!serpArrayValidator(data)) {
    const badIndexes = new Set<number>();
    for (const err of serpArrayValidator.errors ?? []) {
      const idx = indexFromInstancePath(err.instancePath);
      if (idx !== null) badIndexes.add(idx);
    }
    const indexes = [...badIndexes].sort((a, b) => a - b);
    throw new CliError(
      `serp 文件校验失败，非法条目下标：${indexes.length ? indexes.join(",") : "未知"}`,
    );
  }

  const entries = data as SerpEntry[];
  const normalized: SerpEntry[] = [];
  const badUrlIndexes: number[] = [];
  entries.forEach((entry, idx) => {
    try {
      normalized.push({ title: entry.title, url: normalizeUrl(entry.url), snippet: entry.snippet });
    } catch {
      badUrlIndexes.push(idx);
    }
  });
  if (badUrlIndexes.length) {
    throw new CliError(`serp 文件包含非法 URL，条目下标：${badUrlIndexes.join(",")}`);
  }

  const plan = readJson<SearchPlan>(tripId, "search-plan.json");
  const sourceEntry = plan.sources.find((s) => s.name === source);
  if (!sourceEntry) {
    throw new CliError(`未知 source: "${source}"（不在 search-plan.sources 中，先跑 plan）`);
  }

  const relPath = `raw/serp-${source}.json`;
  let existing: SerpEntry[] = [];
  try {
    existing = readJson<SerpEntry[]>(tripId, relPath);
  } catch {
    existing = [];
  }

  const seen = new Set(existing.map((e) => e.url));
  let added = 0;
  for (const entry of normalized) {
    if (!seen.has(entry.url)) {
      seen.add(entry.url);
      existing.push(entry);
      added++;
    }
  }
  writeJson(tripId, relPath, existing);

  sourceEntry.status = "done";
  sourceEntry.result_count = existing.length;
  validateSearchPlan(plan);
  writeJson(tripId, "search-plan.json", plan);

  return { source, added, total: existing.length };
}

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

export interface PickResult {
  picked: number;
  total: number;
}

export function runPick(tripId: string, top?: number): PickResult {
  const config = loadConfig();
  const topN = top ?? config.topN;
  const plan = readJson<SearchPlan>(tripId, "search-plan.json");
  const intake = readJson<Intake>(tripId, "intake.json");
  const dir = tripDir(tripId);
  const rawDir = path.join(dir, "raw");

  interface Candidate {
    url: string;
    source: string;
    category: Category;
    title: string;
  }

  const candidates: Candidate[] = [];
  for (const s of plan.sources) {
    const file = path.join(rawDir, `serp-${s.name}.json`);
    if (!existsSync(file)) continue;
    const entries = JSON.parse(readFileSync(file, "utf-8")) as SerpEntry[];
    for (const e of entries) {
      candidates.push({ url: e.url, source: s.name, category: s.category, title: e.title });
    }
  }

  const terms = [intake.destination, ...intake.preferences].filter(Boolean);
  const candidateScore = (c: Candidate): number =>
    relevanceScore(c.title, terms) * domainWeight(c.url, config.preferred_domains);
  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));

  const quotaConfig: Partial<Record<Category, number>> = config.pick_quota ?? {
    travelogue: 0.5,
    community: 0.25,
    video: 0.15,
    photo: 0.1,
  };

  const pickedCandidates: Candidate[] = [];
  for (const category of CATEGORIES) {
    const ratio = quotaConfig[category] ?? 0;
    const quota = Math.max(0, Math.round(topN * ratio));
    const pool = candidates.filter((c) => c.category === category);
    pickedCandidates.push(...pool.slice(0, quota));
  }
  const limited = pickedCandidates.slice(0, topN);

  const pickedEntries: PickEntry[] = limited.map((c) => ({
    url: c.url,
    source: c.source,
    media_type_guess: guessMediaType(c.url, config),
    method: guessMethod(c.url, config),
    status: "pending",
  }));

  writeJson(tripId, "raw/pick.json", pickedEntries);

  return { picked: pickedEntries.length, total: pickedEntries.length };
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
  const tripId = flags.trip;

  switch (cmd) {
    case "plan":
      return runPlan(tripId);
    case "register":
      if (!flags.source || !flags.file) {
        throw new CliError("register 需要 --source 与 --file");
      }
      return runRegister(tripId, flags.source, flags.file);
    case "pick":
      return runPick(tripId, flags.top ? Number(flags.top) : undefined);
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}`);
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
