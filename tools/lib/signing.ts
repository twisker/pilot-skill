import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Ed25519 签名/验签工具（资源完整性校验，spec §10.6 防线 2）
//
// 用途：products.json 等分发资源由发布流水线签名（detached，base64），
// 客户端内嵌公钥验签，失败拒用。
//
// 格式约定：
//   - 公钥：raw 32 字节的 base64（一行常量，便于内嵌代码）
//   - 私钥：PKCS8 PEM 文件（scripts/sign-products.ts keygen 生成；
//     仅存发布机，绝不入库）
//   - 签名：对文件原始字节签名，base64 存 <文件名>.sig
//
// 服务端 services/link-service/core/verify.ts 有同线序的验签实现
// （独立包不跨包 import）。
// ---------------------------------------------------------------------------

/** Ed25519 SPKI DER 前缀（RFC 8410）：拼上 raw 32 字节公钥即完整 DER */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyFromRawB64(publicKeyRawB64: string): KeyObject {
  const raw = Buffer.from(publicKeyRawB64, "base64");
  if (raw.length !== 32) {
    throw new Error(`Ed25519 公钥必须是 raw 32 字节的 base64，实际 ${raw.length} 字节`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/** 生成密钥对：私钥 PKCS8 PEM + 公钥 raw base64 */
export function generateSigningKeypair(): {
  privateKeyPem: string;
  publicKeyRawB64: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicKeyRawB64: spki.subarray(spki.length - 32).toString("base64"),
  };
}

/** 对 payload 原始字节签名，返回 base64 */
export function signPayload(payload: Buffer | string, privateKeyPem: string): string {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, data, key).toString("base64");
}

/** 验签；任何格式错误一律 false，不抛异常 */
export function verifyPayload(
  payload: Buffer | string,
  signatureB64: string,
  publicKeyRawB64: string
): boolean {
  try {
    const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
    const signature = Buffer.from(signatureB64, "base64");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, data, publicKeyFromRawB64(publicKeyRawB64), signature);
  } catch {
    return false;
  }
}
