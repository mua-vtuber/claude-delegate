// ========== Sequential Thinking Tools ==========

import { thinkingSteps } from "../state.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "think_step",
    description: "Record a thinking step for sequential reasoning. Use session_id to group related thoughts.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session identifier" },
        thought: { type: "string", description: "The thought or reasoning step" },
        action: { type: "string", enum: ["add", "list", "clear"], default: "add" },
      },
      required: ["session_id"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "think_step": {
      const { session_id, thought, action = "add" } = args as { session_id: string; thought?: string; action?: string };

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
