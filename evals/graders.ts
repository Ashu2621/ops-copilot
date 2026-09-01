import type { RunResult } from "../src/agent/loop.js";

/**
 * Graders are deliberately exact.
 *
 * The temptation with an agent test suite is to ask a model whether the answer
 * "looks right". That makes the score a function of a second model's mood, and
 * it cannot be used as a regression gate because it is not reproducible. Every
 * assertion here is a structural fact about the run — which path answered it,
 * which tools ran, which step failed and with what code, how much was redacted —
 * so a red result always points at a specific broken behaviour.
 *
 * `answerMatches` is the one loose check, and it is deliberately a permissive
 * regex used only to confirm the answer is on-topic, never to grade quality.
 */

export interface Assertions {
  path?: "router" | "model";
  intent?: string;
  toolsUsed?: string[];
  toolSucceeded?: string;
  stepFailedWith?: string;
  answerMatches?: string;
  maxCostUsd?: number;
  minRedactions?: Record<string, number>;
}

export interface Failure {
  check: string;
  expected: string;
  actual: string;
}

export function grade(result: RunResult, a: Assertions): Failure[] {
  const failures: Failure[] = [];

  if (a.path && result.path !== a.path) {
    failures.push({ check: "path", expected: a.path, actual: result.path });
  }

  if (a.intent && result.intent !== a.intent) {
    failures.push({ check: "intent", expected: a.intent, actual: result.intent ?? "none" });
  }

  if (a.toolsUsed) {
    for (const tool of a.toolsUsed) {
      if (!result.toolsUsed.includes(tool)) {
        failures.push({
          check: "toolsUsed",
          expected: `includes ${tool}`,
          actual: result.toolsUsed.join(", ") || "none",
        });
      }
    }
  }

  if (a.toolSucceeded) {
    const ok = result.steps.some((s) => s.tool === a.toolSucceeded && s.ok);
    if (!ok) {
      failures.push({
        check: "toolSucceeded",
        expected: `${a.toolSucceeded} ran successfully`,
        actual: describeSteps(result),
      });
    }
  }

  if (a.stepFailedWith) {
    const hit = result.steps.some((s) => !s.ok && (s.detail ?? "").includes(a.stepFailedWith!));
    if (!hit) {
      failures.push({
        check: "stepFailedWith",
        expected: `a step failing with "${a.stepFailedWith}"`,
        actual: describeSteps(result),
      });
    }
  }

  if (a.answerMatches && !new RegExp(a.answerMatches, "i").test(result.answer)) {
    failures.push({
      check: "answerMatches",
      expected: `/${a.answerMatches}/i`,
      actual: truncate(result.answer),
    });
  }

  if (a.maxCostUsd !== undefined && result.usage.costUsd > a.maxCostUsd) {
    failures.push({
      check: "maxCostUsd",
      expected: `<= ${a.maxCostUsd}`,
      actual: result.usage.costUsd.toFixed(6),
    });
  }

  if (a.minRedactions) {
    for (const [kind, min] of Object.entries(a.minRedactions)) {
      const got = result.redactions[kind] ?? 0;
      if (got < min) {
        failures.push({ check: `redactions.${kind}`, expected: `>= ${min}`, actual: String(got) });
      }
    }
  }

  return failures;
}

function describeSteps(result: RunResult): string {
  if (result.steps.length === 0) return "no steps";
  return result.steps.map((s) => `${s.tool}:${s.ok ? "ok" : (s.detail ?? "failed")}`).join(", ");
}

function truncate(text: string, n = 90): string {
  return text.length <= n ? text : `${text.slice(0, n)}...`;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
