import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PULSE_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  PULSE_AGENT_DIST: z.string().optional(),
  PULSE_WEB_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** 连续多少秒没有收到 Agent 任何消息就判定离线（3 次心跳） */
  PULSE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().default(45),
  /** 数据目录：签名密钥、仓库克隆、分析工作区 */
  PULSE_DATA_DIR: z.string().default('/var/lib/pulse'),
  /** 指令签名密钥（base64 的 32 字节 Ed25519 种子）；不设置时读取或生成 <数据目录>/signing.key */
  PULSE_SIGNING_KEY: z.string().optional(),
  PULSE_SIGNING_KEY_FILE: z.string().optional(),
  /** gh 与 git 可执行文件，测试时可替换 */
  PULSE_GH_BIN: z.string().default('gh'),
  PULSE_GIT_BIN: z.string().default('git'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`配置错误：\n  ${issues}`);
  }
  return parsed.data;
}
