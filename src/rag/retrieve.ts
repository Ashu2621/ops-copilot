/**
 * Retrieval over the on-call runbooks.
 *
 * DESIGN NOTE — why TF-IDF and not embeddings.
 *
 * The runbook corpus is three documents and roughly a dozen sections. At that
 * size a hosted embedding model buys nothing measurable: the queries that reach
 * this tool share vocabulary with the documents almost word for word
 * ("gateway_timeout", "p95 latency", "duplicate charge"), which is precisely the
 * regime where lexical scoring is strongest and dense retrieval's advantage —
 * matching paraphrase — has little to bite on.
 *
 * What it would cost is real: a second network dependency in the request path,
 * an API key required before anyone can run the tests, per-query latency and
 * spend, and a vector store to keep in sync with the markdown.
 *
 * So this stays lexical until the corpus outgrows it. The retrieval interface
 * below is deliberately narrow, so swapping in a dense index later means
 * replacing one function rather than rewriting the tool.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNBOOK_DIR = join(HERE, "..", "..", "runbooks");

export interface Section {
  source: string;
  heading: string;
  body: string;
}

export interface RunbookHit extends Section {
  score: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "be", "been", "to", "of", "in",
  "on", "for", "with", "at", "by", "from", "it", "this", "that", "as", "if", "we", "our",
  "do", "does", "not", "no", "can", "will", "should", "what", "when", "how", "i", "you",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split each runbook on `##` headings so a hit points at one procedure. */
function loadSections(): Section[] {
  const sections: Section[] = [];
  for (const file of readdirSync(RUNBOOK_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(RUNBOOK_DIR, file), "utf8");
    const parts = text.split(/^##\s+/m).slice(1);
    for (const part of parts) {
      const newline = part.indexOf("\n");
      sections.push({
        source: basename(file),
        heading: part.slice(0, newline).trim(),
        body: part.slice(newline + 1).trim(),
      });
    }
  }
  return sections;
}

interface Index {
  sections: Section[];
  vectors: Array<Map<string, number>>;
  norms: number[];
  idf: Map<string, number>;
}

let cached: Index | null = null;

function buildIndex(): Index {
  const sections = loadSections();
  const docTokens = sections.map((s) => tokenise(`${s.heading} ${s.heading} ${s.body}`));

  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const n = sections.length;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) idf.set(term, Math.log((n + 1) / (df + 1)) + 1);

  const vectors = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      vec.set(term, (count / tokens.length) * (idf.get(term) ?? 0));
    }
    return vec;
  });

  const norms = vectors.map((v) => Math.hypot(...v.values()));
  return { sections, vectors, norms, idf };
}

function getIndex(): Index {
  if (!cached) cached = buildIndex();
  return cached;
}

/** Test hook — forces a rebuild after the corpus changes on disk. */
export function resetIndex(): void {
  cached = null;
}

export function searchRunbooks(query: string, topK = 3): RunbookHit[] {
  const { sections, vectors, norms, idf } = getIndex();
  const queryTokens = tokenise(query);
  if (queryTokens.length === 0) return [];

  const qtf = new Map<string, number>();
  for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  const qvec = new Map<string, number>();
  for (const [term, count] of qtf) {
    qvec.set(term, (count / queryTokens.length) * (idf.get(term) ?? 0));
  }
  const qnorm = Math.hypot(...qvec.values());
  if (qnorm === 0) return [];

  const scored = sections.map((section, i) => {
    let dot = 0;
    for (const [term, weight] of qvec) dot += weight * (vectors[i]!.get(term) ?? 0);
    const denom = qnorm * (norms[i] || 1);
    return { ...section, score: denom === 0 ? 0 : Number((dot / denom).toFixed(4)) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
}
