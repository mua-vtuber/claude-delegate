// ========== Shell & Environment Tools ==========

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFilePromise, SHELL_TIMEOUT } from "../config.js";
import { envOverrides } from "../state.js";
import { assertCommandAllowed, assertArgsAllowed, assertPathSafe, isSensitiveEnvVar } from "../security.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "shell_execute",
    description: "Execute a shell command safely. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute" },
        args: { type: "array", items: { type: "string" }, description: "Command arguments" },
        cwd: { type: "string", description: "Working directory" },
        timeout: { type: "number", description: "Timeout in milliseconds", default: 30000 },
      },
      required: ["command"],
    },
  },
  {
    name: "env_get",
    description: "Get environment variable value.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Variable name" } },
      required: ["name"],
    },
  },
  {
    name: "env_set",
    description: "Set environment variable (session only).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable name" },
        value: { type: "string", description: "Variable value" },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "dotenv_parse",
    description: "Parse a .env file and return key-value pairs.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "Path to .env file", default: ".env" } },
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "shell_execute": {
      const { command, args: cmdArgs = [], cwd, timeout = SHELL_TIMEOUT } = args as { command: string; args?: string[]; cwd?: string; timeout?: number };
      assertCommandAllowed(command);
      assertArgsAllowed(command, cmdArgs);
      const options: any = { timeout };
      if (cwd) options.cwd = resolve(cwd);

      try {
        const { stdout, stderr } = await execFilePromise(command, cmdArgs, options);
        return { content: [{ type: "text", text: JSON.stringify({ stdout, stderr, exitCode: 0 }, null, 2) }] };
      } catch (err: unknown) {
        const execErr = err as { message?: string; stderr?: string; stdout?: string; code?: number | string };
        return { content: [{ type: "text", text: JSON.stringify({ stdout: execErr.stdout || "", stderr: execErr.stderr || execErr.message || "", exitCode: execErr.code || 1 }, null, 2) }] };
      }
    }
    case "env_get": {
      const { name: varName } = args as { name: string };
      if (isSensitiveEnvVar(varName)) {
        return { content: [{ type: "text", text: "[REDACTED] - sensitive environment variable" }] };
      }
      const value = envOverrides.get(varName) ?? process.env[varName] ?? null;
      return { content: [{ type: "text", text: value !== null ? value : `Environment variable '${varName}' not found` }] };
    }
    case "env_set": {
      const { name: varName, value } = args as { name: string; value: string };
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
      const { file_path = ".env" } = args as { file_path?: string };
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
