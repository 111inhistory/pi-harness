import { setTimeout } from 'node:timers/promises';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Wait for an observable condition, not an assumed processing delay. */
export async function waitFor<T>(check: () => T | Promise<T>, { label = 'condition', timeoutMs = 3000 } = {}): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await setTimeout(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
