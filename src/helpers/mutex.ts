/**
 * A minimal promise-chain mutex for serializing access to a shared, non-reentrant
 * resource within a single Node process.
 *
 * The worker runs two async chains concurrently — the SQS poll loop and the 15-minute
 * retry scheduler (see worker.ts) — and both drive uploadToNyscef, which mutates a
 * module-level browser singleton (activeBrowsers/activeContext in uploader.ts). Node is
 * single-threaded, but every `await` is a yield point, so without serialization one chain
 * can tear the browser down (or close a page) while the other is mid-flight, surfacing as
 * "No browsers available" or "Target page/context/browser has been closed".
 *
 * runExclusive queues callers so they run strictly one-at-a-time, in call order.
 */
export class Mutex {
    // Always-resolved tail of the queue. Each new task chains off the previous task's
    // settlement; the result is the promise the *caller* awaits.
    private tail: Promise<unknown> = Promise.resolve();

    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        // Run fn only after the previous task has settled (resolved OR rejected).
        const run = this.tail.then(() => fn());
        // Advance the tail, swallowing rejection so one failing task does not poison the
        // queue for everyone behind it. The caller still receives the real result via `run`.
        this.tail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }
}
