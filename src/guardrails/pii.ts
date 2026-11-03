/**
 * PII redaction for everything that crosses into a model provider.
 *
 * Redaction happens on the way in (tool results, the user's question) as well
 * as on the final answer. Redacting only the answer would be pointless since
 * the provider has already logged the raw data by then.
 *
 * Two passes:
 *   1. JSON fields whose key is known to hold PII are tagged whatever their
 *      format. This is the reliable path for anything that came from our own
 *      tables.
 *   2. Free text is scanned with patterns. Patterns are a fallback and they are
 *      written to miss rather than over-match: an ISO timestamp tagged as a
 *      phone number breaks every time-based question the agent gets.
 *
 * One Redactor lives for one agent run, so a value keeps the same tag across
 * every tool call in that run and the model can still tell customers apart.
 */

type Kind = "EMAIL" | "CARD" | "PHONE";

const SENSITIVE_KEYS: Record<string, Kind> = {
  email: "EMAIL",
  phone: "PHONE",
  card_number: "CARD",
};

// Order matters: CARD has to run before PHONE, or long digit runs get counted
// as phones and the per-kind counts are wrong.
const PATTERNS: Array<{ kind: Kind; re: RegExp }> = [
  { kind: "EMAIL", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: "CARD", re: /\b(?:\d[ -]*?){13,19}\b/g },
  // Needs at least one separator between digit groups, which is what keeps
  // "2026-09-01T10:00:00Z", decimals and bare integer amounts out of it.
  {
    kind: "PHONE",
    re: /(?<![\w.:-])\+?\(?\d{1,3}\)?[ .-]?\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{3,4})?(?![\w:])/g,
  },
];

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

export class Redactor {
  readonly counts: Record<string, number> = {};
  private readonly tags = new Map<string, string>();

  text(input: string): string {
    let out = input;
    for (const { kind, re } of PATTERNS) {
      out = out.replace(re, (match) => {
        if (kind === "CARD" && !passesLuhn(match)) return match;
        return this.tag(kind, match);
      });
    }
    return out;
  }

  /** Redacts a tool result and serialises it for the model. */
  json(value: unknown): string {
    return JSON.stringify(this.walk(value));
  }

  private walk(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      const kind = key ? SENSITIVE_KEYS[key.toLowerCase()] : undefined;
      return kind ? this.tag(kind, value) : this.text(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k);
      return out;
    }
    return value;
  }

  private tag(kind: Kind, raw: string): string {
    const key = `${kind}:${raw.trim().toLowerCase()}`;
    let tag = this.tags.get(key);
    if (!tag) {
      const n = (this.counts[kind] ?? 0) + 1;
      this.counts[kind] = n;
      tag = `[${kind}_${n}]`;
      this.tags.set(key, tag);
    }
    return tag;
  }
}

export function redact(input: string): RedactionResult {
  const r = new Redactor();
  return { text: r.text(input), counts: r.counts };
}

export function redactJson(value: unknown): { value: string; counts: Record<string, number> } {
  const r = new Redactor();
  return { value: r.json(value), counts: r.counts };
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
