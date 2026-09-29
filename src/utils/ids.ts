import { createHash } from 'crypto';

/** Short, stable identifier derived from a string (same input -> same id across requests) */
export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}
