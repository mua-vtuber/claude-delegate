// ========== GitHub Tools ==========

import { z } from "zod";
import { execFilePromise } from "../config.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const ghCreatePrSchema = z.object({
  title: z.string(),
  body: z.string(),
  draft: z.boolean().optional().default(false),
});

export const ghListIssuesSchema = z.object({
  limit: z.number().optional().default(10),
});

export const ghGetIssueSchema = z.object({
  issue_number: z.number(),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("gh_create_pr", "Create a Pull Request.", ghCreatePrSchema),
  createToolDefinition("gh_list_issues", "List recent issues.", ghListIssuesSchema),
  createToolDefinition("gh_get_issue", "View an issue.", ghGetIssueSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  gh_create_pr: ghCreatePrSchema,
  gh_list_issues: ghListIssuesSchema,
  gh_get_issue: ghGetIssueSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "gh_create_pr": {
      const { title, body, draft } = ghCreatePrSchema.parse(args);
      const ghArgs = ["pr", "create", "--title", title, "--body", body];
      if (draft) ghArgs.push("--draft");
      const { stdout } = await execFilePromise("gh", ghArgs);
      return { content: [{ type: "text", text: `PR Created: ${stdout}` }] };
    }
    case "gh_list_issues": {
      const { limit } = ghListIssuesSchema.parse(args);
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
      const { stdout } = await execFilePromise("gh", ["issue", "list", "--limit", String(safeLimit)]);
      return { content: [{ type: "text", text: stdout || "No issues." }] };
    }
    case "gh_get_issue": {
      const { issue_number } = ghGetIssueSchema.parse(args);
      const safeNum = Math.floor(Number(issue_number));
      if (!safeNum || safeNum < 1) throw new Error("Invalid issue number");
      const { stdout } = await execFilePromise("gh", ["issue", "view", String(safeNum)]);
      return { content: [{ type: "text", text: stdout }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
