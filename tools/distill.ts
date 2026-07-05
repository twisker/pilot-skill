import { readFileSync, readdirSync, existsSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { tripDir, writeJson, atomicWriteFileSync } from "./lib/workspace";
import {
  type Travelogue,
  poiSimilarity,
  DUPLICATE_THRESHOLD,
  scoreDeterministic,
  dedupeRankScore,
  indexTotal,
} from "./lib/fingerprint";

// ---------------------------------------------------------------------------
// PILOT distill.ts —— travelogue 去重 + 确定性评分 + 索引
//
//   validate  ajv 校验 travelogues/*.json，非法文件改名加 .invalid 后缀（不删除）
//   dedupe    路线指纹相似度 ≥0.75 判重，保 quality.total（或 deterministic
//             均值）高者，被去除者移入 travelogues/dup/
//   score     计算 quality.deterministic 四项，写回各文件
//   index     取 total 排序前 keepN 条，写 travelogues/index.json
//             （含 id/brief/tags/total/url/days_count —— Skill 唯一读取的摘要
//             文件；days_count = route.days.length，供 Skill ⑤ 判断蓝本资格）
//
// 具体算法（Jaccard/LCS/四项评分公式）都在 lib/fingerprint.ts，本文件只做
// CLI 参数解析 + 文件系统 I/O 编排。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

function getConfigPath(): string {
  return process.env.PILOT_CONFIG || path.resolve(__dirname, "../config/pilot.json");
}

interface DistillConfig {
  keepN: number;
}

export function loadConfig(): DistillConfig {
  const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
  if (typeof raw.keepN !== "number") {
    throw new CliError("config 缺少 keepN 字段（冻结契约的一部分，不做静默 fallback）");
  }
  return { keepN: raw.keepN };
}

const SCHEMA_PATH = path.resolve(__dirname, "../shared/schema/travelogue.schema.json");
const ajv = new Ajv({ strict: false, allErrors: true });
let travelogueValidator: ValidateFunction | null = null;
function getTravelogueValidator(): ValidateFunction {
  if (!travelogueValidator) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    travelogueValidator = ajv.compile(schema);
  }
  return travelogueValidator;
}

function travelogueDir(tripId: string): string {
  return path.join(tripDir(tripId), "travelogues");
}

/** travelogues/ 目录下待处理的 *.json 文件名（排除 .invalid、index.json、dup/ 子目录） */
function listTravelogueFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "index.json")
    .map((e) => e.name)
    .sort();
}

function readTravelogue(filePath: string): Travelogue {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Travelogue;
}

// workspace.ts 的 atomicWriteFileSync 接受任意绝对路径，dedupe/score 按已知的
// 绝对文件路径直接写（不经过 <tripId>/<relPath> 拼接），直接复用即可。
function writeTravelogueFile(filePath: string, t: Travelogue): void {
  atomicWriteFileSync(filePath, JSON.stringify(t, null, 2));
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface ValidateResult {
  total: number;
  valid: number;
  invalid: string[];
}

export function runValidate(tripId: string): ValidateResult {
  const dir = travelogueDir(tripId);
  const files = listTravelogueFiles(dir);
  const validate = getTravelogueValidator();
  const invalid: string[] = [];
  let valid = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    let ok = false;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      ok = Boolean(validate(data));
    } catch {
      ok = false;
    }
    if (ok) {
      valid++;
    } else {
      renameSync(filePath, `${filePath}.invalid`);
      invalid.push(file);
    }
  }

  return { total: files.length, valid, invalid };
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

export interface DedupeRemoval {
  removed: string;
  keptAs: string;
  similarity: number;
}

export interface DedupeResult {
  total: number;
  kept: number;
  removed: DedupeRemoval[];
}

export function runDedupe(tripId: string): DedupeResult {
  const dir = travelogueDir(tripId);
  const files = listTravelogueFiles(dir);
  const dupDir = path.join(dir, "dup");

  interface Kept {
    file: string;
    t: Travelogue;
  }
  const kept: Kept[] = [];
  const removed: DedupeRemoval[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const t = readTravelogue(filePath);

    let dupOf: Kept | null = null;
    let bestSim = 0;
    for (const k of kept) {
      const sim = poiSimilarity(t, k.t);
      if (sim >= DUPLICATE_THRESHOLD && sim > bestSim) {
        dupOf = k;
        bestSim = sim;
      }
    }

    if (!dupOf) {
      kept.push({ file, t });
      continue;
    }

    // 判重：保 quality.total（缺失用 deterministic 均值）高者
    const candidateScore = dedupeRankScore(t);
    const keptScore = dedupeRankScore(dupOf.t);

    if (candidateScore > keptScore) {
      // 新条目胜出：把之前保留的那条移到 dup/，新条目替换其位置
      mkdirSync(dupDir, { recursive: true });
      renameSync(path.join(dir, dupOf.file), path.join(dupDir, dupOf.file));
      removed.push({ removed: dupOf.file, keptAs: file, similarity: bestSim });
      const idx = kept.indexOf(dupOf);
      kept[idx] = { file, t };
    } else {
      mkdirSync(dupDir, { recursive: true });
      renameSync(filePath, path.join(dupDir, file));
      removed.push({ removed: file, keptAs: dupOf.file, similarity: bestSim });
    }
  }

  return { total: files.length, kept: kept.length, removed };
}

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

export interface ScoreResult {
  total: number;
  scored: string[];
}

export function runScore(tripId: string): ScoreResult {
  const dir = travelogueDir(tripId);
  const files = listTravelogueFiles(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const t = readTravelogue(filePath);
    t.quality.deterministic = scoreDeterministic(t);
    writeTravelogueFile(filePath, t);
  }

  return { total: files.length, scored: files };
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

export interface IndexEntry {
  id: string;
  brief: string;
  tags: string[];
  total: number;
  url: string;
  days_count: number;
}

export interface IndexResult {
  candidates: number;
  kept: number;
}

export function runIndex(tripId: string, keepOverride?: number): IndexResult {
  const dir = travelogueDir(tripId);
  const files = listTravelogueFiles(dir);
  const keepN = keepOverride ?? loadConfig().keepN;

  const scored = files.map((file) => {
    const t = readTravelogue(path.join(dir, file));
    return { t, total: indexTotal(t) };
  });
  scored.sort((a, b) => b.total - a.total);

  const top = scored.slice(0, Math.max(0, keepN));
  const index: IndexEntry[] = top.map(({ t, total }) => ({
    id: t.id,
    brief: t.summary.brief,
    tags: t.summary.tags,
    total,
    url: t.meta.source.url,
    days_count: t.route.days.length,
  }));

  writeJson(tripId, "travelogues/index.json", index);

  return { candidates: files.length, kept: index.length };
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
    case "validate":
      return runValidate(tripId);
    case "dedupe":
      return runDedupe(tripId);
    case "score":
      return runScore(tripId);
    case "index": {
      if (flags.keep !== undefined) {
        const keep = Number(flags.keep);
        if (!Number.isInteger(keep) || keep <= 0) {
          throw new CliError("--keep 必须是正整数");
        }
        return runIndex(tripId, keep);
      }
      return runIndex(tripId, undefined);
    }
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 validate/dedupe/score/index）`);
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
