// ========== Process Management Tools ==========

import { spawn } from "child_process";
import { execFilePromise } from "../config.js";
import { backgroundProcesses } from "../state.js";
import { assertCommandAllowed } from "../security.js";
import type { CallToolResult } from "../types.js";

const MAX_BACKGROUND_PROCESSES = 20;

export const definitions = [
  {
    name: "process_list",
    description: "List running processes (filtered by name if provided).",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by process name" },
      },
    },
  },
  {
    name: "process_kill",
    description: "Kill a process by PID.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process ID to kill" },
        force: { type: "boolean", default: false, description: "Force kill (SIGKILL)" },
      },
      required: ["pid"],
    },
  },
  {
    name: "background_run",
    description: "Run a command in the background. Returns a handle ID.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
  },
  {
    name: "background_status",
    description: "Check status of background processes.",
    inputSchema: {
      type: "object",
      properties: {
        handle_id: { type: "string", description: "Specific handle ID to check (optional)" },
      },
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "process_list": {
      const { filter } = args as { filter?: string };
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
      const { pid, force = false } = args as { pid: number; force?: boolean };

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
      const { command, args: cmdArgs = [] } = args as { command: string; args?: string[] };
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
      const { handle_id } = args as { handle_id?: string };

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
