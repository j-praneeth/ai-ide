/**
 * VS Code async coordination primitives — ported from:
 *   src/vs/base/common/async.ts
 *
 * Throttler, Delayer, RunOnceScheduler, Sequencer, Limiter,
 * createCancelablePromise, ResourceQueue
 */

// ─── CancellationToken ────────────────────────────────────────────────────────

export function createCancelablePromise(callback) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    cancel = reject;
    Promise.resolve(callback({ isCancellationRequested: false }))
      .then(resolve)
      .catch(reject);
  });
  promise.cancel = () => {
    cancel(new CancellationError());
  };
  return promise;
}

export class CancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

export function isCancellationError(err) {
  return err instanceof CancellationError || err?.name === 'CancellationError';
}

// ─── Throttler ────────────────────────────────────────────────────────────────
// At most 1 in-flight + 1 pending. New calls replace the pending slot.
// Mirrors: src/vs/base/common/async.ts → class Throttler

export class Throttler {
  constructor() {
    this._activePromise = null;
    this._queuedPromise = null;
    this._queuedFactory = null;
  }

  queue(factory) {
    if (this._activePromise) {
      // Store the latest factory in the pending slot (replaces stale ones)
      this._queuedFactory = factory;
      if (!this._queuedPromise) {
        this._queuedPromise = this._activePromise.then(() => {
          this._queuedPromise = null;
          const f = this._queuedFactory;
          this._queuedFactory = null;
          return this.queue(f);
        });
      }
      return this._queuedPromise;
    }

    this._activePromise = factory().then(
      result => { this._activePromise = null; return result; },
      err    => { this._activePromise = null; throw err; }
    );
    return this._activePromise;
  }
}

// ─── Delayer (debounce) ───────────────────────────────────────────────────────
// Mirrors: src/vs/base/common/async.ts → class Delayer

export class Delayer {
  constructor(defaultDelay) {
    this.defaultDelay = defaultDelay;
    this._timer = null;
    this._resolve = null;
    this._reject = null;
    this._promise = null;
    this._task = null;
  }

  trigger(task, delay = this.defaultDelay) {
    this._task = task;
    this.cancel();
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(() => {
        this._timer = null;
        const t = this._task;
        this._task = null;
        try {
          resolve(typeof t === 'function' ? t() : t);
        } catch (e) {
          reject(e);
        }
      }, delay);
    });
    return this._promise;
  }

  cancel() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._reject) {
      this._reject(new CancellationError());
      this._resolve = null;
      this._reject = null;
      this._promise = null;
    }
  }

  isTriggered() {
    return this._timer !== null;
  }

  dispose() {
    this.cancel();
  }
}

// ─── RunOnceScheduler ─────────────────────────────────────────────────────────
// Schedule a callback to run once after a delay. Rescheduling resets the timer.
// Mirrors: src/vs/base/common/async.ts → class RunOnceScheduler

export class RunOnceScheduler {
  constructor(runner, delay) {
    this._runner = runner;
    this._delay = delay;
    this._timer = null;
  }

  schedule(delay = this._delay) {
    this.cancel();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._runner();
    }, delay);
  }

  cancel() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  isScheduled() {
    return this._timer !== null;
  }

  dispose() {
    this.cancel();
  }
}

// ─── Sequencer ────────────────────────────────────────────────────────────────
// Serial async queue — each task runs only after the previous one completes.
// Mirrors: src/vs/base/common/async.ts → class Sequencer

export class Sequencer {
  constructor() {
    this._current = Promise.resolve();
  }

  queue(factory) {
    return (this._current = this._current.then(() => factory(), () => factory()));
  }
}

// Per-key sequencer — one serial queue per key (e.g. per file path).
// Mirrors: src/vs/base/common/async.ts → class SequencerByKey

export class SequencerByKey {
  constructor() {
    this._map = new Map();
  }

  queue(key, factory) {
    let seq = this._map.get(key);
    if (!seq) {
      seq = new Sequencer();
      this._map.set(key, seq);
    }
    return seq.queue(() => {
      return factory().finally(() => {
        // Auto-dispose empty queue
        if (this._map.get(key) === seq) this._map.delete(key);
      });
    });
  }
}

// ─── Limiter ──────────────────────────────────────────────────────────────────
// Concurrency cap — at most N parallel async tasks.
// Mirrors: src/vs/base/common/async.ts → class Limiter

export class Limiter {
  constructor(maxDegreeOfParallelism) {
    this._maxDegree = maxDegreeOfParallelism;
    this._outstandingPromises = [];
    this._runningPromises = 0;
  }

  get size() {
    return this._runningPromises + this._outstandingPromises.length;
  }

  queue(factory) {
    return new Promise((resolve, reject) => {
      this._outstandingPromises.push({ factory, resolve, reject });
      this._consume();
    });
  }

  _consume() {
    while (this._outstandingPromises.length > 0 && this._runningPromises < this._maxDegree) {
      const iLimitedTask = this._outstandingPromises.shift();
      this._runningPromises++;
      iLimitedTask.factory().then(
        result => {
          this._runningPromises--;
          iLimitedTask.resolve(result);
          this._consume();
        },
        err => {
          this._runningPromises--;
          iLimitedTask.reject(err);
          this._consume();
        }
      );
    }
  }
}

// ─── ResourceQueue ────────────────────────────────────────────────────────────
// Per-key serial queues that auto-dispose when empty.
// Mirrors: src/vs/base/common/async.ts → class ResourceQueue

export class ResourceQueue {
  constructor() {
    this._queues = new Map();
  }

  queueFor(key, factory) {
    let queue = this._queues.get(key);
    if (!queue) {
      queue = [];
      this._queues.set(key, queue);
    }
    return new Promise((resolve, reject) => {
      const entry = { factory, resolve, reject };
      queue.push(entry);
      if (queue.length === 1) this._drain(key);
    });
  }

  _drain(key) {
    const queue = this._queues.get(key);
    if (!queue || queue.length === 0) {
      this._queues.delete(key);
      return;
    }
    const { factory, resolve, reject } = queue[0];
    factory().then(
      result => { resolve(result); queue.shift(); this._drain(key); },
      err    => { reject(err);   queue.shift(); this._drain(key); }
    );
  }
}
