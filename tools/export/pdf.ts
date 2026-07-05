import path from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { chromium } from "playwright";
import { buildManualData } from "./lib/render";
import { renderManualHtml, escapeHtml } from "./lib/html";
import { tripDir } from "../lib/workspace";
import { track } from "../lib/telemetry";
import { reportProgress } from "../lib/progress";

// ---------------------------------------------------------------------------
// PILOT export/pdf.ts —— 穷游手册九章节 PDF 导出（三格式中优先级最高的保底格式）
//
//   run --trip <id> --format pdf   buildManualData → HTML → playwright
//                                   chromium page.pdf → exports/<trip>-路书.pdf
//
// SKILL.md ⑧ 导出命令的落地实现。数据层（buildManualData）在 lib/render.ts，
// 本文件只做 HTML→PDF 的 playwright 编排 + CLI 参数解析。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

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

export interface RunPdfResult {
  path: string;
  bytes: number;
}

export async function runPdf(tripId: string): Promise<RunPdfResult> {
  reportProgress(tripId, { stage: "export", current: 0, total: 1, message: "开始导出 PDF" });

  const data = buildManualData(tripId);
  const html = renderManualHtml(data);

  const outDir = path.join(tripDir(tripId), "exports");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${tripId}-路书.pdf`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px;width:100%;text-align:center;color:#666;">${escapeHtml(
        data.cover.title
      )}</div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>`,
      margin: { top: "20mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await browser.close();
  }

  const bytes = statSync(outPath).size;
  reportProgress(tripId, { stage: "export", current: 1, total: 1, message: `PDF 导出完成: ${outPath}` });
  return { path: outPath, bytes };
}

export async function main(argv: string[]): Promise<unknown> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd !== "run") {
    throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 run）`);
  }
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const format = flags.format ?? "pdf";
  if (format !== "pdf") {
    throw new CliError(`不支持的 --format: ${format}（本工具仅支持 pdf，excel/word 见各自导出工具）`);
  }
  const result = await runPdf(flags.trip);
  track("export", { format: "pdf" });
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    });
}
