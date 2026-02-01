// ========== Productivity Tools ==========

import { z } from "zod";
import { randomUUID } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { extname } from "path";
import { execFilePromise } from "../config.js";
import { getAllFiles, saveReviewToFile } from "../helpers/filesystem.js";
import { ollamaChat, DEFENSE_SYSTEM_PROMPT, encapsulateFileContent } from "../helpers/ollama.js";
import { validateLLMResponse } from "../helpers/response-validator.js";
import { runGeminiCLI, isGeminiCliAvailable } from "../helpers/gemini.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { assertPathSafe } from "../security.js";
import { reviewSessions } from "../state.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const todoManagerSchema = z.object({
  action: z.enum(["list", "add", "complete"]).describe("Action to perform"),
  task: z.string().optional().describe("Task description (for 'add')"),
  index: z.number().optional().describe("Task index (for 'complete')"),
});

export const codeReviewSchema = z.object({
  dir_path: z.string().optional().default(".").describe("Directory to review"),
  focus: z.string().optional().default("general").describe("Review focus area"),
  max_rounds: z.number().min(1).max(5).optional().default(3).describe("Maximum discussion rounds (1-5, default 3)"),
});

export const gitCommitHelperSchema = z.object({});

export const generateUnitTestSchema = z.object({
  file_path: z.string(),
});

export const addDocstringsSchema = z.object({
  file_path: z.string(),
});

