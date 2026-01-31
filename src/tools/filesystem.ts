// ========== File System Tools ==========

import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { assertPathSafe } from "../security.js";
import { searchInFiles } from "../helpers/filesystem.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "fs_write_file",
    description: "Create or overwrite a file with specific content.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "fs_read_file",
    description: "Read the content of a file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "fs_list_directory",
    description: "List files and directories.",
    inputSchema: {
      type: "object",
      properties: { dir_path: { type: "string", default: "." } },
    },
  },
  {
    name: "fs_search_files",
    description: "Search for files containing a specific pattern.",
    inputSchema: {
      type: "object",
      properties: {
        dir_path: { type: "string", default: "." },
        pattern: { type: "string" },
      },
      required: ["pattern"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "fs_write_file": {
      const { file_path, content } = args as { file_path: string; content: string };
      const fullPath = assertPathSafe(file_path, "write");
      await writeFile(fullPath, content, "utf-8");
      return { content: [{ type: "text", text: `Successfully wrote to ${file_path}` }] };
    }
    case "fs_read_file": {
      const { file_path } = args as { file_path: string };
      const fullPath = assertPathSafe(file_path, "read");
      if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
      return { content: [{ type: "text", text: await readFile(fullPath, "utf-8") }] };
    }
    case "fs_list_directory": {
      const { dir_path = "." } = args as { dir_path?: string };
      const fullPath = assertPathSafe(dir_path, "list_directory");
      return { content: [{ type: "text", text: (await readdir(fullPath)).join("\n") }] };
    }
    case "fs_search_files": {
      const { dir_path = ".", pattern } = args as { dir_path?: string; pattern: string };
      const fullPath = assertPathSafe(dir_path, "search_files");
      const results = await searchInFiles(fullPath, pattern);
      return { content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches." }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
