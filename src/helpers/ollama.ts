// ============================================
// Ollama API Helpers & Tool Calling
// ============================================

import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { OLLAMA_HOST, SHELL_TIMEOUT, execFilePromise } from "../config.js";
import type { OllamaTool, OllamaMessage } from "../types.js";
import { getEffectiveNumCtx } from "./profiler.js";
import { assertPathSafe, assertCommandAllowed, assertArgsAllowed } from "../security.js";
import { searchInFiles } from "./filesystem.js";
import { logger } from "../logger.js";

// ============================================
// Ollama Fetch with Timeout (AbortController)
// ============================================

const OLLAMA_TIMEOUTS = {
  default: 30_000,
  generate: 300_000,
  chat: 300_000,
  pull: 600_000,
} as const;

async function ollamaFetch(
  endpoint: string,
  body?: object,
  timeoutMs?: number
): Promise<any> {
  const url = `${OLLAMA_HOST}${endpoint}`;
  const timeout = timeoutMs ?? OLLAMA_TIMEOUTS.default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startTs = Date.now();

  try {
    const options: RequestInit = {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }
    logger.info({ event: "ollama_call", endpoint, timeout, duration_ms: Date.now() - startTs });
    return response.json();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.error({ event: "ollama_timeout", endpoint, timeout_ms: timeout });
      throw new Error(`Ollama timeout after ${timeout}ms on ${endpoint}`);
    }
    const errObj = err as { cause?: { code?: string }; code?: string };
    const causeCode = errObj.cause?.code || errObj.code;
    if (causeCode === "ECONNREFUSED" || causeCode === "ENOTFOUND" || causeCode === "UND_ERR_CONNECT_TIMEOUT") {
      throw new Error(
        `Ollama is not running at ${OLLAMA_HOST}. ` +
        `Install from https://ollama.com and ensure the Ollama service is running. ` +
        `Non-Ollama tools (filesystem, shell, diff, github, etc.) remain available.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make a generic request to the Ollama API.
 *
 * @param endpoint - API endpoint path (e.g., "/api/generate")
 * @param body - Optional request body object
 * @returns Response from Ollama API as JSON
 * @throws Error if Ollama server is unreachable or returns an error
 */
export async function ollamaRequest(endpoint: string, body?: object): Promise<any> {
  return ollamaFetch(endpoint, body);
}

/**
 * Send a chat message to Ollama and return the response.
 * Automatically injects optimal num_ctx from system profile.
 *
 * @param model - Ollama model name (e.g., "qwen2.5-coder:7b-instruct")
 * @param prompt - User prompt or message
 * @param system - Optional system prompt (default: "You are a helpful assistant.")
 * @param options - Optional generation parameters (temperature, num_ctx, etc.)
 * @returns Generated text response from the model
 * @throws Error if Ollama server is unreachable
 */
export async function ollamaChat(
  model: string,
  prompt: string,
  system?: string,
  options?: Record<string, unknown>
): Promise<string> {
  // Auto-inject optimal num_ctx from system profile
  const effectiveOptions: Record<string, unknown> = options ? { ...options } : {};
  if (!effectiveOptions.num_ctx) {
    const optimalNumCtx = await getEffectiveNumCtx(model);
    if (optimalNumCtx) effectiveOptions.num_ctx = optimalNumCtx;
  }

  const body: Record<string, unknown> = {
    model,
    prompt,
    system: system || "You are a helpful assistant.",
    stream: false,
  };
  if (Object.keys(effectiveOptions).length > 0) {
    body.options = effectiveOptions;
  }

  const result = await ollamaFetch("/api/generate", body, OLLAMA_TIMEOUTS.generate);
  return result.response;
}

// ============================================
// Ollama Tool Calling
// ============================================

export const REACT_SYSTEM_PROMPT = `You are an AI agent with access to tools. Follow the ReAct framework for every task:

1. **Thought**: Reason about what information you need and which tool to use next.
2. **Action**: Call the appropriate tool with correct arguments.
3. **Observation**: Analyze the tool's output carefully.
4. **Repeat** steps 1-3 if more information or actions are needed.
5. **Final Answer**: Provide a comprehensive response based on all observations.

Rules:
- Always think before acting. Explain your reasoning briefly.
- Use tools to verify information rather than guessing.
- If a tool returns an error, analyze the error and try a different approach.
- When reading files, check they exist first using list_directory.
- When writing files, read the current content first to understand context.
- For run_command, only use allowed commands. If a command is blocked, explain the limitation.
- Be thorough but efficient. Minimize unnecessary tool calls.
- Provide your final answer only after gathering all needed information.`;

export const OLLAMA_AGENT_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path to read" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files in a directory",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Directory path" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files containing a pattern",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)" },
          path: { type: "string", description: "Directory to search in (default: current)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Content to write" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Command to execute" },
          args: { type: "string", description: "Command arguments (space-separated)" },
        },
      },
    },
  },
];

/**
 * Execute a tool call from the Ollama agent.
 * Supports file operations (read, write, list) and command execution with security checks.
 *
 * @param name - Tool name (read_file, list_directory, search_files, write_file, run_command)
 * @param args - Tool-specific arguments
 * @returns Tool execution result as a string
 * @throws Error if path safety checks fail or command is not allowed
 */
export async function executeAgentTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const fullPath = assertPathSafe(args.path, "read");
        if (!existsSync(fullPath)) return `Error: File not found: ${args.path}`;
        return await readFile(fullPath, "utf-8");
      }
      case "list_directory": {
        const fullPath = assertPathSafe(args.path || ".", "list_directory");
        if (!existsSync(fullPath)) return `Error: Directory not found: ${args.path}`;
        return (await readdir(fullPath)).join("\n");
      }
      case "search_files": {
        const searchPath = assertPathSafe(args.path || ".", "search_files");
        const results = await searchInFiles(searchPath, args.pattern);
        return results.length > 0 ? results.join("\n") : "No matches found.";
      }
      case "write_file": {
        const fullPath = assertPathSafe(args.path, "write");
        await writeFile(fullPath, args.content, "utf-8");
        return `Successfully wrote to ${args.path}`;
      }
      case "run_command": {
        assertCommandAllowed(args.command);
        const cmdArgs = args.args
          ? (args.args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((a: string) => a.replace(/^["']|["']$/g, ""))
          : [];
        assertArgsAllowed(args.command, cmdArgs);
        const { stdout, stderr } = await execFilePromise(args.command, cmdArgs, { timeout: SHELL_TIMEOUT });
        return stdout || stderr || "(no output)";
      }
      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/**
 * Run a ReAct-style agent loop with tool calling support.
 * Iteratively calls tools until the agent provides a final answer or max iterations reached.
 *
 * @param model - Ollama model name with tool-calling support
 * @param prompt - User task or question
 * @param options - Optional configuration (system prompt, tools, max iterations)
 * @returns Agent response and history of tool calls
 * @throws Error if Ollama server is unreachable or tool execution fails
 */
export async function ollamaChatWithTools(
  model: string,
  prompt: string,
  options?: {
    system?: string;
    tools?: OllamaTool[];
    maxIterations?: number;
  }
): Promise<{ response: string; toolCalls: Array<{ tool: string; args: any; result: string }> }> {
  const tools = options?.tools || OLLAMA_AGENT_TOOLS;
  const maxIterations = options?.maxIterations || 5;
  const toolCallHistory: Array<{ tool: string; args: any; result: string }> = [];

  const messages: OllamaMessage[] = [
    { role: "system", content: options?.system || REACT_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  for (let i = 0; i < maxIterations; i++) {
    // Auto-inject optimal num_ctx from system profile
    const chatEffectiveOptions: Record<string, unknown> = {};
    const optimalCtx = await getEffectiveNumCtx(model);
    if (optimalCtx) chatEffectiveOptions.num_ctx = optimalCtx;

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      tools,
      stream: false,
    };
    if (Object.keys(chatEffectiveOptions).length > 0) {
      requestBody.options = chatEffectiveOptions;
    }

    const result = await ollamaFetch("/api/chat", requestBody, OLLAMA_TIMEOUTS.chat);
    const assistantMessage = result.message;

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return { response: assistantMessage.content, toolCalls: toolCallHistory };
    }

    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;
      const toolResult = await executeAgentTool(toolName, toolArgs);

      toolCallHistory.push({ tool: toolName, args: toolArgs, result: toolResult });

      messages.push({
        role: "tool",
        content: toolResult,
      });
    }
  }

  return { response: "(Max iterations reached)", toolCalls: toolCallHistory };
}

/**
 * Generate embeddings for a text using Ollama's embedding models.
 *
 * @param model - Embedding model name (e.g., "nomic-embed-text")
 * @param text - Text to embed
 * @returns Vector embedding as an array of numbers
 * @throws Error if Ollama server is unreachable or model not found
 */
export async function ollamaEmbeddings(model: string, text: string): Promise<number[]> {
  const result = await ollamaFetch("/api/embeddings", { model, prompt: text });
  return result.embedding;
}

/**
 * Download a model from the Ollama library.
 *
 * @param model - Model name to download (e.g., "qwen2.5-coder:7b-instruct")
 * @returns Success message
 * @throws Error if Ollama server is unreachable or download fails
 */
export async function ollamaPull(model: string): Promise<string> {
  await ollamaFetch("/api/pull", { name: model, stream: false }, OLLAMA_TIMEOUTS.pull);
  return `Model ${model} pulled successfully`;
}

/**
 * Get model information including parameters, template, and license.
 *
 * @param model - Model name to query
 * @returns Model metadata object
 * @throws Error if Ollama server is unreachable or model not found
 */
export async function ollamaShow(model: string): Promise<any> {
  return ollamaFetch("/api/show", { name: model });
}
