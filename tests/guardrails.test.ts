import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "../src/db/sqlite.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertSingleReadStatement, SqlGuardError, truncateRows, MAX_ROWS } from "../src/guardrails/sql.js";
import { redact } from "../src/guardrails/pii.js";
import { denyAll, approveAll } from "../src/guardrails/approval.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-guardrails.db");

beforeAll(() => freshDb(DB));
afterAll(() => rmSync(DB, { force: true }));

describe("assertSingleReadStatement", () => {
  it("accepts a plain SELECT", () => {
    expect(() => assertSingleReadStatement("SELECT COUNT(*) FROM orders")).not.toThrow();
  });

  it("accepts a CTE", () => {
    expect(() =>
      assertSingleReadStatement("WITH t AS (SELECT 1 AS a) SELECT a FROM t"),
    ).not.toThrow();
  });

  it("accepts a single trailing semicolon", () => {
    expect(() => assertSingleReadStatement("SELECT 1;")).not.toThrow();
  });

  it("rejects a bare mutation", () => {
    expect(() => assertSingleReadStatement("DELETE FROM orders")).toThrow(SqlGuardError);
  });

  it("rejects a second statement smuggled after a read", () => {
    expect(() => assertSingleReadStatement("SELECT 1; DROP TABLE orders")).toThrow(
      /multiple statements|Only one statement/i,
    );
  });

  it("rejects a second statement hidden behind a comment", () => {
    expect(() =>
      assertSingleReadStatement("SELECT 1 -- harmless\n; DROP TABLE orders"),
    ).toThrow(SqlGuardError);
  });

  it("does NOT reject a read whose literal merely contains a keyword", () => {
    // The exact false positive a denylist would produce. This must pass.
    expect(() =>
      assertSingleReadStatement("SELECT * FROM refunds WHERE reason = 'customer wanted an update'"),
    ).not.toThrow();
  });
});

describe("read-only connection (the load-bearing control)", () => {
  it("serves reads", () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
    expect(row.n).toBe(300);
    db.close();
  });

  it("refuses every write shape, regardless of spelling", () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    for (const sql of [
      "DELETE FROM orders",
      "UPDATE orders SET status = 'paid'",
      "INSERT INTO orders (id, customer_id, status, total_cents, created_at) VALUES (99999,1,'paid',1,'x')",
      "DROP TABLE orders",
      "CREATE TABLE evil (a INT)",
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/readonly/i);
    }
    db.close();
  });
});

describe("truncateRows", () => {
  it("passes small result sets through untouched", () => {
    const { rows, truncated } = truncateRows([1, 2, 3]);
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(false);
  });

  it("caps oversized result sets and flags the truncation", () => {
    const { rows, truncated } = truncateRows(Array.from({ length: MAX_ROWS + 25 }, (_, i) => i));
    expect(rows).toHaveLength(MAX_ROWS);
    expect(truncated).toBe(true);
  });
});

describe("PII redaction", () => {
  it("removes emails and phone numbers", () => {
    const { text, counts } = redact('{"email":"ana.silva7@example.com","phone":"+1-555-1007"}');
    expect(text).not.toContain("ana.silva7@example.com");
    expect(text).not.toContain("555-1007");
    expect(counts.EMAIL).toBe(1);
    expect(counts.PHONE).toBe(1);
  });

  it("gives the same value the same tag, so identity survives redaction", () => {
    const { text } = redact("a@b.com talked to a@b.com and c@d.com");
    expect(text).toBe("[EMAIL_1] talked to [EMAIL_1] and [EMAIL_2]");
  });

  it("leaves ordinary long integers alone", () => {
    // Cent amounts and ids must survive; only Luhn-valid runs are card-like.
    const { text, counts } = redact('{"total_cents":4999123,"order_id":1234567890123}');
    expect(text).toContain("4999123");
    expect(counts.CARD ?? 0).toBe(0);
  });

  it("redacts a Luhn-valid card number", () => {
    const { counts } = redact("card 4242424242424242 on file");
    expect(counts.CARD).toBe(1);
  });
});

describe("approval gate", () => {
  const request = { tool: "issue_refund", input: {}, summary: "Refund $25.00 on order #12" };

  it("denies by default when no human is attached", async () => {
    const decision = await denyAll(request);
    expect(decision.approved).toBe(false);
  });

  it("records who approved, for the audit trail", async () => {
    const decision = await approveAll(request);
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe("eval-harness");
  });
});
