// ========== Memory Tools ==========

import { z } from "zod";
import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const manageMemorySchema = z.object({
  fact: z.string().describe("Information to remember"),
  category: z.string().optional().default("general").describe("Category (e.g., convention, architecture, user_pref)"),
});

export const readMemorySchema = z.object({});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("manage_memory", "Add a new fact or context to the project memory (.ai_context.md). Use this to remember user preferences or architectural decisions.", manageMemorySchema),
  createToolDefinition("read_memory", "Read the project memory (.ai_context.md).", readMemorySchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  manage_memory: manageMemorySchema,
  read_memory: readMemorySchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "manage_memory": {
      const { fact, category } = manageMemorySchema.parse(args);
      const memoryPath = resolve(".ai_context.md");
      const entry = `\n- [${category}] ${fact} (Added: ${new Date().toISOString()})`;
      await appendFile(memoryPath, entry, "utf-8");
      return { content: [{ type: "text", text: `Added to memory: ${fact}` }] };
    }
    case "read_memory": {
      readMemorySchema.parse(args);
      const memoryPath = resolve(".ai_context.md");
      if (!existsSync(memoryPath)) return { content: [{ type: "text", text: "No memory file found (.ai_context.md)." }] };
      return { content: [{ type: "text", text: await readFile(memoryPath, "utf-8") }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
