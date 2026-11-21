export async function eventually<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs} ms${last ? `: ${String(last)}` : ''}`);
}
