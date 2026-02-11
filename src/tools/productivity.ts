// ========== Productivity Tools ==========

import { z } from "zod";
import { randomUUID } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { extname } from "path";
import { execFilePromise, MAX_INPUT_CHARS } from "../config.js";
import { getAllFiles, saveReviewToFile } from "../helpers/filesystem.js";
import { ollamaChat, DEFENSE_SYSTEM_PROMPT, encapsulateFileContent } from "../helpers/ollama.js";
import { validateLLMResponse } from "../helpers/response-validator.js";
import { runGeminiCLI, isGeminiCliAvailable, runGeminiWithFallback } from "../helpers/gemini.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { assertPathSafe } from "../security.js";
import { reviewSessions, discussionSessions } from "../state.js";
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

export const codeDiscussionSchema = z.object({
  topic: z.string().describe("Discussion topic (e.g., 'How to refactor auth to use JWT?', 'Best approach for caching')"),
  dir_path: z.string().optional().describe("Optional: directory with code to reference"),
  max_rounds: z.number().min(1).max(5).optional().default(3).describe("Maximum discussion rounds (1-5, default 3)"),
});

export const codeDiscussionContinueSchema = z.object({
  session_id: z.string().describe("Discussion session ID from code_discussion"),
  message: z.string().optional().describe("Claude's response to Gemini (required unless end=true)"),
  end: z.boolean().optional().default(false).describe("End the session and save conversation log"),
});

export const crossReviewSchema = z.object({
  file_paths: z.array(z.string()).optional().describe("Specific files to review. Provide either file_paths or dir_path."),
  dir_path: z.string().optional().describe("Directory to scan for source files (used when file_paths not provided)"),
  rules: z.array(z.string()).min(1).describe("Review rules both AIs must enforce (e.g., ['No hardcoding', 'DRY principle', 'All errors must be handled'])"),
  focus: z.string().optional().default("general").describe("Review focus area (e.g., 'security', 'performance')"),
});

