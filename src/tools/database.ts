// ========== Database Tools ==========

import { existsSync } from "fs";
import { execFilePromise } from "../config.js";
import { assertPathSafe } from "../security.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "sqlite_query",
    description: "Execute a SQL query on a SQLite database file using 'sqlite3' CLI. Returns the result as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: { type: "string", description: "Path to .sqlite or .db file" },
        query: { type: "string", description: "SQL query to execute (SELECT only recommended)" },
      },
      required: ["db_path", "query"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "sqlite_query": {
      const { db_path, query } = args as { db_path: string; query: string };
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

      const { stdout } = await execFilePromise("sqlite3", ["-json", fullPath, query]);
      return { content: [{ type: "text", text: stdout || "[]" }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
