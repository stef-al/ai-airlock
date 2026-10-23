import EngineWorker from '../worker/engine.worker?worker&inline';
import type { Req, Msg } from '../worker/protocol';

export class CancelledError extends Error {
  constructor(msg = 'cancelled') {
    super(msg);
  }
}

interface Job {
  make: () => Req;
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  /** runs synchronously before the next job is built (promise callbacks would run too late) */
  onResult?: (v: never) => void;
}

/** Runs engine jobs one at a time in a Web Worker; cancelling terminates and respawns the worker. */
class Client {
  private w: Worker | null = null;
  private seq = 0;
  private queue: Job[] = [];
  private running: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
  private listeners = new Set<(busy: boolean) => void>();

  subscribe(f: (busy: boolean) => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }
  private emit() {
    const busy = !!this.running || this.queue.length > 0;
    this.listeners.forEach((f) => f(busy));
  }

  call<T>(req: Req | (() => Req), opts: { timeoutMs?: number; onResult?: (v: T) => void } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        make: typeof req === 'function' ? req : () => req,
        resolve: resolve as (v: never) => void,
        reject,
        timeoutMs: opts.timeoutMs ?? 120_000,
        onResult: opts.onResult as ((v: never) => void) | undefined,
      });
      this.pump();
      this.emit();
    });
  }

  private spawn(): Worker {
    if (this.w) return this.w;
    const w = new EngineWorker();
    w.onmessage = (e: MessageEvent<Msg>) => {
      const r = this.running;
      if (!r || r.id !== e.data.id) return;
      clearTimeout(r.timer);
      this.running = null;
      if (e.data.ok) {
        try {
          r.job.onResult?.(e.data.result as never);
          r.job.resolve(e.data.result as never);
        } catch (err) {
          r.job.reject(err as Error);
        }
      } else r.job.reject(new Error(e.data.error));
      this.pump();
      this.emit();
    };
    w.onerror = (e) => {
      this.fail(new Error(e.message || 'worker error'));
    };
    this.w = w;
    return w;
  }

  private pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const id = ++this.seq;
    // a timeout stops only this job; the ones queued behind it run in a fresh worker
    const timer = setTimeout(() => this.fail(new CancelledError('This took too long and was stopped.')), job.timeoutMs);
    this.running = { id, job, timer };
    try {
      this.spawn().postMessage({ id, req: job.make() });
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private fail(err: Error) {
    const r = this.running;
    this.running = null;
    if (r) {
      clearTimeout(r.timer);
      r.job.reject(err);
    }
    this.w?.terminate();
    this.w = null;
    this.pump();
    this.emit();
  }

  /** Stops the running job (terminating the worker) and everything queued behind it. */
  cancel(reason = 'cancelled') {
    const r = this.running;
    const q = this.queue;
    this.running = null;
    this.queue = [];
    if (r) clearTimeout(r.timer);
    this.w?.terminate();
    this.w = null;
    const err = new CancelledError(reason);
    r?.job.reject(err);
    q.forEach((j) => j.reject(err));
    this.emit();
  }
}

export const engine = new Client();
