// ========== Sequential Thinking Tools ==========

import { z } from "zod";
import { thinkingSteps } from "../state.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const thinkStepSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  thought: z.string().optional().describe("The thought or reasoning step"),
  action: z.enum(["add", "list", "clear"]).optional().default("add"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("think_step", "Record a thinking step for sequential reasoning. Use session_id to group related thoughts.", thinkStepSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  think_step: thinkStepSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "think_step": {
      const { session_id, thought, action } = thinkStepSchema.parse(args);

      if (action === "clear") {
        thinkingSteps.delete(session_id);
        return { content: [{ type: "text", text: `Cleared thinking steps for session: ${session_id}` }] };
      }

      if (action === "list") {
        const steps = thinkingSteps.get(session_id) || [];
        return { content: [{ type: "text", text: JSON.stringify(steps, null, 2) }] };
      }

      if (!thought) throw new Error("'thought' is required for 'add' action");

      const steps = thinkingSteps.get(session_id) || [];
      steps.push({ step: steps.length + 1, thought, timestamp: new Date().toISOString() });
      thinkingSteps.set(session_id, steps);
      return { content: [{ type: "text", text: `Step ${steps.length} recorded: ${thought.substring(0, 50)}...` }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
