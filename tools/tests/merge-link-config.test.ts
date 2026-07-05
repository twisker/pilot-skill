import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readManifest,
  readLinkConfig,
  mergeLinkConfig,
  runMergeLinkConfigCli as main,
  MergeLinkConfigError as CliError,
  type LinkConfig,
  type LinkManifestEntry,
} from "../lib/merge-link-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pilot-merge-link-config-"));
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
});

const manifest: LinkManifestEntry[] = [
  {
    code: "fl-aaaa000001",
    type: "flight",
    name: "上海-乌鲁木齐航班",
    dest: "新疆",
    dt: "2026-07-20",
    suggested_network: "trip_com",
  },
  {
    code: "ht-bbbb000002",
    type: "hotel",
    name: "乌鲁木齐希尔顿",
    dest: "新疆",
    dt: "2026-07-20",
    suggested_network: "trip_com",
  },
];

describe("readManifest", () => {
  it("字段齐全的条目通过，脏行整条丢弃", () => {
    const p = path.join(dir, "manifest.json");
    writeFileSync(
      p,
      JSON.stringify([
        manifest[0],
        { code: "bad", type: "hotel" }, // 缺字段
        "not-an-object",
      ])
    );
    expect(readManifest(p)).toEqual([manifest[0]]);
  });

  it("manifest 不存在 → CliError", () => {
    expect(() => readManifest(path.join(dir, "nope.json"))).toThrow(CliError);
  });

  it("manifest 不是数组 → CliError", () => {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ not: "array" }));
    expect(() => readManifest(p)).toThrow(CliError);
  });
});

describe("readLinkConfig", () => {
  it("文件不存在 → 空 config", () => {
    expect(readLinkConfig(path.join(dir, "nope.json"))).toEqual({ codes: {} });
  });

  it("正常读取", () => {
    const p = path.join(dir, "link-config.json");
    const config: LinkConfig = {
      codes: { "pd-demo0001": { network: "klook", template: "https://klook.example/?aid={AID}" } },
    };
    writeFileSync(p, JSON.stringify(config));
    expect(readLinkConfig(p)).toEqual(config);
  });
});

describe("mergeLinkConfig", () => {
  it("新 code 用 --templates 参数解析", () => {
    const result = mergeLinkConfig(
      { codes: {} },
      manifest,
      { templates: { flight: "https://trip.example/flights?aid={AID}&d={d}&dt={dt}", hotel: "https://trip.example/hotels?aid={AID}&d={d}&dt={dt}" } }
    );
    expect(result.added).toEqual(["fl-aaaa000001", "ht-bbbb000002"]);
    expect(result.skipped).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.config.codes["fl-aaaa000001"]).toEqual({
      network: "trip_com",
      template: "https://trip.example/flights?aid={AID}&d={d}&dt={dt}",
    });
  });

  it("无 --templates 时复制同网络已有条目的 template", () => {
    const existing: LinkConfig = {
      codes: {
        "fl-existing": { network: "trip_com", template: "https://trip.example/existing?aid={AID}" },
      },
    };
    const result = mergeLinkConfig(existing, manifest);
    expect(result.added).toEqual(["fl-aaaa000001", "ht-bbbb000002"]);
    expect(result.config.codes["fl-aaaa000001"].template).toBe("https://trip.example/existing?aid={AID}");
    expect(result.config.codes["ht-bbbb000002"].template).toBe("https://trip.example/existing?aid={AID}");
  });

  it("同 code 已存在 → 跳过，不覆盖", () => {
    const existing: LinkConfig = {
      codes: {
        "fl-aaaa000001": { network: "klook", template: "https://already-configured.example/" },
      },
    };
    const result = mergeLinkConfig(existing, manifest, {
      templates: { hotel: "https://trip.example/hotels?aid={AID}" },
    });
    expect(result.skipped).toEqual(["fl-aaaa000001"]);
    expect(result.added).toEqual(["ht-bbbb000002"]);
    // 未被覆盖
    expect(result.config.codes["fl-aaaa000001"]).toEqual({
      network: "klook",
      template: "https://already-configured.example/",
    });
  });

  it("既无 --templates 又无同网络现有条目 → unresolved，不写入", () => {
    const result = mergeLinkConfig({ codes: {} }, manifest);
    expect(result.added).toEqual([]);
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved[0].code).toBe("fl-aaaa000001");
    expect(result.config.codes["fl-aaaa000001"]).toBeUndefined();
  });

  it("幂等：对已合并结果再合并一次不产生变化", () => {
    const first = mergeLinkConfig(
      { codes: {} },
      manifest,
      { templates: { flight: "https://trip.example/flights?aid={AID}", hotel: "https://trip.example/hotels?aid={AID}" } }
    );
    const second = mergeLinkConfig(first.config, manifest, {
      templates: { flight: "https://trip.example/flights?aid={AID}", hotel: "https://trip.example/hotels?aid={AID}" },
    });
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual(["fl-aaaa000001", "ht-bbbb000002"]);
    expect(second.config).toEqual(first.config);
  });
});

describe("main (CLI)", () => {
  it("merge 子命令端到端：写出合并后的 link-config", () => {
    const manifestPath = path.join(dir, "link-manifest.json");
    const configPath = path.join(dir, "link-config.json");
    const outPath = path.join(dir, "link-config.out.json");
    const templatesPath = path.join(dir, "templates.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(configPath, JSON.stringify({ codes: {} }));
    writeFileSync(
      templatesPath,
      JSON.stringify({
        flight: "https://trip.example/flights?aid={AID}&d={d}&dt={dt}",
        hotel: "https://trip.example/hotels?aid={AID}&d={d}&dt={dt}",
      })
    );

    const result = main([
      "merge",
      "--manifest",
      manifestPath,
      "--config",
      configPath,
      "--out",
      outPath,
      "--templates",
      templatesPath,
    ]) as { added: string[]; skipped: string[]; unresolved: unknown[] };

    expect(result.added).toEqual(["fl-aaaa000001", "ht-bbbb000002"]);
    const written = JSON.parse(readFileSync(outPath, "utf-8")) as LinkConfig;
    expect(Object.keys(written.codes)).toEqual(["fl-aaaa000001", "ht-bbbb000002"]);
  });

  it("缺必填参数 → CliError", () => {
    expect(() => main(["merge", "--manifest", "x"])).toThrow(CliError);
  });

  it("未知子命令 → CliError", () => {
    expect(() => main(["nope"])).toThrow(CliError);
  });
});
