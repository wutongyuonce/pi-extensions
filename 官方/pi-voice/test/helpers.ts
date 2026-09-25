import { Deferred } from "../src/deferred.js";

export function deferred(): Deferred {
  return new Deferred();
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
