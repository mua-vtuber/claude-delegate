// ========== File System Tools ==========

import { z } from "zod";
import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { assertPathSafe } from "../security.js";
import { searchInFiles } from "../helpers/filesystem.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const fsWriteFileSchema = z.object({
  file_path: z.string().describe("Path to write"),
  content: z.string().describe("Content to write"),
});

export const fsReadFileSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional().describe("Line offset to start reading from (0-based)"),
  limit: z.number().optional().describe("Maximum number of lines to read (default: 2000)"),
});

export const fsListDirectorySchema = z.object({
  dir_path: z.string().optional().default("."),
});

export const fsSearchFilesSchema = z.object({
  dir_path: z.string().optional().default("."),
  pattern: z.string(),
  max_results: z.number().optional().default(50).describe("Maximum number of results to return (default: 50)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("fs_write_file", "Create or overwrite a file with specific content.", fsWriteFileSchema),
  createToolDefinition("fs_read_file", "Read the content of a file.", fsReadFileSchema),
  createToolDefinition("fs_list_directory", "List files and directories.", fsListDirectorySchema),
  createToolDefinition("fs_search_files", "Search for files containing a specific pattern.", fsSearchFilesSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  fs_write_file: fsWriteFileSchema,
  fs_read_file: fsReadFileSchema,
  fs_list_directory: fsListDirectorySchema,
  fs_search_files: fsSearchFilesSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "fs_write_file": {
      const { file_path, content } = fsWriteFileSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "write");
      await writeFile(fullPath, content, "utf-8");
      return { content: [{ type: "text", text: `Successfully wrote to ${file_path}` }] };
    }
    case "fs_read_file": {
      const { file_path, offset, limit } = fsReadFileSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "read");
      if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
      const raw = await readFile(fullPath, "utf-8");
      const lines = raw.split("\n");
      const totalLines = lines.length;
      const start = offset ?? 0;
      const count = limit ?? 2000;
      if (totalLines <= count && start === 0) {
        return { content: [{ type: "text", text: raw }] };
      }
      const sliced = lines.slice(start, start + count);
      const end = Math.min(start + count, totalLines);
      const header = `[lines ${start + 1}-${end} of ${totalLines}]`;
      return { content: [{ type: "text", text: header + "\n" + sliced.join("\n") }] };
    }
    case "fs_list_directory": {
      const { dir_path } = fsListDirectorySchema.parse(args);
      const fullPath = assertPathSafe(dir_path, "list_directory");
      return { content: [{ type: "text", text: (await readdir(fullPath)).join("\n") }] };
    }
    case "fs_search_files": {
      const { dir_path, pattern, max_results } = fsSearchFilesSchema.parse(args);
      const fullPath = assertPathSafe(dir_path, "search_files");
      const results = await searchInFiles(fullPath, pattern);
      if (results.length === 0) return { content: [{ type: "text", text: "No matches." }] };
      const limited = results.slice(0, max_results);
      const header = results.length > max_results! ? `[showing ${max_results} of ${results.length} matches]\n` : "";
      return { content: [{ type: "text", text: header + limited.join("\n") }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
