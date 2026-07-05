import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// PILOT link-config 合并逻辑（短码对接断链修复，spec §10 一期）
//
// 背景：`tools/affiliate.ts link` 在客户端生成短码并写回
// booking.affiliate_url，但链接服务端的 link-config（短码 → {network,
// template}）需要运营手动维护，两边脱节会导致新短码在服务端查不到条目，
// `/r/<code>` 一律 404（用户点开推荐链接直接失败）。
//
// 本模块读取 `tools/affiliate.ts link` 产出的 `<trip>/exports/
// link-manifest.json`（每条 {code, type, name, dest, dt, suggested_network}），
// 与现有 link-config.json 合并：
//   - manifest 里 code 已存在于 link-config → 跳过（不覆盖已上线条目，
//     幂等：重复合并同一份 manifest 不产生变化）
//   - code 不存在 → 需要一个 template 字符串（含 {AID}/{d}/{dt} 占位符）：
//       1) 优先用 --templates <path> 指定的 JSON 文件（按 booking type 查表）
//       2) 否则复制 link-config 中任意一条 network 与 suggested_network
//          相同的现有条目的 template（"同类条目" = 同一联盟网络）
//       3) 都找不到 → 该条目进 unresolved，不写入输出，需人工补 --templates
//          或先在 link-config 里手工加一条同网络的条目再重跑
//
// CLI 入口在 scripts/merge-link-config.ts（薄封装，只做 stdout/stderr/exit
// code）；核心逻辑放这里是为了能被 tools/tests 直接单测（tools/tsconfig.json
// 的 rootDir 推导不允许 tools/ 内的文件 import scripts/ 目录下的文件）。
// 运营完整流程见 services/link-service/DEPLOY.md 第五步。
// ---------------------------------------------------------------------------

export class MergeLinkConfigError extends Error {}

export interface LinkConfigEntry {
  network: string;
  template: string;
  product_id?: string;
}

export interface LinkConfig {
  codes: Record<string, LinkConfigEntry>;
}

export interface LinkManifestEntry {
  code: string;
  type: string;
  name: string;
  dest: string;
  dt: string;
  suggested_network: string;
}

export interface MergeResult {
  config: LinkConfig;
  added: string[];
  skipped: string[];
  unresolved: { code: string; type: string; suggested_network: string; reason: string }[];
}

/** manifest 校验：字段齐全才纳入合并（脏数据整条丢弃，不让坏行污染 link-config） */
export function readManifest(filePath: string): LinkManifestEntry[] {
  if (!existsSync(filePath)) {
    throw new MergeLinkConfigError(
      `manifest 不存在: ${filePath}（先跑 tools/affiliate.ts link --trip <id>）`
    );
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new MergeLinkConfigError(`manifest 格式错误: ${filePath}（应为数组）`);
  }
  const entries: LinkManifestEntry[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.code === "string" &&
      typeof item.type === "string" &&
      typeof item.name === "string" &&
      typeof item.dest === "string" &&
      typeof item.dt === "string" &&
      typeof item.suggested_network === "string"
    ) {
      entries.push(item as LinkManifestEntry);
    }
  }
  return entries;
}

export function readLinkConfig(filePath: string): LinkConfig {
  if (!existsSync(filePath)) {
    return { codes: {} };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<LinkConfig>;
  return { codes: parsed.codes && typeof parsed.codes === "object" ? parsed.codes : {} };
}

/** 在现有 config 中找第一条 network 相同的条目，复制其 template（"同类条目"） */
function findTemplateBySameNetwork(config: LinkConfig, network: string): string | null {
  for (const entry of Object.values(config.codes)) {
    if (entry.network === network) return entry.template;
  }
  return null;
}

/**
 * 合并 manifest 到 config：已存在的 code 跳过（幂等 + 不覆盖冲突），
 * 新 code 按「--templates 参数 > 同网络已有条目复制」解析 template，
 * 都无法解析则进 unresolved（不写入输出，避免半成品 template 进生产配置）。
 */
export function mergeLinkConfig(
  config: LinkConfig,
  manifest: LinkManifestEntry[],
  opts: { templates?: Record<string, string> } = {}
): MergeResult {
  const merged: LinkConfig = { codes: { ...config.codes } };
  const added: string[] = [];
  const skipped: string[] = [];
  const unresolved: MergeResult["unresolved"] = [];

  for (const entry of manifest) {
    if (merged.codes[entry.code]) {
      skipped.push(entry.code);
      continue;
    }
    const templateFromParam = opts.templates?.[entry.type];
    const template = templateFromParam ?? findTemplateBySameNetwork(config, entry.suggested_network);
    if (!template) {
      unresolved.push({
        code: entry.code,
        type: entry.type,
        suggested_network: entry.suggested_network,
        reason: `无 --templates[${entry.type}]，link-config 中也无 network=${entry.suggested_network} 的现有条目可复制`,
      });
      continue;
    }
    merged.codes[entry.code] = { network: entry.suggested_network, template };
    added.push(entry.code);
  }

  return { config: merged, added, skipped, unresolved };
}

// ---------------------------------------------------------------------------
// CLI（供 scripts/merge-link-config.ts 调用）
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new MergeLinkConfigError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    flags[key.slice(2)] = rest[i + 1] ?? "";
  }
  return { cmd, flags };
}

export function runMergeLinkConfigCli(argv: string[]): unknown {
  const { cmd, flags } = parseArgs(argv);
  if (cmd !== "merge") {
    throw new MergeLinkConfigError(`未知子命令: ${cmd ?? "(空)"}（仅支持 merge）`);
  }
  if (!flags.manifest || !flags.config || !flags.out) {
    throw new MergeLinkConfigError("merge 需要 --manifest <path> --config <path> --out <path>");
  }
  const templates = flags.templates
    ? (JSON.parse(readFileSync(flags.templates, "utf-8")) as Record<string, string>)
    : undefined;

  const manifest = readManifest(flags.manifest);
  const config = readLinkConfig(flags.config);
  const result = mergeLinkConfig(config, manifest, { templates });

  writeFileSync(path.resolve(flags.out), `${JSON.stringify(result.config, null, 2)}\n`);
  return {
    out: flags.out,
    added: result.added,
    skipped: result.skipped,
    unresolved: result.unresolved,
  };
}
