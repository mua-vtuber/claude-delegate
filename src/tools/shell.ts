// ========== Shell & Environment Tools ==========

import { z } from "zod";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFilePromise, SHELL_TIMEOUT } from "../config.js";
import { envOverrides } from "../state.js";
import { assertCommandAllowed, assertArgsAllowed, assertPathSafe, isSensitiveEnvVar } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const shellExecuteSchema = z.object({
  command: z.string().describe("Command to execute"),
  args: z.array(z.string()).optional().describe("Command arguments"),
  cwd: z.string().optional().describe("Working directory"),
  timeout: z.number().optional().describe("Timeout in milliseconds"),
  max_lines: z.number().optional().describe("Maximum stdout lines to return (default: 500, keeps last N lines if exceeded)"),
});

export const envGetSchema = z.object({
  name: z.string().describe("Variable name"),
});

export const envSetSchema = z.object({
  name: z.string().describe("Variable name"),
  value: z.string().describe("Variable value"),
});

export const dotenvParseSchema = z.object({
  file_path: z.string().optional().default(".env").describe("Path to .env file"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("shell_execute", "Execute a shell command safely. Returns stdout, stderr, and exit code.", shellExecuteSchema),
  createToolDefinition("env_get", "Get environment variable value.", envGetSchema),
  createToolDefinition("env_set", "Set environment variable (session only).", envSetSchema),
  createToolDefinition("dotenv_parse", "Parse a .env file and return key-value pairs.", dotenvParseSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  shell_execute: shellExecuteSchema,
  env_get: envGetSchema,
  env_set: envSetSchema,
  dotenv_parse: dotenvParseSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "shell_execute": {
      const validated = shellExecuteSchema.parse(args);
      const command = validated.command;
      const cmdArgs = validated.args ?? [];
      const cwd = validated.cwd;
      const timeout = validated.timeout ?? SHELL_TIMEOUT;
      assertCommandAllowed(command);
      assertArgsAllowed(command, cmdArgs);
      const options: any = { timeout };
      if (cwd) options.cwd = resolve(cwd);

      const maxLines = validated.max_lines ?? 500;
      const truncateOutput = (text: string): string => {
        const lines = text.split("\n");
        if (lines.length <= maxLines) return text;
        return `[truncated: showing last ${maxLines} of ${lines.length} lines]\n` + lines.slice(-maxLines).join("\n");
      };

      try {
        const { stdout, stderr } = await execFilePromise(command, cmdArgs, options);
        return { content: [{ type: "text", text: JSON.stringify({ stdout: truncateOutput(String(stdout)), stderr: String(stderr), exitCode: 0 }, null, 2) }] };
      } catch (err: unknown) {
        const execErr = err as { message?: string; stderr?: string; stdout?: string; code?: number | string };
        return { content: [{ type: "text", text: JSON.stringify({ stdout: truncateOutput(execErr.stdout || ""), stderr: execErr.stderr || execErr.message || "", exitCode: execErr.code || 1 }, null, 2) }] };
      }
    }
    case "env_get": {
      const { name: varName } = envGetSchema.parse(args);
      if (isSensitiveEnvVar(varName)) {
        return { content: [{ type: "text", text: "[REDACTED] - sensitive environment variable" }] };
      }
      const value = envOverrides.get(varName) ?? process.env[varName] ?? null;
      return { content: [{ type: "text", text: value !== null ? value : `Environment variable '${varName}' not found` }] };
    }
    case "env_set": {
      const { name: varName, value } = envSetSchema.parse(args);
      if (isSensitiveEnvVar(varName)) {
        throw new Error(`Security: Cannot set sensitive variable '${varName}'`);
      }
      const BLOCKED_CONFIG_VARS = ["AGENT_ALLOWED_COMMANDS", "SENSITIVE_ENV_DENYLIST", "OLLAMA_HOST"];
      if (BLOCKED_CONFIG_VARS.some(v => varName.toUpperCase() === v)) {
        throw new Error(`Security: Cannot override security configuration variable '${varName}'`);
      }
      envOverrides.set(varName, value);
      return { content: [{ type: "text", text: `Set ${varName}=${value} (session only)` }] };
    }
    case "dotenv_parse": {
      const { file_path } = dotenvParseSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "dotenv_parse");
      if (!existsSync(fullPath)) return { content: [{ type: "text", text: `File not found: ${fullPath}` }] };

      const content = await readFile(fullPath, "utf-8");
      const result: Record<string, string> = {};
      content.split("\n").forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            result[key] = isSensitiveEnvVar(key) ? "[REDACTED]" : value;
          }
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
