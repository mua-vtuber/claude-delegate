// ========== Diff & Patch Tools ==========

import { z } from "zod";
import { readFile } from "fs/promises";
import { assertPathSafe } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";
import { computeDiff, formatUnifiedDiff } from "../helpers/diff.js";

// ===== Schemas =====
export const diffFilesSchema = z.object({
  file1: z.string().describe("First file path"),
  file2: z.string().describe("Second file path"),
  context_lines: z.number().optional().default(3).describe("Number of context lines"),
});

export const diffStringsSchema = z.object({
  text1: z.string().describe("First text"),
  text2: z.string().describe("Second text"),
  label1: z.string().optional().default("original"),
  label2: z.string().optional().default("modified"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("diff_files", "Compare two files and return unified diff.", diffFilesSchema),
  createToolDefinition("diff_strings", "Compare two strings and return unified diff.", diffStringsSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  diff_files: diffFilesSchema,
  diff_strings: diffStringsSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "diff_files": {
      const { file1, file2, context_lines } = diffFilesSchema.parse(args);
      const path1 = assertPathSafe(file1, "diff_files");
      const path2 = assertPathSafe(file2, "diff_files");
      const content1 = (await readFile(path1, "utf-8")).split("\n");
      const content2 = (await readFile(path2, "utf-8")).split("\n");

      const diffLines = computeDiff(content1, content2);
      const unifiedDiff = formatUnifiedDiff(diffLines, context_lines, file1, file2);

      return { content: [{ type: "text", text: unifiedDiff }] };
    }
    case "diff_strings": {
      const { text1, text2, label1, label2 } = diffStringsSchema.parse(args);
      const lines1 = text1.split("\n");
      const lines2 = text2.split("\n");

      const diffLines = computeDiff(lines1, lines2);
      const unifiedDiff = formatUnifiedDiff(diffLines, 3, label1, label2);

      return { content: [{ type: "text", text: unifiedDiff }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
