import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Ed25519 PKCS8 DER 前缀，后面接 32 字节种子
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * 指令与脚本的签名密钥（设计文档 10.2）。和 Agent 身份密钥、会话无关，只用来签名下发给 Agent 的内容。
 * 优先读环境变量（base64 的 32 字节种子），其次是密钥文件；都没有时在数据目录生成一个并以 0600 保存。
 */
export class Signer {
  private readonly key: KeyObject;
  /** 32 字节原始公钥的 base64，注册时交给 Agent */
  readonly publicKey: string;

  constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error('签名密钥必须是 32 字节的 Ed25519 种子');
    this.key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  }

  static load(opts: { envKey?: string; file: string }): Signer {
    if (opts.envKey) return new Signer(Buffer.from(opts.envKey, 'base64'));
    if (existsSync(opts.file)) return new Signer(Buffer.from(readFileSync(opts.file, 'utf8').trim(), 'base64'));
    const seed = randomBytes(32);
    mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
    writeFileSync(opts.file, seed.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    return new Signer(seed);
  }

  /** 对文本签名，返回 base64。 */
  sign(body: string): string {
    return sign(null, Buffer.from(body), this.key).toString('base64');
  }
}
