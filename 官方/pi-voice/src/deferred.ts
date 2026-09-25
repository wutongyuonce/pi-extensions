/** A promise with external settle controls. Settling is idempotent. */
export class Deferred<T = void> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;
  private done = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  get settled(): boolean {
    return this.done;
  }

  resolve(value: T): void {
    if (this.done) return;
    this.done = true;
    this.resolvePromise(value);
  }

  reject(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.rejectPromise(error);
  }
}
