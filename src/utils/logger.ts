import { ProviderLogEntry } from '../types/provider';

function stamp(level: string, message: string, context?: Record<string, unknown>): string {
  const ctx = context ? ` ${JSON.stringify(context)}` : '';
  return `[${new Date().toISOString()}] [${level}] ${message}${ctx}`;
}

export class Logger {
  static info(message: string, context?: Record<string, unknown>): void {
    console.log(stamp('INFO', message, context));
  }

  static warn(message: string, context?: Record<string, unknown>): void {
    console.warn(stamp('WARN', message, context));
  }

  static error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    const detail = error instanceof Error ? error.stack || error.message : String(error || '');
    console.error(stamp('ERROR', `${message} - ${detail}`, context));
  }

  static logProviderResult(entry: ProviderLogEntry): void {
    const status = entry.success ? 'SUCCESS' : 'FAILED';
    const errorMsg = entry.error ? ` - Error: ${entry.error}` : '';
    console.log(`[PROVIDER] [${status}] [${entry.providerId}] ${entry.durationMs}ms -> ${entry.resultsCount} subs${errorMsg}`);
  }
}
