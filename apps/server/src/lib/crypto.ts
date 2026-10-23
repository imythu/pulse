import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

/** 生成 URL 安全的随机令牌，带前缀便于识别来源。 */
export function newToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/** 令牌只存 sha256，数据库泄露也拿不到可用令牌。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Ed25519 SPKI DER 前缀，后面接 32 字节原始公钥
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('Ed25519 公钥必须是 32 字节');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function verifyEd25519(raw: Buffer, message: string, signature: Buffer): boolean {
  try {
    return verify(null, Buffer.from(message), ed25519PublicKey(raw), signature);
  } catch {
    return false;
  }
}
