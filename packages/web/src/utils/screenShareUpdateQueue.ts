// Source swaps and live quality/audio changes share one sender transaction queue.
let pending: Promise<unknown> = Promise.resolve();

export function serializeScreenShareUpdate<T>(update: () => Promise<T>): Promise<T> {
  const next = pending.then(update);
  pending = next.catch(() => {});
  return next;
}