export const codeReviewDiscussSchema = z.object({
  session_id: z.string().describe("Review session ID from code_review"),
  message: z.string().optional().describe("Claude's follow-up message to Gemini (required unless end=true)"),
  end: z.boolean().optional().default(false).describe("End the session and save conversation log"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("todo_manager", "Manage a TODO.md file. Can list, add, or complete tasks.", todoManagerSchema),
  createToolDefinition("code_review", "Start a collaborative code review session with Gemini. Scans source files, sends to Gemini for initial review, returns review text and session_id. Use code_review_discuss to continue the discussion.", codeReviewSchema),
  createToolDefinition("code_review_discuss", "Continue or end a code review discussion with Gemini. Send follow-up messages, receive Gemini's responses. Full conversation history is maintained. Use end=true to save the conversation log.", codeReviewDiscussSchema),
  createToolDefinition("git_commit_helper", "Generate a commit message based on 'git diff'.", gitCommitHelperSchema),
  createToolDefinition("generate_unit_test", "Generate unit tests for a file.", generateUnitTestSchema),
  createToolDefinition("add_docstrings", "Add docstrings to a file.", addDocstringsSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  todo_manager: todoManagerSchema,
  code_review: codeReviewSchema,
  code_review_discuss: codeReviewDiscussSchema,
  git_commit_helper: gitCommitHelperSchema,
  generate_unit_test: generateUnitTestSchema,
  add_docstrings: addDocstringsSchema,
};

// ===== Code Review Helpers =====
const CODE_REVIEW_TIMEOUT = 300_000; // 5 minutes
const MAX_CONCURRENT_SESSIONS = 5;
const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".java", ".c", ".cpp", ".rs", ".html", ".css", ".json"];

function buildInitialReviewPrompt(fileRefs: string, focus: string, dirPath: string, fileCount: number, maxRounds: number): string {
  return `${fileRefs}

You are a senior code reviewer conducting a collaborative code review with another reviewer (Claude). They will respond to your findings and may raise additional points.

Review Focus: ${focus}
Directory: ${dirPath}
Files: ${fileCount} source files

Provide a comprehensive initial code review covering:
1. Critical issues (bugs, security vulnerabilities)
2. Code quality concerns (readability, maintainability)
3. Architecture and design suggestions
4. Best practices violations
5. Performance concerns

Be specific with file names and line references. This is round 1 of up to ${maxRounds} discussion rounds.`;
}

function buildFollowUpPrompt(
  fileRefs: string,
  focus: string,
  messages: Array<{ role: string; content: string }>,
  latestMessage: string,
  round: number,
  maxRounds: number,
): string {
  let history = "";
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const label = msg.role === "gemini" ? "Gemini" : "Claude";
    history += `[${label}]:\n${msg.content}\n\n`;
  }

  return `${fileRefs}

You are continuing a code review discussion with another reviewer (Claude).
Review Focus: ${focus}

=== CONVERSATION HISTORY ===
${history.trim()}
=== END HISTORY ===

Claude's latest message:
${latestMessage}

Respond to Claude's points. If you agree, say so. If you disagree, explain why with code references. Work toward a consensus. This is round ${round} of ${maxRounds}.`;
}

function buildConversationLog(session: {
  id: string;
  dir_path: string;
  focus: string;
  source_files: string[];
  messages: Array<{ role: string; content: string; timestamp: string }>;
  round: number;
  max_rounds: number;
  created_at: number;
}): string {
  const startTime = new Date(session.created_at).toISOString();
  const endTime = new Date().toISOString();

  let log = `# Collaborative Code Review\n\n`;
  log += `**Session ID:** ${session.id}\n`;
  log += `**Directory:** ${session.dir_path}\n`;
  log += `**Focus:** ${session.focus}\n`;
  log += `**Files Reviewed:** ${session.source_files.length}\n`;
  log += `**Rounds:** ${session.round}/${session.max_rounds}\n`;
  log += `**Started:** ${startTime}\n`;
  log += `**Ended:** ${endTime}\n\n`;
  log += `---\n\n`;
  log += `## Files\n\n`;
  for (const f of session.source_files) {
    log += `- ${f}\n`;
  }
  log += `\n---\n\n`;

  let roundNum = 0;
  for (const msg of session.messages) {
    if (msg.role === "system") continue;
    if (msg.role === "gemini") {
      roundNum++;
      log += `## Round ${roundNum} — Gemini\n`;
      log += `*${msg.timestamp}*\n\n`;
      log += `${msg.content}\n\n---\n\n`;
    } else if (msg.role === "claude") {
      log += `## Round ${roundNum + 1} — Claude\n`;
      log += `*${msg.timestamp}*\n\n`;
      log += `${msg.content}\n\n`;
    }
  }

  return log;
}

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "todo_manager": {
      const { action, task, index } = todoManagerSchema.parse(args);
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
      const { dir_path, focus, max_rounds } = codeReviewSchema.parse(args);
      const fullPath = assertPathSafe(dir_path, "code_review");

      // Check Gemini availability
      const geminiCheck = await isGeminiCliAvailable();
      if (!geminiCheck.available) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "gemini_not_found",
              message: geminiCheck.message,
              suggestions: [
                "Install Gemini CLI: npm install -g @google/gemini-cli",
                "Run health_check tool to verify installation",
                "Review without Gemini: Claude can review the code directly",
              ],
            }, null, 2),
          }],
        };
      }

      // Check concurrent session limit
      const activeSessions = Array.from(reviewSessions.values()).filter(s => s.status === "active");
      if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "max_sessions_reached",
              message: `Maximum concurrent review sessions (${MAX_CONCURRENT_SESSIONS}) reached. End an existing session first.`,
              active_sessions: activeSessions.map(s => ({ id: s.id, focus: s.focus, round: s.round })),
            }, null, 2),
          }],
        };
      }

      // Scan for source files
      const allFiles = await getAllFiles(fullPath);
      const sourceFiles = allFiles.filter(f => SOURCE_EXTENSIONS.includes(extname(f)));
      if (sourceFiles.length === 0) {
        return { content: [{ type: "text", text: "No source files found in directory." }] };
      }

      // Send initial review to Gemini
      const fileRefs = sourceFiles.map(f => `@${f}`).join(" ");
      const prompt = buildInitialReviewPrompt(fileRefs, focus, dir_path, sourceFiles.length, max_rounds);

      let reviewResponse: string;
      try {
        reviewResponse = await runGeminiCLI([prompt], CODE_REVIEW_TIMEOUT);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "gemini_error",
              message: `Gemini CLI failed: ${message}`,
              suggestions: [
                "Check Gemini authentication: gemini auth login",
                "Run health_check tool to diagnose",
              ],
            }, null, 2),
          }],
        };
      }

      // Create session
      const sessionId = randomUUID();
      const now = new Date().toISOString();
      reviewSessions.set(sessionId, {
        id: sessionId,
        dir_path,
        focus,
        source_files: sourceFiles,
        messages: [
          { role: "system", content: `Code review focus: ${focus}`, timestamp: now },
          { role: "gemini", content: reviewResponse, timestamp: now },
        ],
        round: 1,
        max_rounds,
        status: "active",
        created_at: Date.now(),
        last_activity: Date.now(),
      });

      return {
        content: [{
          type: "text",
          text: [
            `Session: ${sessionId}`,
            `Round: 1/${max_rounds}`,
            `Files: ${sourceFiles.length} source files`,
            `Focus: ${focus}`,
            ``,
            `--- Gemini's Initial Review ---`,
            ``,
            reviewResponse,
            ``,
            `---`,
            `Use code_review_discuss(session_id="${sessionId}") to continue or end the discussion.`,
          ].join("\n"),
        }],
      };
    }

    case "code_review_discuss": {
      const { session_id, message, end } = codeReviewDiscussSchema.parse(args);

      const session = reviewSessions.get(session_id);
      if (!session || session.status !== "active") {
        const active = Array.from(reviewSessions.values())
          .filter(s => s.status === "active")
          .map(s => ({ id: s.id, focus: s.focus, round: s.round }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "session_not_found",
              session_id,
              message: "Session not found or expired.",
              active_sessions: active,
            }, null, 2),
          }],
        };
      }

      // End without message — just save log
      if (end && !message) {
        const log = buildConversationLog(session);
        const logPath = await saveReviewToFile(log, "code_review_collab");
        session.status = "completed";
        session.log_path = logPath;
        return {
          content: [{
            type: "text",
            text: `Session ended. Rounds: ${session.round}/${session.max_rounds}\nConversation log: ${logPath}`,
          }],
        };
      }

      if (!message) {
        throw new Error("'message' is required when end=false.");
      }

      // Check round limit
      if (session.round >= session.max_rounds) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "max_rounds_reached",
              session_id,
              rounds_used: session.round,
              max_rounds: session.max_rounds,
              message: "Maximum discussion rounds reached. Use end=true to save the conversation log.",
            }, null, 2),
          }],
        };
      }

      // Build follow-up prompt with full history
      const fileRefs = session.source_files.map(f => `@${f}`).join(" ");
      const newRound = session.round + 1;
      const prompt = buildFollowUpPrompt(fileRefs, session.focus, session.messages, message, newRound, session.max_rounds);

      let geminiResponse: string;
      try {
        geminiResponse = await runGeminiCLI([prompt], CODE_REVIEW_TIMEOUT);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "gemini_error",
              session_id,
              round: session.round,
              message: `Gemini failed: ${errMsg}. Session preserved — retry the same message or end the session.`,
            }, null, 2),
          }],
        };
      }

      // Update session
      const now = new Date().toISOString();
      session.messages.push(
        { role: "claude", content: message, timestamp: now },
        { role: "gemini", content: geminiResponse, timestamp: now },
      );
      session.round = newRound;
      session.last_activity = Date.now();

      // End with final message
      if (end) {
        const log = buildConversationLog(session);
        const logPath = await saveReviewToFile(log, "code_review_collab");
        session.status = "completed";
        session.log_path = logPath;
        return {
          content: [{
            type: "text",
            text: [
              `Session: ${session_id} — Final round`,
              `Round: ${newRound}/${session.max_rounds}`,
              ``,
              `--- Gemini's Response ---`,
              ``,
              geminiResponse,
              ``,
              `---`,
              `Session ended. Conversation log: ${logPath}`,
            ].join("\n"),
          }],
        };
      }

      // Ongoing discussion
      const remaining = session.max_rounds - newRound;
      return {
        content: [{
          type: "text",
          text: [
            `Session: ${session_id}`,
            `Round: ${newRound}/${session.max_rounds}`,
            ``,
            `--- Gemini's Response ---`,
            ``,
            geminiResponse,
            ``,
            `---`,
            `${remaining} round${remaining !== 1 ? "s" : ""} remaining.`,
          ].join("\n"),
        }],
      };
    }

    case "git_commit_helper": {
      gitCommitHelperSchema.parse(args);
      let diff: string;
      try {
        diff = (await execFilePromise("git", ["diff", "--staged"])).stdout || (await execFilePromise("git", ["diff"])).stdout;
      } catch { throw new Error("Not a git repo or no git detected."); }
      if (!diff.trim()) return { content: [{ type: "text", text: "No changes to commit." }] };

      const prompt = `Generate a conventional commit message for:\n${diff.substring(0, 4000)}`;
      const { text: msg, model: usedModel } = await ollamaChat(OLLAMA_MODELS.fast, prompt);
      return { content: [{ type: "text", text: `${msg.trim()}\n\n---\n[model: ${usedModel}]` }] };
    }

    case "generate_unit_test": {
      const { file_path } = generateUnitTestSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "generate_unit_test");
      const content = await readFile(fullPath, "utf-8");
      const encapsulated = encapsulateFileContent(content, file_path);
      const prompt = `Generate unit tests for the following source code.\n\n${encapsulated}`;
      const testResult = await ollamaChat(OLLAMA_MODELS.powerful, prompt, DEFENSE_SYSTEM_PROMPT);
      let testCode = testResult.text.replace(/^```\w*\n/, "").replace(/```$/, "").trim();

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

      const validation = validateLLMResponse(testCode, "generate_unit_test");
      if (!validation.safe) {
        throw new Error(
          `LLM output contains suspicious patterns: ${validation.issues.map(i => i.pattern).join(", ")}. File not written.`
        );
      }

      let testPath = fullPath.replace(extname(fullPath), `.test${extname(fullPath)}`);
      let counter = 1;
      while (existsSync(testPath)) {
        testPath = fullPath.replace(extname(fullPath), `.test.${counter}${extname(fullPath)}`);
        counter++;
      }
      await writeFile(testPath, testCode, "utf-8");
      const preview = testCode.split("\n").slice(0, 5).join("\n");
      return { content: [{ type: "text", text: `Generated: ${testPath}\n[model: ${testResult.model}]\n\nPreview:\n${preview}\n...` }] };
    }

    case "add_docstrings": {
      const { file_path } = addDocstringsSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "add_docstrings");
      const content = await readFile(fullPath, "utf-8");

      // Create backup
      const backupPath = `${fullPath}.bak`;
      await writeFile(backupPath, content, "utf-8");

      const encapsulated = encapsulateFileContent(content, file_path);
      const prompt = `Add docstrings to the following code. Return FULL code only, no explanations.\n\n${encapsulated}`;
      const docResult = await ollamaChat(OLLAMA_MODELS.fast, prompt, DEFENSE_SYSTEM_PROMPT);
      let newCode = docResult.text.replace(/^```\w*\n/, "").replace(/```$/, "").trim();

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

      const validation = validateLLMResponse(newCode, "add_docstrings");
      if (!validation.safe) {
        throw new Error(
          `LLM output contains suspicious patterns: ${validation.issues.map(i => i.pattern).join(", ")}. File not modified. Backup at: ${backupPath}`
        );
      }

      await writeFile(fullPath, newCode, "utf-8");
      return { content: [{ type: "text", text: `Updated ${file_path} (backup: ${backupPath})\n[model: ${docResult.model}]` }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
