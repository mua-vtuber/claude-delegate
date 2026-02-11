// ========== Process Management Tools ==========

import { z } from "zod";
import { spawn } from "child_process";
import { execFilePromise } from "../config.js";
import { backgroundProcesses } from "../state.js";
import { assertCommandAllowed } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

const MAX_BACKGROUND_PROCESSES = 20;

// ===== Schemas =====
export const processListSchema = z.object({
  filter: z.string().optional().describe("Filter by process name"),
});

export const processKillSchema = z.object({
  pid: z.number().describe("Process ID to kill"),
  force: z.boolean().optional().default(false).describe("Force kill (SIGKILL)"),
});

export const backgroundRunSchema = z.object({
  command: z.string().describe("Command to run"),
  args: z.array(z.string()).optional(),
});

export const backgroundStatusSchema = z.object({
  handle_id: z.string().optional().describe("Specific handle ID to check (optional)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("process_list", "List running processes (filtered by name if provided).", processListSchema),
  createToolDefinition("process_kill", "Kill a process by PID.", processKillSchema),
  createToolDefinition("background_run", "Run a command in the background. Returns a handle ID.", backgroundRunSchema),
  createToolDefinition("background_status", "Check status of background processes.", backgroundStatusSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  process_list: processListSchema,
  process_kill: processKillSchema,
  background_run: backgroundRunSchema,
  background_status: backgroundStatusSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "process_list": {
      const { filter } = processListSchema.parse(args);
      const isWindows = process.platform === "win32";

      try {
        const { stdout } = isWindows
          ? await execFilePromise("C:\\Windows\\System32\\tasklist.exe", ["/FO", "CSV"])
          : await execFilePromise("ps", ["aux"]);

        let lines = stdout.split("\n");
        if (filter) {
          lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
        }
        return { content: [{ type: "text", text: lines.slice(0, 50).join("\n") }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }
    }
    case "process_kill": {
      const { pid, force } = processKillSchema.parse(args);

      // Only allow killing server-spawned background processes
      const isOwnedProcess = [...backgroundProcesses.values()].some(p => p.pid === pid);
      if (!isOwnedProcess) {
        throw new Error(`Security: Only server-spawned processes can be killed. PID ${pid} is not tracked.`);
      }

      const isWindows = process.platform === "win32";

      try {
        if (isWindows) {
          const killArgs = ["/PID", String(pid)];
          if (force) killArgs.push("/F");
          await execFilePromise("C:\\Windows\\System32\\taskkill.exe", killArgs);
        } else {
          const signal = force ? "-9" : "-15";
          await execFilePromise("kill", [signal, String(pid)]);
        }
        return { content: [{ type: "text", text: `Process ${pid} terminated` }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }
    }
    case "background_run": {
      const validated = backgroundRunSchema.parse(args);
      const command = validated.command;
      const cmdArgs = validated.args ?? [];
      assertCommandAllowed(command);

      if (backgroundProcesses.size >= MAX_BACKGROUND_PROCESSES) {
        throw new Error(`Maximum concurrent background processes (${MAX_BACKGROUND_PROCESSES}) reached. Kill some processes first.`);
      }

      const handleId = `bg_${Date.now()}`;

      const proc = spawn(command, cmdArgs, { detached: true, stdio: "ignore" });
      proc.unref();

      backgroundProcesses.set(handleId, { pid: proc.pid || 0, command, startTime: Date.now() });
      return { content: [{ type: "text", text: JSON.stringify({ handle_id: handleId, pid: proc.pid }, null, 2) }] };
    }
    case "background_status": {
      const { handle_id } = backgroundStatusSchema.parse(args);

      if (handle_id) {
        const proc = backgroundProcesses.get(handle_id);
        if (!proc) return { content: [{ type: "text", text: `Handle not found: ${handle_id}` }] };
        return { content: [{ type: "text", text: JSON.stringify(proc, null, 2) }] };
      }

      const all = Object.fromEntries(backgroundProcesses);
      return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
