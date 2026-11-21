/** Per-turn step timings in the terminal, so latency can be discussed with numbers. */
export function turnLogger(id: string) {
  const t0 = Date.now();
  const line = (msg: string) => console.log(`[turn ${id}] ${msg}`);
  return {
    async time<T>(step: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> {
      const start = Date.now();
      const result = await fn();
      line(`${step.padEnd(10)} ${String(Date.now() - start).padStart(6)}ms  ${detail?.(result) ?? ""}`);
      return result;
    },
    info: (msg: string) => line(msg),
    total: () => line(`${"total".padEnd(10)} ${String(Date.now() - t0).padStart(6)}ms`),
  };
}
