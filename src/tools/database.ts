// ========== Database Tools ==========

import { z } from "zod";
import { existsSync } from "fs";
import { execFilePromise } from "../config.js";
import { assertPathSafe } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const sqliteQuerySchema = z.object({
  db_path: z.string().describe("Path to .sqlite or .db file"),
  query: z.string().describe("SQL query to execute (SELECT only recommended)"),
  limit: z.number().optional().default(100).describe("Maximum rows to return (default: 100)"),
  offset: z.number().optional().default(0).describe("Row offset for pagination (default: 0)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("sqlite_query", "Execute a SQL query on a SQLite database file using 'sqlite3' CLI. Returns the result as JSON.", sqliteQuerySchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  sqlite_query: sqliteQuerySchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "sqlite_query": {
      const { db_path, query, limit, offset } = sqliteQuerySchema.parse(args);
      const fullPath = assertPathSafe(db_path, "sqlite_query");
      if (!existsSync(fullPath)) throw new Error(`DB file not found: ${fullPath}`);

      // SQL whitelist: only SELECT, PRAGMA, EXPLAIN allowed
      const sqlKeyword = query.trim().split(/\s+/)[0]?.toUpperCase();
      if (!sqlKeyword || !["SELECT", "PRAGMA", "EXPLAIN"].includes(sqlKeyword)) {
        throw new Error(`Security: Only SELECT, PRAGMA, and EXPLAIN queries are allowed. Got: ${sqlKeyword}`);
      }

      // Strip string literals to avoid false positives on semicolons inside strings
      const strippedQuery = query.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
      if (strippedQuery.includes(';')) {
        throw new Error("Security: Multiple SQL statements are not allowed");
      }

      // Blocklist check for dangerous SQL keywords
      const DANGEROUS_SQL = ["ATTACH", "DETACH", "CREATE", "INSERT", "UPDATE", "DELETE", "ALTER", "DROP"];
      const upperQuery = strippedQuery.toUpperCase();
      for (const keyword of DANGEROUS_SQL) {
        if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) {
          throw new Error(`Security: ${keyword} statements are not allowed. Only SELECT, PRAGMA, and EXPLAIN are permitted.`);
        }
      }

      // Auto-inject LIMIT/OFFSET if not already present
      let finalQuery = query.trim();
      if (!upperQuery.includes("LIMIT")) {
        finalQuery += ` LIMIT ${limit} OFFSET ${offset}`;
      }

      const { stdout } = await execFilePromise("sqlite3", ["-json", fullPath, finalQuery]);

      if (!upperQuery.includes("LIMIT")) {
        const rows: unknown[] = stdout ? JSON.parse(stdout) : [];
        const hasMore = rows.length >= limit;
        const meta = hasMore
          ? `[${rows.length} rows from offset ${offset} — more rows may exist, increase offset to paginate]`
          : `[${rows.length} rows total]`;
        return { content: [{ type: "text", text: meta + "\n" + (stdout || "[]") }] };
      }
      return { content: [{ type: "text", text: stdout || "[]" }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
