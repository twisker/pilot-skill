import { describe, it, expect } from "vitest";
import {
  generateSigningKeypair,
  publicKeyFromRawB64,
  signPayload,
  verifyPayload,
} from "../lib/signing";

// ---------------------------------------------------------------------------
// lib/signing.ts —— Ed25519 签名/验签（分发物完整性校验）
//
// 2026-09-24：原覆盖本模块的测试随去商业化一并归档 legacy/，
// 本文件补回独立覆盖。该模块是 v5.0 红线 6「升级通道完整性」的唯一实现，
// 自升级必须先验签再替换，故覆盖不可缺。
// ---------------------------------------------------------------------------

describe("generateSigningKeypair", () => {
  it("产出 PKCS8 PEM 私钥与 raw 32 字节 base64 公钥", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(Buffer.from(publicKeyRawB64, "base64")).toHaveLength(32);
  });

  it("每次生成的密钥对不同", () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    expect(a.publicKeyRawB64).not.toBe(b.publicKeyRawB64);
  });
});

describe("publicKeyFromRawB64", () => {
  it("长度不是 32 字节时抛错", () => {
    expect(() => publicKeyFromRawB64(Buffer.alloc(16).toString("base64"))).toThrow(/32 字节/);
    expect(() => publicKeyFromRawB64("")).toThrow(/32 字节/);
  });
});

describe("signPayload / verifyPayload 往返", () => {
  it("对字符串签名后能验签通过", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    const sig = signPayload("pilot-skill-1.0.9.tar.gz", privateKeyPem);
    expect(verifyPayload("pilot-skill-1.0.9.tar.gz", sig, publicKeyRawB64)).toBe(true);
  });

  it("对 Buffer 签名后能验签通过（发布物按原始字节签名）", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
    const sig = signPayload(payload, privateKeyPem);
    expect(verifyPayload(payload, sig, publicKeyRawB64)).toBe(true);
  });

  it("中文与多字节内容往返一致（VERSION / manifest 场景）", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    const payload = "PILOT 排路客 v5.0 —— 免费项目\n新疆伊犁 9 日自驾\n";
    const sig = signPayload(payload, privateKeyPem);
    expect(verifyPayload(payload, sig, publicKeyRawB64)).toBe(true);
  });

  it("空 payload 也能往返", () => {
    const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
    const sig = signPayload("", privateKeyPem);
    expect(verifyPayload("", sig, publicKeyRawB64)).toBe(true);
  });
});

describe("verifyPayload 的拒绝路径（必须返回 false 而非抛异常）", () => {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
  const other = generateSigningKeypair();
  const payload = "tamper-me";
  const sig = signPayload(payload, privateKeyPem);

  it("payload 被篡改 → false", () => {
    expect(verifyPayload("tamper-me!", sig, publicKeyRawB64)).toBe(false);
  });

  it("换一把公钥 → false", () => {
    expect(verifyPayload(payload, sig, other.publicKeyRawB64)).toBe(false);
  });

  it("签名被篡改 → false", () => {
    const raw = Buffer.from(sig, "base64");
    raw[0] ^= 0xff;
    expect(verifyPayload(payload, raw.toString("base64"), publicKeyRawB64)).toBe(false);
  });

  it("签名长度不是 64 字节 → false（不进入验签）", () => {
    expect(verifyPayload(payload, Buffer.alloc(32).toString("base64"), publicKeyRawB64)).toBe(false);
    expect(verifyPayload(payload, "", publicKeyRawB64)).toBe(false);
  });

  it("签名不是合法 base64 → false", () => {
    expect(verifyPayload(payload, "!!!not-base64!!!", publicKeyRawB64)).toBe(false);
  });

  it("公钥非法（长度错）→ false，不抛异常", () => {
    expect(verifyPayload(payload, sig, "shortkey")).toBe(false);
  });

  it("抛异常的破坏性输入不会逃逸（红线 6：验签失败必须可安全拒绝）", () => {
    expect(() => verifyPayload(payload, sig, "")).not.toThrow();
    expect(verifyPayload(payload, sig, "")).toBe(false);
  });
});
