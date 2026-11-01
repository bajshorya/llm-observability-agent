/**
 * The daily LLM budget for `pnpm watch` — pure arithmetic, no clock, no I/O.
 *
 * WHY A BUDGET AT ALL
 * The project's rule is that every stage that spends quota is an explicit act.
 * A loop that classifies on its own breaks that rule unless what it may spend
 * is ALSO explicit, stated up front, and enforced. This is that statement:
 * `--budget 15` means at most fifteen model requests per UTC day, counted from
 * `llm_calls`, so a restart cannot reset it and two loops share it.
 *
 * WHAT A "REQUEST" IS
 * One `llm_calls` row is one `generateStructured` call, which made
 * `1 + repairAttempts` requests to the provider. Both are counted: a repair
 * spends quota exactly as the first attempt does. HTTP-level 429 retries are
 * not counted, because a refused request is not charged.
 *
 * HOW CLOSE TO THE CAP IT GETS
 * The loop runs each stage ONE ANOMALY AT A TIME and re-reads the count
 * between them, so it stops as soon as the budget is spent. The only overshoot
 * possible is the repairs of the last anomaly — at most `maxRepairAttempts`
 * (2). That is why the default is 15 against Gemini's free 20/day: the
 * remaining 5 cover a worst-case overshoot plus a manual `pnpm classify`.
 *
 * THE STUB AND OLLAMA ARE FREE
 * The stub makes no network call and Ollama runs locally, so neither is
 * budgeted. That is what lets `pnpm watch --llm` run the whole pipeline
 * offline, forever, as the statistical baseline — which is also the fallback
 * when no key is configured.
 */

export interface BudgetState {
  /** Requests allowed per UTC day, or `null` for unlimited (the stub). */
  cap: number | null;
  /** Requests already spent today against the same provider and model. */
  usedToday: number;
}

export function remainingRequests(state: BudgetState): number {
  if (state.cap === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, state.cap - state.usedToday);
}

/** Requests represented by one `llm_calls` row. */
export function requestsForCall(repairAttempts: number): number {
  return 1 + Math.max(0, repairAttempts);
}

/** Midnight UTC at the start of `now`'s day — free-tier quotas reset on a daily boundary. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Providers that cost nothing to call and are therefore not budgeted. */
export function isFreeProvider(providerName: string): boolean {
  return providerName === "stub" || providerName === "ollama";
}

export function describeBudget(state: BudgetState): string {
  if (state.cap === null) return "unbudgeted (local provider)";
  return `${state.usedToday}/${state.cap} requests today`;
}
