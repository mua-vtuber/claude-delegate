// ========== Productivity Tools ==========

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { extname } from "path";
import { execFilePromise } from "../config.js";
import { getAllFiles, saveReviewToFile } from "../helpers/filesystem.js";
import { ollamaChat } from "../helpers/ollama.js";
import { runGeminiWithFallback } from "../helpers/gemini.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { assertPathSafe } from "../security.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "todo_manager",
    description: "Manage a TODO.md file. Can list, add, or complete tasks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "complete"], description: "Action to perform" },
        task: { type: "string", description: "Task description (for 'add')" },
        index: { type: "number", description: "Task index (for 'complete')" },
      },
      required: ["action"],
    },
  },
  {
    name: "code_review",
    description: "Perform a comprehensive code review. Saves result to .ai_reviews/ and returns file path.",
    inputSchema: {
      type: "object",
      properties: {
        dir_path: { type: "string", default: "." },
        focus: { type: "string", default: "general" },
      },
    },
  },
  {
    name: "git_commit_helper",
    description: "Generate a commit message based on 'git diff'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "generate_unit_test",
    description: "Generate unit tests for a file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "add_docstrings",
    description: "Add docstrings to a file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "todo_manager": {
      const { action, task, index } = args as { action: string; task?: string; index?: number };
      const todoPath = assertPathSafe("TODO.md", "todo_manager");
      let content = existsSync(todoPath) ? await readFile(todoPath, "utf-8") : "# Project TODOs\n";

      if (action === "list") {
        return { content: [{ type: "text", text: content }] };
      } else if (action === "add" && task) {
        content += `\n- [ ] ${task}`;
        await writeFile(todoPath, content, "utf-8");
        return { content: [{ type: "text", text: `Added task: ${task}` }] };
      } else if (action === "complete" && typeof index === "number") {
        const lines = content.split("\n");
        let taskCount = 0;
        let found = false;
        const newLines = lines.map(line => {
          if (line.trim().startsWith("- [ ]")) {
            taskCount++;
            if (taskCount === index) {
              found = true;
              return line.replace("- [ ]", "- [x]");
            }
          }
          return line;
        });
        if (!found) throw new Error(`Task #${index} not found.`);
        await writeFile(todoPath, newLines.join("\n"), "utf-8");
        return { content: [{ type: "text", text: `Completed task #${index}` }] };
      }
      throw new Error("Invalid parameters for todo_manager");
    }

    case "code_review": {
      const { dir_path = ".", focus = "general" } = args as { dir_path?: string; focus?: string };
      const fullPath = assertPathSafe(dir_path, "code_review");
      const allFiles = await getAllFiles(fullPath);
      const sourceExtensions = [".ts", ".js", ".py", ".go", ".java", ".c", ".cpp", ".rs", ".html", ".css", ".json"];
      const sourceFiles = allFiles.filter((f) => sourceExtensions.includes(extname(f)));
      if (sourceFiles.length === 0) return { content: [{ type: "text", text: "No source files." }] };

      const fileRefs = sourceFiles.map((f) => `@${f}`).join(" ");
      const systemPrompt = `Role: Senior developer. Task: Comprehensive code review. Focus: ${focus}. Identify issues, suggest improvements, and highlight best practices.`;
      const prompt = `${fileRefs} ${systemPrompt}`;
      const { response, source } = await runGeminiWithFallback(prompt, 300000);

      // Save to file instead of returning directly
      const sourceNote = source === "ollama" ? " (Ollama fallback)" : "";
      const reviewPath = await saveReviewToFile(`# Code Review${sourceNote}\n\n**Focus:** ${focus}\n**Directory:** ${dir_path}\n**Files:** ${sourceFiles.length}\n\n---\n\n${response}`, "code_review");
      return { content: [{ type: "text", text: `Review saved to: ${reviewPath}${source === "ollama" ? " (used Ollama fallback)" : ""}\n\nUse Read tool to view the full review.` }] };
    }

    case "git_commit_helper": {
      let diff: string;
      try {
        diff = (await execFilePromise("git", ["diff", "--staged"])).stdout || (await execFilePromise("git", ["diff"])).stdout;
      } catch { throw new Error("Not a git repo or no git detected."); }
      if (!diff.trim()) return { content: [{ type: "text", text: "No changes to commit." }] };

      const prompt = `Generate a conventional commit message for:\n${diff.substring(0, 4000)}`;
      const msg = await ollamaChat(OLLAMA_MODELS.fast, prompt);
      return { content: [{ type: "text", text: msg.trim() }] };
    }

    case "generate_unit_test": {
      const { file_path } = args as { file_path: string };
      const fullPath = assertPathSafe(file_path, "generate_unit_test");
      const content = await readFile(fullPath, "utf-8");
      const prompt = `Generate unit tests for:\n\`\`\`\n${content}\n\`\`\``;
      let testCode = await ollamaChat(OLLAMA_MODELS.powerful, prompt);
      testCode = testCode.replace(/^```\w*\n/, "").replace(/```$/, "").trim();

      // Validate LLM output before writing
      const originalLen = content.length;
      const testLen = testCode.length;
      if (testLen < originalLen * 0.3 || testLen > originalLen * 5) {
        throw new Error(`LLM test output length (${testLen}) is outside safe range (${Math.floor(originalLen * 0.3)}-${originalLen * 5} chars). File not written.`);
      }
      const metaPatterns = /^(Here is|I've added|I have|Note:|Sure|Certainly|Below is|The following)/mi;
      if (metaPatterns.test(testCode)) {
        throw new Error("LLM output contains meta-commentary instead of pure test code. File not written.");
      }

      let testPath = fullPath.replace(extname(fullPath), `.test${extname(fullPath)}`);
      let counter = 1;
      while (existsSync(testPath)) {
        testPath = fullPath.replace(extname(fullPath), `.test.${counter}${extname(fullPath)}`);
        counter++;
      }
      await writeFile(testPath, testCode, "utf-8");
      return { content: [{ type: "text", text: `Generated: ${testPath}` }] };
    }

    case "add_docstrings": {
      const { file_path } = args as { file_path: string };
      const fullPath = assertPathSafe(file_path, "add_docstrings");
      const content = await readFile(fullPath, "utf-8");

      // Create backup
      const backupPath = `${fullPath}.bak`;
      await writeFile(backupPath, content, "utf-8");

      const prompt = `Add docstrings to:\n${content}\nReturn FULL code only.`;
      let newCode = await ollamaChat(OLLAMA_MODELS.fast, prompt);
      newCode = newCode.replace(/^```\w*\n/, "").replace(/```$/, "").trim();

      // Validate LLM output before writing
      const originalLen = content.length;
      const newLen = newCode.length;
      if (newLen < originalLen * 0.5 || newLen > originalLen * 3) {
        throw new Error(`LLM output length (${newLen}) is outside safe range (${Math.floor(originalLen * 0.5)}-${originalLen * 3} chars). File not modified. Backup at: ${backupPath}`);
      }
      const metaPatterns = /^(Here is|I've added|I have added|Note:|Sure|Certainly|Below is|The following)/mi;
      if (metaPatterns.test(newCode)) {
        throw new Error(`LLM output contains meta-commentary instead of pure code. File not modified. Backup at: ${backupPath}`);
      }

      await writeFile(fullPath, newCode, "utf-8");
      return { content: [{ type: "text", text: `Updated ${file_path} (backup: ${backupPath})` }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
