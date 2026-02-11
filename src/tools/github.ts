// ========== GitHub & Git Tools ==========

import { z } from "zod";
import { execFilePromise } from "../config.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";
import { ollamaChat } from "../helpers/ollama.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";

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

export const generateCommitMessageSchema = z.object({
  staged_only: z.boolean().optional().default(true).describe("If true, only analyze staged changes. If false, include unstaged changes."),
  language: z.enum(["en", "ko", "ja", "zh"]).optional().default("en").describe("Language for commit message"),
  style: z.enum(["conventional", "simple", "detailed"]).optional().default("conventional").describe("Commit message style: conventional (feat/fix/docs), simple (one line), detailed (with body)"),
  dir: z.string().optional().describe("Git repository directory (defaults to current working directory)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("gh_create_pr", "Create a Pull Request.", ghCreatePrSchema),
  createToolDefinition("gh_list_issues", "List recent issues.", ghListIssuesSchema),
  createToolDefinition("gh_get_issue", "View an issue.", ghGetIssueSchema),
  createToolDefinition(
    "generate_commit_message",
    "Generate a commit message from git diff using local LLM. Analyzes staged (or all) changes and produces a commit message in the specified style and language. FREE (uses local Ollama).",
    generateCommitMessageSchema
  ),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  gh_create_pr: ghCreatePrSchema,
  gh_list_issues: ghListIssuesSchema,
  gh_get_issue: ghGetIssueSchema,
  generate_commit_message: generateCommitMessageSchema,
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
    case "generate_commit_message": {
      const { staged_only, language, style, dir } = generateCommitMessageSchema.parse(args);
      const cwd = dir || process.cwd();

      // Get git diff
      const diffArgs = staged_only ? ["diff", "--staged"] : ["diff", "HEAD"];
      const { stdout: diff } = await execFilePromise("git", diffArgs, { cwd });

      if (!diff.trim()) {
        return { content: [{ type: "text", text: "No changes detected. Stage your changes with 'git add' first." }] };
      }

      // Truncate very large diffs
      const maxDiffLength = 8000;
      const truncatedDiff = diff.length > maxDiffLength
        ? diff.slice(0, maxDiffLength) + "\n... (truncated)"
        : diff;

      // Build prompt based on style
      const styleInstructions: Record<string, string> = {
        conventional: `Use Conventional Commits format: type(scope): description
Types: feat, fix, docs, style, refactor, test, chore
Example: feat(auth): add login validation`,
        simple: `Write a single-line commit message (max 72 chars).
Example: Add user authentication feature`,
        detailed: `Write a commit message with:
- Subject line (max 72 chars)
- Blank line
- Body explaining what and why (not how)
Example:
Add user authentication feature

Implement JWT-based authentication to secure API endpoints.
This replaces the previous session-based approach.`,
      };

      const langInstructions: Record<string, string> = {
        en: "Write in English.",
        ko: "한국어로 작성하세요.",
        ja: "日本語で書いてください。",
        zh: "用中文写。",
      };

      const prompt = `Analyze this git diff and generate a commit message.

${styleInstructions[style]}
${langInstructions[language]}

IMPORTANT:
- Focus on WHAT changed and WHY, not HOW
- Be concise but descriptive
- Output ONLY the commit message, nothing else

Git diff:
\`\`\`
${truncatedDiff}
\`\`\``;

      const systemPrompt = "You are a git commit message generator. Output ONLY the commit message, no explanations or markdown.";

      // Use light model for this simple task (7B is sufficient)
      const result = await ollamaChat(OLLAMA_MODELS.light, prompt, systemPrompt);

      // Clean up the response (remove quotes, markdown, etc.)
      let message = result.text.trim();
      message = message.replace(/^["'`]+|["'`]+$/g, "");
      message = message.replace(/^```\w*\n?|\n?```$/g, "");

      return {
        content: [{
          type: "text",
          text: `Generated commit message (${style}, ${language}):\n\n${message}\n\nModel: ${result.model}`
        }]
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
