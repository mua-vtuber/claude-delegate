// ========== LLM Tools ==========

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { ollamaChat, ollamaRequest, ollamaChatWithTools, ollamaEmbeddings, ollamaPull, ollamaShow, REACT_SYSTEM_PROMPT } from "../helpers/ollama.js";
import { runGeminiCLI, runGeminiWithFallback } from "../helpers/gemini.js";
import { selectOllamaModel, estimateComplexity } from "../helpers/routing.js";
import { saveReviewToFile } from "../helpers/filesystem.js";
import { assertPathSafe } from "../security.js";
import { MAX_INPUT_CHARS, MODEL_AUTO } from "../config.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "ollama_chat",
    description: "Chat with Ollama.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", default: MODEL_AUTO },
        system: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "ollama_analyze_file",
    description: "Analyze a file using Ollama. MCP reads the file and sends to Ollama, so Claude doesn't consume tokens for file content.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to file to analyze" },
        question: { type: "string", description: "What to analyze (e.g., 'Find bugs', 'Explain this code')" },
        save_to_file: { type: "boolean", default: true, description: "Save result to .ai_reviews/ folder" },
      },
      required: ["file_path", "question"],
    },
  },
  {
    name: "ollama_analyze_files",
    description: "Analyze multiple files using Ollama. Returns file path to review document.",
    inputSchema: {
      type: "object",
      properties: {
        file_paths: { type: "array", items: { type: "string" }, description: "Paths to files" },
        question: { type: "string", description: "What to analyze" },
      },
      required: ["file_paths", "question"],
    },
  },
  {
    name: "ollama_list_models",
    description: "List Ollama models.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ollama_agent",
    description: "Ollama agent with tool calling. Can read/write files, search, and run commands autonomously. Use for complex tasks that require multiple steps.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description for the agent" },
        model: { type: "string", default: MODEL_AUTO, description: "Model to use (auto selects based on complexity)" },
        max_iterations: { type: "number", default: 5, description: "Maximum tool call iterations" },
      },
      required: ["task"],
    },
  },
  {
    name: "gemini_ask",
    description: "Ask Gemini CLI.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
  {
    name: "gemini_analyze_codebase",
    description: "Analyze codebase with Gemini (1M context). Saves result to .ai_reviews/ and returns file path.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        question: { type: "string" },
      },
      required: ["paths"],
    },
  },
  {
    name: "smart_ask",
    description: "Auto-route to Ollama or Gemini.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        force_model: { type: "string", enum: ["ollama", "gemini", MODEL_AUTO], default: MODEL_AUTO },
      },
      required: ["prompt"],
    },
  },
  {
    name: "ollama_embeddings",
    description: "Generate text embeddings using Ollama.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", default: "nomic-embed-text" },
        text: { type: "string", description: "Text to embed" },
      },
      required: ["text"],
    },
  },
  {
    name: "ollama_pull",
    description: "Download a model from Ollama library.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Model name to pull" } },
      required: ["model"],
    },
  },
  {
    name: "ollama_show",
    description: "Show details of an Ollama model.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Model name" } },
      required: ["model"],
    },
  },
  {
    name: "compare_models",
    description: "Compare responses from Ollama and Gemini for the same prompt.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "Prompt to send to both models" } },
      required: ["prompt"],
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "ollama_chat": {
      const { prompt, model, system } = args as { prompt: string; model?: string; system?: string };
      if (prompt.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }
      const { model: selected } = selectOllamaModel(prompt, model);
      const res = await ollamaChat(selected, prompt, system);
      return { content: [{ type: "text", text: res }] };
    }
    case "ollama_analyze_file": {
      const { file_path, question, save_to_file = true } = args as { file_path: string; question: string; save_to_file?: boolean };
      const fullPath = assertPathSafe(file_path, "analyze_file");
      if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);

      const fileContent = await readFile(fullPath, "utf-8");
      if (fileContent.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }
      const prompt = `Analyze the following file and answer: ${question}\n\nFile: ${file_path}\n\`\`\`\n${fileContent}\n\`\`\``;

      const { model: selected } = selectOllamaModel(prompt);
      const response = await ollamaChat(selected, prompt);

      if (save_to_file) {
        const reviewPath = await saveReviewToFile(`# Ollama Analysis\n\n**File:** ${file_path}\n**Question:** ${question}\n**Model:** ${selected}\n\n---\n\n${response}`, "ollama_analysis");
        return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}\n\nUse Read tool to view the full analysis.` }] };
      }
      return { content: [{ type: "text", text: response }] };
    }
    case "ollama_analyze_files": {
      const { file_paths, question } = args as { file_paths: string[]; question: string };
      const fileContents: string[] = [];
      let totalSize = 0;

      for (const fp of file_paths) {
        const fullPath = assertPathSafe(fp, "analyze_files");
        if (existsSync(fullPath)) {
          const content = await readFile(fullPath, "utf-8");
          totalSize += content.length;
          if (totalSize > MAX_INPUT_CHARS) {
            throw new Error(`Combined input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please reduce the number of files.`);
          }
          fileContents.push(`### File: ${fp}\n\`\`\`\n${content}\n\`\`\``);
        }
      }

      if (fileContents.length === 0) throw new Error("No valid files found");

      const prompt = `Analyze the following files and answer: ${question}\n\n${fileContents.join("\n\n")}`;
      const { model: selected } = selectOllamaModel(prompt);
      const response = await ollamaChat(selected, prompt);

      const reviewPath = await saveReviewToFile(`# Ollama Multi-File Analysis\n\n**Files:** ${file_paths.join(", ")}\n**Question:** ${question}\n**Model:** ${selected}\n\n---\n\n${response}`, "ollama_multi_analysis");
      return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}\n\nUse Read tool to view the full analysis.` }] };
    }
    case "gemini_ask": {
      const { prompt } = args as { prompt: string };
      const { response, source } = await runGeminiWithFallback(prompt);
      const prefix = source === "ollama" ? "[Fallback: Ollama]\n\n" : "";
      return { content: [{ type: "text", text: prefix + response }] };
    }
    case "gemini_analyze_codebase": {
      const { paths, question = "Analyze this codebase" } = args as { paths: string[]; question?: string };
      const fileRefs = paths.map((p: string) => `@${resolve(p)}`).join(" ");
      const { response, source } = await runGeminiWithFallback(`${fileRefs} ${question}`, 300000);

      // Save to file
      const sourceNote = source === "ollama" ? " (Ollama fallback)" : "";
      const reviewPath = await saveReviewToFile(`# Gemini Analysis${sourceNote}\n\n**Question:** ${question}\n**Files:** ${paths.join(", ")}\n\n---\n\n${response}`, "gemini_analysis");
      return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}${source === "ollama" ? " (used Ollama fallback)" : ""}\n\nUse Read tool to view the full analysis.` }] };
    }
    case "ollama_list_models": {
      const res = await ollamaRequest("/api/tags");
      return { content: [{ type: "text", text: JSON.stringify(res.models, null, 2) }] };
    }
    case "ollama_agent": {
      const { task, model, max_iterations = 5 } = args as { task: string; model?: string; max_iterations?: number };
      const { model: selectedModel } = selectOllamaModel(task, model, "agent");

      const result = await ollamaChatWithTools(selectedModel, task, {
        maxIterations: max_iterations,
        system: REACT_SYSTEM_PROMPT,
      });

      let output = `## Agent Response\n\n${result.response}`;
      if (result.toolCalls.length > 0) {
        output += `\n\n## Tool Calls (${result.toolCalls.length})\n`;
        result.toolCalls.forEach((tc, i) => {
          output += `\n### ${i + 1}. ${tc.tool}\n`;
          output += `**Args:** \`${JSON.stringify(tc.args)}\`\n`;
          output += `**Result:** ${tc.result.substring(0, 500)}${tc.result.length > 500 ? "..." : ""}\n`;
        });
      }

      return { content: [{ type: "text", text: output }] };
    }
    case "smart_ask": {
      const { prompt, force_model } = args as { prompt: string; force_model?: string };
      const complexity = estimateComplexity(prompt);
      const preferGemini = force_model === "gemini" || (force_model === MODEL_AUTO && complexity === "high");

      if (preferGemini) {
        const { response, source } = await runGeminiWithFallback(prompt);
        return { content: [{ type: "text", text: `[Routing: ${source === "gemini" ? "Gemini" : "Ollama (fallback)"}]\n\n${response}` }] };
      } else {
        const res = await ollamaChat(selectOllamaModel(prompt).model, prompt);
        return { content: [{ type: "text", text: `[Routing: Ollama]\n\n${res}` }] };
      }
    }
    case "ollama_embeddings": {
      const { model = "nomic-embed-text", text } = args as { model?: string; text: string };
      const embedding = await ollamaEmbeddings(model, text);
      return { content: [{ type: "text", text: JSON.stringify(embedding) }] };
    }
    case "ollama_pull": {
      const { model } = args as { model: string };
      const result = await ollamaPull(model);
      return { content: [{ type: "text", text: result }] };
    }
    case "ollama_show": {
      const { model } = args as { model: string };
      const info = await ollamaShow(model);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
    case "compare_models": {
      const { prompt } = args as { prompt: string };
      const [ollamaRes, geminiRes] = await Promise.all([
        ollamaChat(selectOllamaModel(prompt).model, prompt).catch(e => `Ollama Error: ${(e as Error).message}`),
        runGeminiCLI([prompt]).catch(e => `Gemini Error: ${(e as Error).message}`)
      ]);
      const comparison = `## Ollama Response:\n${ollamaRes}\n\n---\n\n## Gemini Response:\n${geminiRes}`;
      return { content: [{ type: "text", text: comparison }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
