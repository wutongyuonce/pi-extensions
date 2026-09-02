import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLimiter } from "../src/async-limiter.js";
import { deferred, nextTurn } from "./helpers.js";

test("limits active work and starts the next queued task", async () => {
  const limiter = new AsyncLimiter(2);
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;

  const run = (id: number): Promise<void> =>
    limiter.run(async () => {
      started.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates[id - 1]!.promise;
      active -= 1;
    });

  const first = run(1);
  const second = run(2);
  const third = run(3);
  await nextTurn();

  assert.deepEqual(started, [1, 2]);
  assert.equal(maximumActive, 2);

  gates[0]!.resolve();
  await first;
  await nextTurn();
  assert.deepEqual(started, [1, 2, 3]);

  gates[1]!.resolve();
  gates[2]!.resolve();
  await Promise.all([second, third]);
});

test("an aborted waiter never starts or consumes a permit", async () => {
  const limiter = new AsyncLimiter(1);
  const gate = deferred();
  const first = limiter.run(() => gate.promise);
  const controller = new AbortController();
  let queuedStarted = false;
  const queued = limiter.run(async () => {
    queuedStarted = true;
  }, controller.signal);

  controller.abort(new Error("cancelled while queued"));
  await assert.rejects(queued, /cancelled while queued/);
  assert.equal(queuedStarted, false);

  gate.resolve();
  await first;
  let nextStarted = false;
  await limiter.run(async () => {
    nextStarted = true;
  });
  assert.equal(nextStarted, true);
});
