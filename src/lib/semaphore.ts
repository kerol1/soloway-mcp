/**
 * Bounded concurrency gate. acquire() resolves true when a slot is free (immediately or within
 * waitMs as one frees), or false on timeout — the caller then returns a graceful "busy" instead
 * of piling load onto the carrier circuit-breakers. Per-replica only (no cross-pod coordination).
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: { grant: (ok: boolean) => void }[] = [];

  constructor(private readonly max: number) {}

  async acquire(waitMs: number): Promise<boolean> {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const entry = {
        grant: (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, waitMs);
      this.waiters.push(entry);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next.grant(true); // slot transfers to the waiter; active count unchanged
    else this.active--;
  }
}
