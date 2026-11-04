import type { ModelProvider, ModelTurn } from "./types.js";

/**
 * A cap on model calls per UTC day, across every caller.
 *
 * The per-subject rate limit stops one token from running up the bill, but a
 * public demo hands out tokens to anyone, so a determined visitor just takes
 * more. This is the backstop that holds no matter how many subjects there are.
 * Router answers never reach the model, so they keep working after the cap.
 *
 * In memory and per process, like the rate limiter: a restart resets it.
 */
export class DailyBudgetExceeded extends Error {}

export class BudgetedProvider implements ModelProvider {
  private day = "";
  private used = 0;

  constructor(
    private readonly inner: ModelProvider,
    readonly callsPerDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  priceUsd(inputTokens: number, outputTokens: number): number {
    return this.inner.priceUsd(inputTokens, outputTokens);
  }

  async send(request: Parameters<ModelProvider["send"]>[0]): Promise<ModelTurn> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.callsPerDay) {
      throw new DailyBudgetExceeded(
        `today's model budget (${this.callsPerDay} calls) is used up; it resets at 00:00 UTC`,
      );
    }
    // Counted before the call: a call that fails still cost a request.
    this.used++;
    return this.inner.send(request);
  }
}