export const validateChangesSchema = z.object({
  file_paths: z.array(z.string()).min(1).describe("Paths to modified files to validate"),
  rules: z.array(z.string()).min(1).describe("Rules the changes must comply with"),
  changes_description: z.string().describe("What was changed and why"),
  diff: z.string().optional().describe("Optional unified diff text for focused validation"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("todo_manager", "Manage a TODO.md file. Can list, add, or complete tasks.", todoManagerSchema),
  createToolDefinition("code_review", "Start a collaborative code review session with Gemini. Scans source files, sends to Gemini for initial review, returns review text and session_id. Use code_review_discuss to continue the discussion.", codeReviewSchema),
  createToolDefinition("code_review_discuss", "Continue or end a code review discussion with Gemini. Send follow-up messages, receive Gemini's responses. Full conversation history is maintained. Use end=true to save the conversation log.", codeReviewDiscussSchema),
  createToolDefinition("code_discussion", "Start a solution-focused discussion with Gemini. Unlike code_review (finds problems), this tool discusses HOW to solve problems: refactoring approaches, implementation strategies, architecture decisions. Returns session_id for continuing.", codeDiscussionSchema),
  createToolDefinition("code_discussion_continue", "Continue or end a solution discussion with Gemini. Debate implementation approaches, propose alternatives, work toward consensus. Use end=true to save the conversation log.", codeDiscussionContinueSchema),
  createToolDefinition("cross_review", "Adversarial parallel review: Gemini independently reviews code against the SAME rules Claude uses. Returns Gemini's rule-based findings for Claude to compare against its own review. Use when both AIs should check code with shared guidelines.", crossReviewSchema),
  createToolDefinition("validate_changes", "Post-modification validator: After Claude modifies code, Gemini validates the changes against specified rules. Returns PASS/FAIL verdict with specific rule violations. Use after code changes to ensure rule compliance.", validateChangesSchema),
  createToolDefinition("git_commit_helper", "Generate a commit message based on 'git diff'.", gitCommitHelperSchema),
  createToolDefinition("generate_unit_test", "Generate unit tests for a file.", generateUnitTestSchema),
  createToolDefinition("add_docstrings", "Add docstrings to a file.", addDocstringsSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  todo_manager: todoManagerSchema,
  code_review: codeReviewSchema,
  code_review_discuss: codeReviewDiscussSchema,
  code_discussion: codeDiscussionSchema,
  code_discussion_continue: codeDiscussionContinueSchema,
  cross_review: crossReviewSchema,
  validate_changes: validateChangesSchema,
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

// ===== Code Discussion Helpers (Solution-focused) =====
const DISCUSSION_TIMEOUT = 300_000; // 5 minutes
const MAX_CONCURRENT_DISCUSSIONS = 5;

function buildInitialDiscussionPrompt(topic: string, fileRefs: string, fileCount: number, maxRounds: number): string {
  const filesContext = fileCount > 0
    ? `\n\nRelevant code files (${fileCount}):\n${fileRefs}`
    : "";

  return `You are a senior software architect participating in a collaborative discussion with another architect (Claude). Your goal is to propose and debate SOLUTIONS, not just identify problems.

DISCUSSION TOPIC: ${topic}
${filesContext}

This is a solution-focused discussion. Please:
1. Propose a concrete approach to address the topic
2. Explain the trade-offs of your proposal
3. Consider alternatives and why you prefer your approach
4. If code changes are involved, describe the implementation strategy
5. Be specific about files, patterns, and technologies

This is round 1 of up to ${maxRounds} discussion rounds. Present your initial proposal.`;
}

function buildDiscussionFollowUpPrompt(
  topic: string,
  fileRefs: string,
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

  const filesContext = fileRefs ? `\n\nRelevant code:\n${fileRefs}` : "";

  return `You are continuing a solution-focused discussion with another architect (Claude).

TOPIC: ${topic}
${filesContext}

=== CONVERSATION HISTORY ===
${history.trim()}
=== END HISTORY ===

Claude's latest message:
${latestMessage}

Respond to Claude's points:
- If you agree with their approach, explain why and suggest refinements
- If you disagree, explain your concerns and propose an alternative
- If you see a better synthesis of both approaches, propose it
- Focus on actionable solutions, not theoretical debates

This is round ${round} of ${maxRounds}. Work toward a consensus on the best approach.`;
}

function buildDiscussionLog(session: {
  id: string;
  topic: string;
  dir_path?: string;
  source_files: string[];
  messages: Array<{ role: string; content: string; timestamp: string }>;
  round: number;
  max_rounds: number;
  created_at: number;
}): string {
  const startTime = new Date(session.created_at).toISOString();
  const endTime = new Date().toISOString();

  let log = `# Solution Discussion\n\n`;
  log += `**Session ID:** ${session.id}\n`;
  log += `**Topic:** ${session.topic}\n`;
  if (session.dir_path) {
    log += `**Directory:** ${session.dir_path}\n`;
  }
  if (session.source_files.length > 0) {
    log += `**Files Referenced:** ${session.source_files.length}\n`;
  }
  log += `**Rounds:** ${session.round}/${session.max_rounds}\n`;
  log += `**Started:** ${startTime}\n`;
  log += `**Ended:** ${endTime}\n\n`;
  log += `---\n\n`;

  if (session.source_files.length > 0) {
    log += `## Referenced Files\n\n`;
    for (const f of session.source_files) {
      log += `- ${f}\n`;
    }
    log += `\n---\n\n`;
  }

  log += `## Discussion\n\n`;
  let roundNum = 0;
  for (const msg of session.messages) {
    if (msg.role === "system") continue;
    if (msg.role === "gemini") {
      roundNum++;
      log += `### Round ${roundNum} — Gemini\n`;
      log += `*${msg.timestamp}*\n\n`;
      log += `${msg.content}\n\n---\n\n`;
    } else if (msg.role === "claude") {
      log += `### Round ${roundNum} — Claude\n`;
      log += `*${msg.timestamp}*\n\n`;
      log += `${msg.content}\n\n---\n\n`;
    }
  }

  return log;
}

// ===== Cross Review & Validation Helpers =====

function buildCrossReviewPrompt(fileRefs: string, rules: string[], focus: string, fileCount: number): string {
  const rulesBlock = rules.map((rule, i) => `  ${i + 1}. ${rule}`).join("\n");

  return `${fileRefs}

You are a strict code reviewer. Another reviewer (Claude) is reviewing the same code with the same rules. Your job is to provide an INDEPENDENT review.

============================
MANDATORY REVIEW RULES
============================
${rulesBlock}
============================

Review Focus: ${focus}
Files: ${fileCount} source file(s)

Instructions:
1. For EACH rule above, scan ALL files and report:
   - PASS: if the code complies (briefly explain why)
   - FAIL: if the code violates (cite specific file, line/section, and the violation)
2. After rule-by-rule analysis, provide a general code quality assessment:
   - Bugs or logical errors
   - Security concerns
   - Performance issues
   - Readability/maintainability
3. End with a summary:

## Rule Compliance

### Rule 1: [rule text]
**Status**: PASS | FAIL
**Details**: ...
**Location**: file:line (if FAIL)

(repeat for each rule)

## General Code Quality
(additional findings beyond the rules)

## Summary
- Rules: X/${rules.length} passed
- Verdict: PASS (all rules met) | FAIL (any rule violated)
- Critical issues: (count)`;
}

function buildValidateChangesPrompt(
  fileRefs: string,
  rules: string[],
  changesDescription: string,
  diff: string | undefined,
  fileCount: number,
): string {
  const rulesBlock = rules.map((rule, i) => `  ${i + 1}. ${rule}`).join("\n");

  const diffSection = diff
    ? `
============================
CHANGES DIFF
============================
${diff}
============================
`
    : "";

  return `${fileRefs}

You are a change validator. Another developer (Claude) modified code and you must verify the changes comply with ALL rules.

============================
WHAT WAS CHANGED
============================
${changesDescription}
============================
${diffSection}
============================
MANDATORY COMPLIANCE RULES
============================
${rulesBlock}
============================

Files modified: ${fileCount}

Instructions:
1. Read the modified files carefully.
2. If a diff is provided, focus on the CHANGED portions but also verify surrounding context.
3. For EACH rule, determine if the modifications comply:
   - PASS: The changes respect this rule
   - FAIL: The changes violate this rule (cite specific location and violation)
4. Check for regressions: did the changes introduce new bugs or break existing patterns?
5. Provide a final verdict.

## Validation Result

### Rule 1: [rule text]
**Status**: PASS | FAIL
**Details**: ...

(repeat for each rule)

## Regression Check
- New bugs introduced: yes/no (details)
- Broken patterns: yes/no (details)
- Code quality impact: improved/unchanged/degraded

## Verdict
**RESULT**: PASS | FAIL
**Violations**: (list if FAIL, or "None" if PASS)
**Suggestions**: (optional improvements)`;
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

    case "code_discussion": {
      const { topic, dir_path, max_rounds } = codeDiscussionSchema.parse(args);

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
              ],
            }, null, 2),
          }],
        };
      }

      // Check concurrent session limit
      const activeSessions = Array.from(discussionSessions.values()).filter(s => s.status === "active");
      if (activeSessions.length >= MAX_CONCURRENT_DISCUSSIONS) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "max_sessions_reached",
              message: `Maximum concurrent discussion sessions (${MAX_CONCURRENT_DISCUSSIONS}) reached. End an existing session first.`,
              active_sessions: activeSessions.map(s => ({ id: s.id, topic: s.topic, round: s.round })),
            }, null, 2),
          }],
        };
      }

      // Optionally scan for source files if dir_path provided
      let sourceFiles: string[] = [];
      let fileRefs = "";
      if (dir_path) {
        const fullPath = assertPathSafe(dir_path, "code_discussion");
        const allFiles = await getAllFiles(fullPath);
        sourceFiles = allFiles.filter(f => SOURCE_EXTENSIONS.includes(extname(f)));
        if (sourceFiles.length > 0) {
          fileRefs = sourceFiles.map(f => `@${f}`).join(" ");
        }
      }

      // Send initial discussion to Gemini
      const prompt = buildInitialDiscussionPrompt(topic, fileRefs, sourceFiles.length, max_rounds);

      let discussionResponse: string;
      try {
        discussionResponse = await runGeminiCLI([prompt], DISCUSSION_TIMEOUT);
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
      discussionSessions.set(sessionId, {
        id: sessionId,
        topic,
        dir_path,
        source_files: sourceFiles,
        messages: [
          { role: "system", content: `Discussion topic: ${topic}`, timestamp: now },
          { role: "gemini", content: discussionResponse, timestamp: now },
        ],
        round: 1,
        max_rounds,
        status: "active",
        created_at: Date.now(),
        last_activity: Date.now(),
      });

      const filesInfo = sourceFiles.length > 0 ? `Files: ${sourceFiles.length} source files\n` : "";

      return {
        content: [{
          type: "text",
          text: [
            `Session: ${sessionId}`,
            `Topic: ${topic}`,
            `Round: 1/${max_rounds}`,
            filesInfo,
            `--- Gemini's Initial Proposal ---`,
            ``,
            discussionResponse,
            ``,
            `---`,
            `Use code_discussion_continue(session_id="${sessionId}", message="your response") to continue.`,
          ].join("\n"),
        }],
      };
    }

    case "code_discussion_continue": {
      const { session_id, message, end } = codeDiscussionContinueSchema.parse(args);

      const session = discussionSessions.get(session_id);
      if (!session || session.status !== "active") {
        const active = Array.from(discussionSessions.values())
          .filter(s => s.status === "active")
          .map(s => ({ id: s.id, topic: s.topic, round: s.round }));
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
        const log = buildDiscussionLog(session);
        const logPath = await saveReviewToFile(log, "code_discussion");
        session.status = "completed";
        session.log_path = logPath;
        return {
          content: [{
            type: "text",
            text: `Session ended. Rounds: ${session.round}/${session.max_rounds}\nDiscussion log: ${logPath}`,
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
              message: "Maximum discussion rounds reached. Use end=true to save the discussion log.",
            }, null, 2),
          }],
        };
      }

      // Build follow-up prompt with full history
      const fileRefs = session.source_files.length > 0
        ? session.source_files.map(f => `@${f}`).join(" ")
        : "";
      const newRound = session.round + 1;
      const prompt = buildDiscussionFollowUpPrompt(session.topic, fileRefs, session.messages, message, newRound, session.max_rounds);

      let geminiResponse: string;
      try {
        geminiResponse = await runGeminiCLI([prompt], DISCUSSION_TIMEOUT);
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
        const log = buildDiscussionLog(session);
        const logPath = await saveReviewToFile(log, "code_discussion");
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
              `Session ended. Discussion log: ${logPath}`,
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

    case "cross_review": {
      const { file_paths, dir_path, rules, focus } = crossReviewSchema.parse(args);

      // Validate: at least one of file_paths or dir_path required
      if ((!file_paths || file_paths.length === 0) && !dir_path) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "invalid_input",
              message: "Either file_paths or dir_path must be provided.",
            }, null, 2),
          }],
        };
      }

      // Resolve target files
      let sourceFiles: string[];
      if (file_paths && file_paths.length > 0) {
        sourceFiles = file_paths.map(fp => assertPathSafe(fp, "cross_review"));
        const missing = sourceFiles.filter(f => !existsSync(f));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "files_not_found",
                missing_files: missing,
                message: `${missing.length} file(s) not found.`,
              }, null, 2),
            }],
          };
        }
      } else {
        const fullPath = assertPathSafe(dir_path!, "cross_review");
        const allFiles = await getAllFiles(fullPath);
        sourceFiles = allFiles.filter(f => SOURCE_EXTENSIONS.includes(extname(f)));
        if (sourceFiles.length === 0) {
          return { content: [{ type: "text", text: "No source files found in directory." }] };
        }
      }

      // Build prompt and call Gemini
      const fileRefs = sourceFiles.map(f => `@${f}`).join(" ");
      const prompt = buildCrossReviewPrompt(fileRefs, rules, focus!, sourceFiles.length);

      let reviewResponse: string;
      let source: "gemini" | "ollama";
      try {
        const result = await runGeminiWithFallback(prompt, CODE_REVIEW_TIMEOUT);
        reviewResponse = result.response;
        source = result.source;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "review_error",
              message: `Cross review failed: ${message}`,
              suggestions: [
                "Check Gemini authentication: gemini auth login",
                "Ensure Ollama is running for fallback",
                "Run health_check tool to diagnose",
              ],
            }, null, 2),
          }],
        };
      }

      // Save to .ai_reviews/
      const rulesForLog = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
      const logContent = [
        `# Cross Review`,
        ``,
        `**Date:** ${new Date().toISOString()}`,
        `**Focus:** ${focus}`,
        `**Source:** ${source}`,
        `**Files:** ${sourceFiles.length}`,
        ``,
        `## Rules`,
        rulesForLog,
        ``,
        `## Files Reviewed`,
        ...sourceFiles.map(f => `- ${f}`),
        ``,
        `## Gemini Review`,
        ``,
        reviewResponse,
      ].join("\n");
      const logPath = await saveReviewToFile(logContent, "cross_review");

      return {
        content: [{
          type: "text",
          text: [
            `Cross Review Complete`,
            `Files: ${sourceFiles.length} | Rules: ${rules.length} | Focus: ${focus}`,
            `Source: ${source} | Log: ${logPath}`,
            ``,
            `--- Gemini's Rule-Based Review ---`,
            ``,
            reviewResponse,
            ``,
            `---`,
            `Review saved to: ${logPath}`,
          ].join("\n"),
        }],
      };
    }

    case "validate_changes": {
      const { file_paths, rules, changes_description, diff } = validateChangesSchema.parse(args);

      // Validate paths
      const resolvedPaths = file_paths.map(fp => assertPathSafe(fp, "validate_changes"));
      const missing = resolvedPaths.filter(f => !existsSync(f));
      if (missing.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "files_not_found",
              missing_files: missing,
              message: `${missing.length} modified file(s) not found.`,
            }, null, 2),
          }],
        };
      }

      // Guard against oversized diff
      if (diff && diff.length > MAX_INPUT_CHARS) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "diff_too_large",
              message: `Diff text exceeds maximum size (${MAX_INPUT_CHARS} chars). Provide a shorter diff or omit it.`,
              diff_length: diff.length,
              max_length: MAX_INPUT_CHARS,
            }, null, 2),
          }],
        };
      }

      // Build prompt and call Gemini
      const fileRefs = resolvedPaths.map(f => `@${f}`).join(" ");
      const prompt = buildValidateChangesPrompt(fileRefs, rules, changes_description, diff, resolvedPaths.length);

      let validationResponse: string;
      let source: "gemini" | "ollama";
      try {
        const result = await runGeminiWithFallback(prompt, CODE_REVIEW_TIMEOUT);
        validationResponse = result.response;
        source = result.source;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "validation_error",
              message: `Validation failed: ${message}`,
              suggestions: [
                "Check Gemini authentication: gemini auth login",
                "Ensure Ollama is running for fallback",
                "Run health_check tool to diagnose",
              ],
            }, null, 2),
          }],
        };
      }

      // Extract verdict (best-effort)
      const verdictMatch = validationResponse.match(/\*\*RESULT\*\*:\s*(PASS|FAIL)/i);
      const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "UNKNOWN";

      // Save to .ai_reviews/
      const rulesForLog = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
      const logContent = [
        `# Change Validation`,
        ``,
        `**Date:** ${new Date().toISOString()}`,
        `**Verdict:** ${verdict}`,
        `**Source:** ${source}`,
        `**Files:** ${resolvedPaths.length}`,
        ``,
        `## Changes Description`,
        changes_description,
        ``,
        `## Rules`,
        rulesForLog,
        ``,
        diff ? `## Diff\n\`\`\`\n${diff}\n\`\`\`\n` : "",
        `## Files Validated`,
        ...resolvedPaths.map(f => `- ${f}`),
        ``,
        `## Validation Result`,
        ``,
        validationResponse,
      ].join("\n");
      const logPath = await saveReviewToFile(logContent, "validate_changes");

      return {
        content: [{
          type: "text",
          text: [
            `Validation ${verdict === "PASS" ? "PASSED" : verdict === "FAIL" ? "FAILED" : "Complete"}`,
            `Files: ${resolvedPaths.length} | Rules: ${rules.length} | Verdict: ${verdict}`,
            `Source: ${source} | Log: ${logPath}`,
            ``,
            `--- Validation Result ---`,
            ``,
            validationResponse,
            ``,
            `---`,
            `Result saved to: ${logPath}`,
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
