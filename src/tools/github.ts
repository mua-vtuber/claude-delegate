// ========== GitHub Tools ==========

import { execFilePromise } from "../config.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "gh_create_pr",
    description: "Create a Pull Request.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        draft: { type: "boolean", default: false },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "gh_list_issues",
    description: "List recent issues.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 10 } },
    },
  },
  {
    name: "gh_get_issue",
    description: "View an issue.",
    inputSchema: {
      type: "object",
      properties: { issue_number: { type: "number" } },
      required: ["issue_number"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "gh_create_pr": {
      const { title, body, draft } = args as { title: string; body: string; draft?: boolean };
      const ghArgs = ["pr", "create", "--title", title, "--body", body];
      if (draft) ghArgs.push("--draft");
      const { stdout } = await execFilePromise("gh", ghArgs);
      return { content: [{ type: "text", text: `PR Created: ${stdout}` }] };
    }
    case "gh_list_issues": {
      const { limit = 10 } = args as { limit?: number };
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
      const { stdout } = await execFilePromise("gh", ["issue", "list", "--limit", String(safeLimit)]);
      return { content: [{ type: "text", text: stdout || "No issues." }] };
    }
    case "gh_get_issue": {
      const { issue_number } = args as { issue_number: number };
      const safeNum = Math.floor(Number(issue_number));
      if (!safeNum || safeNum < 1) throw new Error("Invalid issue number");
      const { stdout } = await execFilePromise("gh", ["issue", "view", String(safeNum)]);
      return { content: [{ type: "text", text: stdout }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
