// ========== Diff & Patch Tools ==========

import { readFile } from "fs/promises";
import { assertPathSafe } from "../security.js";
import type { CallToolResult } from "../types.js";
import { computeDiff, formatUnifiedDiff } from "../helpers/diff.js";

export const definitions = [
  {
    name: "diff_files",
    description: "Compare two files and return unified diff.",
    inputSchema: {
      type: "object",
      properties: {
        file1: { type: "string", description: "First file path" },
        file2: { type: "string", description: "Second file path" },
        context_lines: { type: "number", default: 3, description: "Number of context lines" },
      },
      required: ["file1", "file2"],
    },
  },
  {
    name: "diff_strings",
    description: "Compare two strings and return unified diff.",
    inputSchema: {
      type: "object",
      properties: {
        text1: { type: "string", description: "First text" },
        text2: { type: "string", description: "Second text" },
        label1: { type: "string", default: "original" },
        label2: { type: "string", default: "modified" },
      },
      required: ["text1", "text2"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "diff_files": {
      const { file1, file2, context_lines = 3 } = args as { file1: string; file2: string; context_lines?: number };
      const path1 = assertPathSafe(file1, "diff_files");
      const path2 = assertPathSafe(file2, "diff_files");
      const content1 = (await readFile(path1, "utf-8")).split("\n");
      const content2 = (await readFile(path2, "utf-8")).split("\n");

      const diffLines = computeDiff(content1, content2);
      const unifiedDiff = formatUnifiedDiff(diffLines, context_lines, file1, file2);

      return { content: [{ type: "text", text: unifiedDiff }] };
    }
    case "diff_strings": {
      const { text1, text2, label1 = "original", label2 = "modified", context_lines = 3 } = args as {
        text1: string;
        text2: string;
        label1?: string;
        label2?: string;
        context_lines?: number;
      };
      const lines1 = text1.split("\n");
      const lines2 = text2.split("\n");

      const diffLines = computeDiff(lines1, lines2);
      const unifiedDiff = formatUnifiedDiff(diffLines, context_lines, label1, label2);

      return { content: [{ type: "text", text: unifiedDiff }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
