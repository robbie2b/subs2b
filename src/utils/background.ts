/**
 * Work that goes on after the answer was sent (the Subsync preparation, the usage record). On a normal server the
 * process just keeps running; on Vercel the function may be frozen as soon as the answer is out, unless the work is
 * handed to waitUntil, which keeps it alive until the promise settles.
 */
export function keepAlive(work: Promise<unknown> | undefined): void {
  if (!work || !process.env.VERCEL) return;
  try {
    // loaded only on Vercel (the package needs that platform's request context)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { waitUntil } = require('@vercel/functions') as { waitUntil: (p: Promise<unknown>) => void };
    waitUntil(work.catch(() => undefined));
  } catch {
    // not available: the work continues while the instance lives
  }
}
