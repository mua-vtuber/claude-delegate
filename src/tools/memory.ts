// ========== Memory Tools ==========

import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "manage_memory",
    description: "Add a new fact or context to the project memory (.ai_context.md). Use this to remember user preferences or architectural decisions.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Information to remember" },
        category: { type: "string", description: "Category (e.g., convention, architecture, user_pref)", default: "general" },
      },
      required: ["fact"],
    },
  },
  {
    name: "read_memory",
    description: "Read the project memory (.ai_context.md).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "manage_memory": {
      const { fact, category = "general" } = args as { fact: string; category?: string };
      const memoryPath = resolve(".ai_context.md");
      const entry = `\n- [${category}] ${fact} (Added: ${new Date().toISOString()})`;
      await appendFile(memoryPath, entry, "utf-8");
      return { content: [{ type: "text", text: `Added to memory: ${fact}` }] };
    }
    case "read_memory": {
      const memoryPath = resolve(".ai_context.md");
      if (!existsSync(memoryPath)) return { content: [{ type: "text", text: "No memory file found (.ai_context.md)." }] };
      return { content: [{ type: "text", text: await readFile(memoryPath, "utf-8") }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
