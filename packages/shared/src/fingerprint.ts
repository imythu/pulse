// 日志指纹（设计文档 4.1）。规则来自 fingerprint/rules.json，Go Agent 用同一份规则，
// 两边都跑 fingerprint/cases.json 里的用例，保证算出的指纹一致。
// 依赖 node:crypto，只在服务端使用，所以不从 index.ts 导出。
import { createHash } from 'node:crypto';
import rules from '../fingerprint/rules.json' with { type: 'json' };

export const FINGERPRINT_RULES_VERSION: number = rules.version;

export type LogLevel = 'error' | 'fatal';

interface Replacer {
  re: RegExp;
  replace: string;
}

const strip = rules.strip.map((p) => new RegExp(p, 'g'));
const placeholders: Replacer[] = rules.placeholders.map((p) => ({ re: new RegExp(p.pattern, 'g'), replace: p.replace }));
const exceptionTypes: Replacer[] = rules.exceptionTypes.map((p) => ({ re: new RegExp(p.pattern), replace: p.type }));
const frames: Replacer[] = rules.frames.map((p) => ({ re: new RegExp(p.pattern), replace: p.frame }));
const framework = new RegExp(rules.frameworkFrames);

/** 把正则的匹配结果按 `$1` 形式的模板展开，未匹配的分组按空串处理。 */
function expand(m: RegExpExecArray, template: string): string {
  return template.replace(/\$([0-9])/g, (_, i: string) => m[Number(i)] ?? '');
}

function mask(text: string): string {
  let s = text;
  for (const p of placeholders) s = s.replace(p.re, p.replace);
  return s.trim();
}

/**
 * 把一条（可能多行的）异常记录变成模板：首行去掉时间戳、线程名、请求 ID 后替换变量；
 * 有堆栈时再追加异常类型和前几个业务代码栈帧（不含行号）。
 */
export function logTemplate(record: string): string {
  const lines = record.split('\n');
  let header = lines[0] ?? '';
  for (const re of strip) header = header.replace(re, '');
  const parts = [mask(header)];

  let type = '';
  for (const line of lines) {
    for (const p of exceptionTypes) {
      const m = p.re.exec(line);
      if (m) {
        type = expand(m, p.replace);
        break;
      }
    }
    if (type) break;
  }
  if (type) parts.push(type);

  let n = 0;
  for (const line of lines.slice(1)) {
    if (n >= rules.maxFrames) break;
    for (const p of frames) {
      const m = p.re.exec(line);
      if (!m) continue;
      const frame = expand(m, p.replace);
      if (!framework.test(frame)) {
        parts.push(`  at ${mask(frame)}`);
        n++;
      }
      break;
    }
  }
  return parts.join('\n');
}

export function fingerprintOf(service: string, level: LogLevel, template: string): string {
  return createHash('sha1').update(`${service}\n${level}\n${template}`).digest('hex').slice(0, 16);
}

export function fingerprint(service: string, level: LogLevel, record: string): { fingerprint: string; template: string } {
  const template = logTemplate(record);
  return { fingerprint: fingerprintOf(service, level, template), template };
}
