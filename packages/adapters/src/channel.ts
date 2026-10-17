/** Unbounded single-consumer async queue. `push` after `close` is ignored. */
export class Channel<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiter: ((r: IteratorResult<T>) => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: item, done: false });
    } else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: undefined, done: true });
    }
  }

  /** Drop buffered, unconsumed items. */
  clear(): void {
    this.#items.length = 0;
  }

  get size(): number {
    return this.#items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.#waiter = resolve));
      },
      return: () => {
        this.close();
        this.#items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
