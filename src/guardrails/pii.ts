/**
 * PII redaction applied to every tool result before it reaches the model, and
 * again to the final answer before it reaches the caller.
 *
 * Redacting on the way *in* is the part that matters. The customers table holds
 * emails and phone numbers; without this, a question as ordinary as "who filed
 * the most refunds?" ships real contact details to a third-party API and into
 * that provider's logs. Redacting only the final answer would be theatre — the
 * data would already have left the building.
 *
 * The replacement keeps a stable, non-reversible tag per distinct value, so the
 * model can still reason about identity ("the same customer appears twice")
 * without ever seeing the value itself.
 */

/**
 * Order matters, and it is the specific-before-general kind of matters.
 *
 * The phone pattern is a loose "run of digits and separators", so it happily
 * swallows a 16-digit card number. Whichever pattern runs first wins the text,
 * so putting PHONE ahead of CARD silently mislabels every card as a phone
 * number — still redacted, but the counts lie, and a CARD-specific policy built
 * on those counts would never fire. Most specific first.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "EMAIL", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: "CARD", re: /\b(?:\d[ -]*?){13,19}\b/g },
  { kind: "PHONE", re: /\+?\d[\d\s().-]{7,}\d/g },
];

export interface RedactionResult {
  text: string;
  /** Count of redactions by kind, for telemetry and for the eval report. */
  counts: Record<string, number>;
}

export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  const seen = new Map<string, string>();
  let text = input;

  for (const { kind, re } of PATTERNS) {
    text = text.replace(re, (match) => {
      // Cards are matched loosely; skip anything that fails a Luhn check so we
      // do not redact ordinary long integers such as ids or cent amounts.
      if (kind === "CARD" && !passesLuhn(match)) return match;

      const key = `${kind}:${match}`;
      let tag = seen.get(key);
      if (!tag) {
        const n = (counts[kind] ?? 0) + 1;
        counts[kind] = n;
        tag = `[${kind}_${n}]`;
        seen.set(key, tag);
      }
      return tag;
    });
  }

  return { text, counts };
}

export function redactJson(value: unknown): { value: string; counts: Record<string, number> } {
  const { text, counts } = redact(JSON.stringify(value));
  return { value: text, counts };
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
