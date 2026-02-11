import { schemaMap as toolSchemas } from "./validation.js";
import type { CallToolResult } from "./types.js";
import { logger } from "./logger.js";

export type ValidationResult = {
  success: true;
  data: Record<string, unknown>;
} | {
  success: false;
  error: CallToolResult;
};

/**
 * Validate tool arguments against Zod schema.
 * Returns parsed data on success, or a CallToolResult error on failure.
 */
export function validateArgs(name: string, args: Record<string, unknown> | undefined): ValidationResult {
  const schema = toolSchemas.get(name);
  if (!schema) {
    logger.warn({ event: "schema_missing", tool: name, action: "pass_through" });
    return { success: true, data: args || {} };
  }

  const result = schema.safeParse(args || {});
  if (!result.success) {
    const errors = result.error.issues
      .map((i: any) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    logger.warn({
      event: "validation_error",
      tool: name,
      errors: result.error.issues?.map((i: any) => ({ path: i.path, message: i.message })),
    });
    return {
      success: false,
      error: {
        content: [{ type: "text", text: `Validation error for ${name}: ${errors}` }],
        isError: true,
      },
    };
  }

  return { success: true, data: result.data as Record<string, unknown> };
}

/**
 * Log tool call with timing information.
 * Uses structured pino logger writing to .mcp-server.log file.
 */
export function logToolCall(
  name: string,
  durationMs: number,
  isError: boolean
): void {
  logger.info({
    event: "tool_call",
    tool: name,
    duration_ms: durationMs,
    status: isError ? "error" : "ok",
  });
}
