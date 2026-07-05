import { track, flush } from "./lib/telemetry";

// ---------------------------------------------------------------------------
// PILOT telemetry-cli.ts —— 遥测薄 CLI 入口（spec §10.4a）
//
// SKILL 层只能跑命令、不能 import 库，本文件把 lib/telemetry 的 track/flush
// 暴露为命令行：
//
//   npx tsx tools/telemetry-cli.ts track <event> [--props '<json>']
//   npx tsx tools/telemetry-cli.ts flush
//
// track 输出 {"tracked":true|false,"event":"<名>"}：
//   - tracked=false 含义为「遥测关闭 / 事件不在白名单」，属正常 no-op，exit 0
//   - --props 不是合法 JSON 对象 → exit 1（调用方拼错了命令，应该被发现）
// 遥测本身永不打断主流程：track/flush 内部不抛异常。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

function parseProps(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`--props 不是合法 JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--props 必须是 JSON 对象（如 '{\"product_id\":\"pd-x\"}'）");
  }
  return parsed as Record<string, unknown>;
}

export async function main(argv: string[]): Promise<unknown> {
  const [cmd, ...rest] = argv;
  if (cmd === "track") {
    const [event, ...flagArgs] = rest;
    if (!event || event.startsWith("--")) throw new CliError("用法: track <event> [--props '<json>']");
    const propsIdx = flagArgs.indexOf("--props");
    const props = parseProps(propsIdx === -1 ? undefined : flagArgs[propsIdx + 1]);
    return { tracked: track(event, props), event };
  }
  if (cmd === "flush") {
    return flush();
  }
  throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 track/flush）`);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    });
}
