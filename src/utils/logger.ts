import { ProviderLogEntry } from '../types/provider';

// The latest log lines are also kept in memory so the Debug page can show them live (reset on restart)
const MAX_BUFFER_LINES = 500;
const buffer: Array<{ seq: number; text: string }> = [];
let nextSeq = 1;

function remember(text: string): void {
  buffer.push({ seq: nextSeq++, text });
  if (buffer.length > MAX_BUFFER_LINES) buffer.shift();
}

/** Log lines newer than `afterSeq` (0 = everything still in the buffer) */
export function getLogLines(afterSeq: number = 0): { lines: Array<{ seq: number; text: string }>; last: number } {
  return { lines: buffer.filter(l => l.seq > afterSeq), last: nextSeq - 1 };
}

function stamp(level: string, message: string, context?: Record<string, unknown>): string {
  const ctx = context ? ` ${JSON.stringify(context)}` : '';
  return `[${new Date().toISOString()}] [${level}] ${message}${ctx}`;
}

export class Logger {
  static info(message: string, context?: Record<string, unknown>): void {
    const line = stamp('INFO', message, context);
    remember(line);
    console.log(line);
  }

  static warn(message: string, context?: Record<string, unknown>): void {
    const line = stamp('WARN', message, context);
    remember(line);
    console.warn(line);
  }

  static error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    const detail = error instanceof Error ? error.stack || error.message : String(error || '');
    const line = stamp('ERROR', `${message} - ${detail}`, context);
    remember(line);
    console.error(line);
  }

  static logProviderResult(entry: ProviderLogEntry): void {
    const status = entry.success ? 'SUCCESS' : 'FAILED';
    const errorMsg = entry.error ? ` - Error: ${entry.error}` : '';
    const line = `[PROVIDER] [${status}] [${entry.providerId}] ${entry.durationMs}ms -> ${entry.resultsCount} subs${errorMsg}`;
    remember(line);
    console.log(line);
  }
}
