import type { LimitWindow } from "@ani-assistente/engines";
import type { RequestKind } from "./prompt.js";

// Token estimates for a plan, learned from the runs on this machine. Before
// there is history, a range from the measurement in docs/DECISIONS.md is used
// (a lean run is about 9 thousand tokens for a two-call answer).

export interface RunRecord {
  at: string;
  kind: RequestKind;
  model: string;
  /** Steps of the approved plan, when there was one. */
  steps: number | null;
  tokens: number;
}

export interface RunHistory {
  load(): Promise<RunRecord[]>;
  append(record: RunRecord): Promise<void>;
}

export interface Estimate {
  low: number;
  high: number;
  /** "histórico" when learned from at least 3 similar runs; "padrão" before that. */
  basis: "histórico" | "padrão";
}

const DEFAULT_PER_STEP = { low: 6_000, high: 15_000 };
const MIN_HISTORY = 3;

function quantile(sorted: number[], q: number): number {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

/** Tokens per step from past planned runs (same model when possible), as a p25–p75 range. */
export function estimatePlan(history: RunRecord[], steps: number, model: string): Estimate {
  const planned = history.filter((r) => r.steps && r.steps > 0);
  const sameModel = planned.filter((r) => r.model === model);
  const sample = (sameModel.length >= MIN_HISTORY ? sameModel : planned).map((r) => r.tokens / r.steps!);
  if (sample.length < MIN_HISTORY) {
    return { low: steps * DEFAULT_PER_STEP.low, high: steps * DEFAULT_PER_STEP.high, basis: "padrão" };
  }
  const sorted = [...sample].sort((a, b) => a - b);
  return {
    low: Math.round(steps * quantile(sorted, 0.25)),
    high: Math.round(steps * Math.max(quantile(sorted, 0.75), quantile(sorted, 0.25) * 1.2)),
    basis: "histórico",
  };
}

/** "entre 18 e 45 mil tokens" */
export function describeTokens(low: number, high: number): string {
  const k = (n: number) => Math.max(1, Math.round(n / 1000));
  // A narrow range reads better as one number.
  if (high <= 0 || (high - low) / high < 0.15) return `cerca de ${k((low + high) / 2)} mil tokens`;
  return `entre ${k(low)} e ${k(high)} mil tokens`;
}

/** "Você já usou 30% da janela de 5 horas." */
export function describeLimits(windows: LimitWindow[]): string {
  const main = windows.find((w) => w.name === "5 horas") ?? windows[0];
  if (!main) return "";
  return `Você já usou ${Math.round(main.utilization * 100)}% da janela de ${main.name}.`;
}
