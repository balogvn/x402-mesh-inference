import { describe, expect, it } from "vitest";
import { ValidationError } from "@x402-mesh/shared";
import { Semaphore } from "../src/semaphore.js";

/**
 * Admission control.
 *
 * Every failure mode here costs real money or real availability: a leaked permit shrinks the
 * node's capacity permanently, a double release raises the effective ceiling above what the
 * GPU can serve, and a lost waiter hangs a request forever.
 */

describe("Semaphore construction", () => {
  it("rejects a non-positive or non-integer ceiling", () => {
    expect(() => new Semaphore(0)).toThrow(ValidationError);
    expect(() => new Semaphore(-1)).toThrow(ValidationError);
    expect(() => new Semaphore(1.5)).toThrow(ValidationError);
    expect(() => new Semaphore(Number.NaN)).toThrow(ValidationError);
    expect(() => new Semaphore(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it("starts empty", () => {
    const sem = new Semaphore(3);
    expect(sem.permits).toBe(3);
    expect(sem.inFlight).toBe(0);
    expect(sem.available).toBe(3);
    expect(sem.queued).toBe(0);
  });
});

describe("Semaphore.tryAcquire", () => {
  it("caps concurrency at the configured limit", () => {
    const sem = new Semaphore(2);
    const first = sem.tryAcquire();
    const second = sem.tryAcquire();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sem.inFlight).toBe(2);
    expect(sem.available).toBe(0);
    // The third caller is what the HTTP layer turns into a 503.
    expect(sem.tryAcquire()).toBeNull();
  });

  it("readmits work after a release", () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(sem.tryAcquire()).toBeNull();

    release?.();
    expect(sem.inFlight).toBe(0);
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it("treats a repeated release as a single release", () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    release?.();
    release?.();
    release?.();

    // A double release that decremented twice would let two requests run on a 1-permit node.
    expect(sem.inFlight).toBe(0);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
  });
});

describe("Semaphore.run", () => {
  it("releases the permit when the task resolves", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
    expect(sem.inFlight).toBe(0);
    expect(sem.available).toBe(1);
  });

  it("releases the permit when the task throws, over and over", async () => {
    const sem = new Semaphore(2);

    // A permit leaked on the error path would silently shrink capacity to zero after two
    // failures and the node would then answer 503 forever while looking healthy.
    for (let i = 0; i < 25; i += 1) {
      await expect(sem.run(async () => Promise.reject(new Error(`boom ${i}`)))).rejects.toThrow(
        `boom ${i}`,
      );
      expect(sem.inFlight).toBe(0);
    }

    expect(sem.available).toBe(2);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it("releases the permit when the task throws synchronously", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    expect(sem.available).toBe(1);
  });

  it("never runs more tasks at once than the ceiling allows", async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      await Promise.resolve();
      concurrent -= 1;
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        sem.run(async () => {
          await task();
          // Half the tasks fail: the error path must return its permit too.
          if (i % 2 === 0) throw new Error("odd one out");
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(20);
    expect(sem.inFlight).toBe(0);
    expect(sem.queued).toBe(0);
  });
});

describe("Semaphore.acquire", () => {
  it("resolves immediately when a permit is free", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    release();
    expect(sem.inFlight).toBe(0);
  });

  it("queues waiters and resumes them in order", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const order: string[] = [];

    const waiters = ["a", "b", "c"].map((label) =>
      sem.acquire().then((release) => {
        order.push(label);
        return release;
      }),
    );
    // Let the three `acquire` calls reach the queue before anything is released.
    await Promise.resolve();
    expect(sem.queued).toBe(3);

    let release = held;
    for (let i = 0; i < waiters.length; i += 1) {
      release();
      release = await waiters[i]!;
    }
    release();

    expect(order).toEqual(["a", "b", "c"]);
    expect(sem.queued).toBe(0);
    expect(sem.inFlight).toBe(0);
  });

  it("hands the permit straight to a waiter without dipping below the ceiling", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const waiting = sem.acquire();
    await Promise.resolve();

    held();
    // The permit moved rather than being returned and re-taken, so the count never dropped.
    expect(sem.inFlight).toBe(1);
    expect(sem.tryAcquire()).toBeNull();

    (await waiting)();
    expect(sem.inFlight).toBe(0);
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const sem = new Semaphore(1);
    const held = sem.tryAcquire();
    const controller = new AbortController();
    controller.abort(new Error("gone"));

    await expect(sem.acquire(controller.signal)).rejects.toThrow("gone");
    expect(sem.queued).toBe(0);
    held?.();
  });

  it("still admits work after a queued waiter aborts", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const controller = new AbortController();
    const abandoned = sem.acquire(controller.signal);
    const survivor = sem.acquire();
    await Promise.resolve();
    expect(sem.queued).toBe(2);

    controller.abort(new Error("client hung up"));
    await expect(abandoned).rejects.toThrow("client hung up");
    expect(sem.queued).toBe(1);

    // The permit must reach the surviving waiter, not the dropped one.
    held();
    const release = await survivor;
    expect(sem.inFlight).toBe(1);
    release();
    expect(sem.inFlight).toBe(0);
    expect(sem.available).toBe(1);
  });

  it("returns the permit when every waiter has abandoned the queue", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const controller = new AbortController();
    const abandoned = sem.acquire(controller.signal);
    await Promise.resolve();

    controller.abort(new Error("gone"));
    await expect(abandoned).rejects.toThrow("gone");

    held();
    expect(sem.inFlight).toBe(0);
    expect(sem.available).toBe(1);
  });

  it("does not run the task at all when acquisition is aborted", async () => {
    const sem = new Semaphore(1);
    const held = sem.tryAcquire();
    const controller = new AbortController();
    let ran = false;

    const pending = sem.run(async () => {
      ran = true;
      return 1;
    }, controller.signal);
    await Promise.resolve();

    controller.abort(new Error("no capacity wanted"));
    await expect(pending).rejects.toThrow("no capacity wanted");
    expect(ran).toBe(false);

    held?.();
    expect(sem.available).toBe(1);
  });
});
