// 指令模板与签名（设计文档 3.5、10.2）。内置模板定义在 commands/templates.json，
// Agent 通过 go:embed 打包同一份文件，在本地再校验一次参数。
import { z } from 'zod';
import templatesJson from '../commands/templates.json' with { type: 'json' };

export type CommandRisk = 'read' | 'write';

export const CommandParam = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/),
  label: z.string().max(64).default(''),
  type: z.enum(['string', 'int', 'duration', 'enum']),
  required: z.boolean().default(false),
  pattern: z.string().max(512).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  hint: z.string().max(200).optional(),
});
export type CommandParam = z.infer<typeof CommandParam>;

export const CommandTemplate = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/),
  description: z.string().max(500).default(''),
  risk: z.enum(['read', 'write']),
  timeoutSeconds: z.number().int().min(1).max(600),
  params: z.array(CommandParam).max(10).nullish().transform((v) => v ?? []),
});
export type CommandTemplate = z.infer<typeof CommandTemplate>;

export const BUILTIN_TEMPLATES: CommandTemplate[] = templatesJson.templates.map((t) => CommandTemplate.parse(t));
export const TEMPLATES_VERSION = templatesJson.version;

export function findBuiltin(name: string): CommandTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.name === name);
}

/** 解析 30s / 15m / 1h / 7d 这样的时长，返回秒数。 */
export function parseDuration(s: string): number | null {
  const m = /^(\d{1,7})([smhd])$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** 按模板校验参数并补上默认值；与 Agent 端 commands.Validate 的规则一致。 */
export function validateArgs(t: CommandTemplate, input: Record<string, unknown>): { args: Record<string, string> } | { error: string } {
  const args: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!t.params.some((p) => p.name === key)) return { error: `模板 ${t.name} 不支持参数 ${key}` };
  }
  for (const p of t.params) {
    const raw = input[p.name];
    let v = raw === undefined || raw === null || raw === '' ? p.default : String(raw);
    if (v === undefined) {
      if (p.required) return { error: `缺少参数 ${p.label || p.name}` };
      continue;
    }
    v = v.trim();
    const label = p.label || p.name;
    switch (p.type) {
      case 'int': {
        if (!/^-?\d{1,10}$/.test(v)) return { error: `${label} 必须是整数` };
        const n = Number(v);
        if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) return { error: `${label} 需在 ${p.min ?? '-∞'}–${p.max ?? '∞'} 之间` };
        v = String(n);
        break;
      }
      case 'duration': {
        const n = parseDuration(v);
        if (n === null) return { error: `${label} 格式应为 30s、15m、1h、7d` };
        if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) return { error: `${label} 超出允许范围` };
        break;
      }
      case 'enum':
        if (!p.options?.includes(v)) return { error: `${label} 只能是 ${p.options?.join(' / ')}` };
        break;
      case 'string':
        if (v.length > 1024) return { error: `${label} 过长` };
        break;
    }
    if (p.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(p.pattern);
      } catch {
        // 自定义模板的规则按 Go RE2 写，个别语法 JS 不支持，交给 Agent 校验
        re = /[\s\S]*/;
      }
      if (!re.test(v)) return { error: `${label} 格式不正确` };
    }
    if (p.name === 'path' || p.name === 'source') {
      if (v.split('/').includes('..')) return { error: `${label} 不能包含 ..` };
    }
    args[p.name] = v;
  }
  return { args };
}

// ---------- 签名 ----------

/**
 * 服务器签名的指令内容。cmd.run 里原样携带这段 JSON 文本和它的签名，
 * Agent 对文本验签后再解析，两端不需要约定 JSON 规范化。
 */
export interface SignedCommand {
  v: 1;
  /** 用途前缀，防止把别处的签名挪来当指令 */
  kind: 'pulse-command';
  id: string;
  hostId: string;
  template: string;
  args: Record<string, string>;
  /** 毫秒时间戳，过期后 Agent 拒绝执行 */
  expiresAt: number;
  timeoutSeconds: number;
}

export type CommandStatus =
  | 'pending_approval'
  | 'queued'
  | 'sent'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'rejected'
  | 'canceled'
  | 'expired';

export const FINAL_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set(['succeeded', 'failed', 'timeout', 'rejected', 'canceled', 'expired']);

export const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
export const COMMAND_TTL_MS = 5 * 60_000;
