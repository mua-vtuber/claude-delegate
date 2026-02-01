// ========== LLM Utility Tools ==========

import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { promptTemplates, responseCache } from "../state.js";
import { ollamaChat } from "../helpers/ollama.js";
import { runGeminiCLI } from "../helpers/gemini.js";
import { OLLAMA_MODELS, selectOllamaModel } from "../helpers/routing.js";
import { saveReviewToFile } from "../helpers/filesystem.js";
import { assertPathSafe } from "../security.js";
import { MAX_INPUT_CHARS, MODEL_AUTO } from "../config.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const promptTemplateSchema = z.object({
  action: z.enum(["save", "get", "list", "apply", "delete"]).describe("Action to perform"),
  name: z.string().optional().describe("Template name"),
  template: z.string().optional().describe("Template content with {{variable}} placeholders"),
  variables: z.record(z.string(), z.unknown()).optional().describe("Variables to substitute when applying"),
});

export const responseCacheSchema = z.object({
  action: z.enum(["get", "set", "clear", "stats"]).describe("Action"),
  key: z.string().optional().describe("Cache key (usually the prompt hash)"),
  value: z.string().optional().describe("Response to cache"),
  ttl: z.number().optional().default(3600).describe("Time-to-live in seconds"),
});

export const tokenCountSchema = z.object({
  text: z.string().describe("Text to count tokens for"),
  model: z.enum(["gpt", "claude", "llama"]).optional().default("gpt").describe("Model family for estimation"),
});

export const translateTextSchema = z.object({
  text: z.string().describe("Text to translate"),
  target_lang: z.string().describe("Target language (e.g., 'Korean', 'English', 'Japanese')"),
  source_lang: z.string().optional().describe("Source language (auto-detect if not provided)"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
});

export const translateFileSchema = z.object({
  file_path: z.string().describe("Path to file to translate"),
  target_lang: z.string().describe("Target language (e.g., 'Korean', 'English', 'Japanese')"),
  source_lang: z.string().optional().describe("Source language (auto-detect if not provided)"),
  output_path: z.string().optional().describe("Custom output file path (default: auto-generated in .ai_reviews/)"),
  model: z.string().optional().describe("Ollama model name (default: 7B light model)"),
  num_ctx: z.number().optional().default(32768).describe("Context window size for Ollama (default: 32768, safe for 16GB VRAM)"),
});

export const summarizeTextSchema = z.object({
  text: z.string().describe("Text to summarize"),
  style: z.enum(["brief", "detailed", "bullet", "eli5"]).optional().default("brief"),
  max_length: z.number().optional().describe("Maximum length in words"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
});

export const extractKeywordsSchema = z.object({
  text: z.string().describe("Text to analyze"),
  max_keywords: z.number().optional().default(10),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
});

export const explainCodeSchema = z.object({
  code: z.string().describe("Code to explain"),
  language: z.string().optional().describe("Programming language"),
  detail_level: z.enum(["brief", "detailed", "eli5"]).optional().default("detailed"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
});

export const improveTextSchema = z.object({
  text: z.string().describe("Text to improve"),
  focus: z.enum(["grammar", "clarity", "conciseness", "formal", "casual"]).optional().default("clarity"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("prompt_template", "Manage prompt templates. Store, retrieve, and apply templates with variables.", promptTemplateSchema),
  createToolDefinition("response_cache", "Cache LLM responses to save tokens and reduce latency.", responseCacheSchema),
  createToolDefinition("token_count", "Estimate token count for text (approximation based on word/character count).", tokenCountSchema),
  createToolDefinition("translate_text", "Translate text using Ollama or Gemini.", translateTextSchema),
  createToolDefinition("translate_file", "Translate a file using Ollama. MCP reads the file server-side and sends to Ollama with extended context window, so Claude doesn't consume tokens for file content. Result is saved to a file.", translateFileSchema),
  createToolDefinition("summarize_text", "Summarize text using Ollama or Gemini.", summarizeTextSchema),
  createToolDefinition("extract_keywords", "Extract keywords and key phrases from text using LLM.", extractKeywordsSchema),
  createToolDefinition("explain_code", "Explain code in natural language using LLM.", explainCodeSchema),
  createToolDefinition("improve_text", "Improve text quality (grammar, clarity, style) using LLM.", improveTextSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  prompt_template: promptTemplateSchema,
  response_cache: responseCacheSchema,
  token_count: tokenCountSchema,
  translate_text: translateTextSchema,
  translate_file: translateFileSchema,
  summarize_text: summarizeTextSchema,
  extract_keywords: extractKeywordsSchema,
  explain_code: explainCodeSchema,
  improve_text: improveTextSchema,
};

// ===== Internal Helpers =====

/**
 * Classify text into different character types for language-aware token estimation.
 * @param text Text to classify
 * @returns Classification breakdown
 */
function classifyText(text: string): {
  asciiWords: number;
  cjkChars: number;
  otherChars: number;
  codeTokens: number;
} {
  let asciiWords = 0;
  let cjkChars = 0;
  let otherChars = 0;
  let codeTokens = 0;

  // Split into tokens for analysis
  const tokens = text.split(/\s+/);

  for (const token of tokens) {
    if (!token) continue;

    let hasAscii = false;
    let hasCjk = false;
    let hasOther = false;
    let hasCodeChars = false;

    for (const char of token) {
      const code = char.charCodeAt(0);

      // CJK Unicode ranges:
      // U+3000-U+9FFF: CJK Symbols, Hiragana, Katakana, Bopomofo, Hangul Compatibility, CJK Unified Ideographs
      // U+AC00-U+D7AF: Hangul Syllables (Korean)
      // U+F900-U+FAFF: CJK Compatibility Ideographs
      if (
        (code >= 0x3000 && code <= 0x9FFF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xF900 && code <= 0xFAFF)
      ) {
        hasCjk = true;
      } else if (code >= 0x20 && code <= 0x7E) {
        // ASCII printable characters
        hasAscii = true;

        // Code indicators: brackets, operators, punctuation common in code
        if ('{}[]()<>:;,.=+-*/%&|!?'.includes(char)) {
          hasCodeChars = true;
        }
      } else {
        hasOther = true;
      }
    }

    // Classify the token
    if (hasCjk) {
      // Count each CJK character individually
      for (const char of token) {
        const code = char.charCodeAt(0);
        if (
          (code >= 0x3000 && code <= 0x9FFF) ||
          (code >= 0xAC00 && code <= 0xD7AF) ||
          (code >= 0xF900 && code <= 0xFAFF)
        ) {
          cjkChars++;
        }
      }
    } else if (hasAscii) {
      asciiWords++;
      if (hasCodeChars) {
        codeTokens++;
      }
    } else if (hasOther) {
      otherChars += token.length;
    }
  }

  return { asciiWords, cjkChars, otherChars, codeTokens };
}

/** Route LLM request to Gemini or Ollama based on model preference and text length */
async function routeToLLM(
  model: string | undefined,
  text: string,
  prompt: string,
  geminiThreshold: number = 2000
): Promise<string> {
  const useGemini = model === "gemini" || (model === MODEL_AUTO && text.length > geminiThreshold);
  if (useGemini) {
    return (await runGeminiCLI([prompt])).trim();
  }
  return (await ollamaChat(OLLAMA_MODELS.fast, prompt)).trim();
}

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "prompt_template": {
      const { action, name: tplName, template, variables } = promptTemplateSchema.parse(args);

      switch (action) {
        case "save":
          if (!tplName || !template) throw new Error("'name' and 'template' required for save");
          promptTemplates.set(tplName, template);
          return { content: [{ type: "text", text: `Template '${tplName}' saved` }] };
        case "get": {
          if (!tplName) throw new Error("'name' required for get");
          const t = promptTemplates.get(tplName);
          return { content: [{ type: "text", text: t || `Template '${tplName}' not found` }] };
        }
        case "list":
          return { content: [{ type: "text", text: JSON.stringify(Array.from(promptTemplates.keys()), null, 2) }] };
        case "apply": {
          if (!tplName) throw new Error("'name' required for apply");
          let tpl = promptTemplates.get(tplName);
          if (!tpl) throw new Error(`Template '${tplName}' not found`);
          if (variables) {
            for (const [k, v] of Object.entries(variables)) {
              tpl = tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
            }
          }
          return { content: [{ type: "text", text: tpl }] };
        }
        case "delete":
          if (!tplName) throw new Error("'name' required for delete");
          promptTemplates.delete(tplName);
          return { content: [{ type: "text", text: `Template '${tplName}' deleted` }] };
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
    case "response_cache": {
      const { action, key, value, ttl } = responseCacheSchema.parse(args);
      const now = Date.now();

      switch (action) {
        case "get": {
          if (!key) throw new Error("'key' required for get");
          const namespacedKey = `cache:${key}`;
          const cached = responseCache.get(namespacedKey);
          if (!cached) return { content: [{ type: "text", text: "MISS" }] };
          if (now > cached.timestamp + cached.ttl * 1000) {
            responseCache.delete(namespacedKey);
            return { content: [{ type: "text", text: "EXPIRED" }] };
          }
          return { content: [{ type: "text", text: cached.response }] };
        }
        case "set": {
          if (!key || !value) throw new Error("'key' and 'value' required for set");
          const namespacedKey = `cache:${key}`;
          responseCache.set(namespacedKey, { response: value, timestamp: now, ttl });
          return { content: [{ type: "text", text: `Cached with TTL ${ttl}s` }] };
        }
        case "clear":
          if (key) {
            const namespacedKey = `cache:${key}`;
            responseCache.delete(namespacedKey);
            return { content: [{ type: "text", text: `Cleared cache for key: ${key}` }] };
          }
          responseCache.clear();
          return { content: [{ type: "text", text: "Cache cleared" }] };
        case "stats": {
          let validCount = 0;
          responseCache.forEach((v, k) => {
            if (k.startsWith("cache:") && now <= v.timestamp + v.ttl * 1000) validCount++;
          });
          const total = [...responseCache.keys()].filter(k => k.startsWith("cache:")).length;
          return { content: [{ type: "text", text: JSON.stringify({ total, valid: validCount }, null, 2) }] };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
    case "token_count": {
      const { text, model } = tokenCountSchema.parse(args);
      const charCount = text.length;
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      // Language-aware token estimation
      const classified = classifyText(text);

      let tokenEstimate: number;
      switch (model) {
        case "claude":
          tokenEstimate = Math.ceil(
            classified.asciiWords * 1.3 +
            classified.cjkChars * 2.0 +
            classified.otherChars * 2.0 +
            classified.codeTokens * 0.2
          );
          break;
        case "llama":
          tokenEstimate = Math.ceil(
            classified.asciiWords * 1.5 +
            classified.cjkChars * 2.5 +
            classified.otherChars * 2.0 +
            classified.codeTokens * 0.3
          );
          break;
        case "gpt":
        default:
          tokenEstimate = Math.ceil(
            classified.asciiWords * 1.3 +
            classified.cjkChars * 2.5 +
            classified.otherChars * 2.0 +
            classified.codeTokens * 0.2
          );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            characters: charCount,
            words: wordCount,
            estimated_tokens: tokenEstimate,
            model,
            breakdown: {
              ascii_words: classified.asciiWords,
              cjk_chars: classified.cjkChars,
              code_tokens: classified.codeTokens,
              other_chars: classified.otherChars
            }
          }, null, 2)
        }]
      };
    }
    case "translate_text": {
      const { text, target_lang, source_lang, model } = translateTextSchema.parse(args);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }
      const prompt = source_lang
        ? `Translate the following text from ${source_lang} to ${target_lang}. Return ONLY the translation, nothing else:\n\n${text}`
        : `Translate the following text to ${target_lang}. Return ONLY the translation, nothing else:\n\n${text}`;

      const useGemini = model === "gemini" || (model === MODEL_AUTO && text.length > 2000);
      const response = useGemini
        ? await runGeminiCLI([prompt])
        : await ollamaChat(selectOllamaModel(prompt, undefined, "translation").model, prompt);

      return { content: [{ type: "text", text: response.trim() }] };
    }
    case "translate_file": {
      const { file_path, target_lang, source_lang, output_path, model, num_ctx } = translateFileSchema.parse(args);

      assertPathSafe(file_path, "translate_file");
      const fullPath = resolve(file_path);
      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${file_path}`);
      }

      const fileContent = await readFile(fullPath, "utf-8");
      const selectedModel = model || OLLAMA_MODELS.light;

      const system = "You are a professional translator. Translate the given text accurately while preserving all formatting, markdown syntax, code blocks, and structure. Return ONLY the translated text, nothing else.";

      const prompt = source_lang
        ? `Translate the following text from ${source_lang} to ${target_lang}. Preserve all markdown formatting, code blocks, and document structure:\n\n${fileContent}`
        : `Translate the following text to ${target_lang}. Preserve all markdown formatting, code blocks, and document structure:\n\n${fileContent}`;

      const ollamaOptions: Record<string, unknown> | undefined = num_ctx !== 32768 ? { num_ctx } : undefined;
      const response = await ollamaChat(selectedModel, prompt, system, ollamaOptions);

      if (output_path) {
        assertPathSafe(output_path, "translate_file_output");
        const outFullPath = resolve(output_path);
        await writeFile(outFullPath, response.trim(), "utf-8");
        return { content: [{ type: "text", text: `Translation saved to: ${outFullPath}` }] };
      }

      const savedPath = await saveReviewToFile(response.trim(), `translation-${target_lang.toLowerCase()}`);
      return { content: [{ type: "text", text: `Translation saved to: ${savedPath}` }] };
    }
    case "summarize_text": {
      const { text, style, max_length, model } = summarizeTextSchema.parse(args);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }

      let styleInstructions = "";
      switch (style) {
        case "brief": styleInstructions = "Write a 1-2 sentence summary."; break;
        case "detailed": styleInstructions = "Write a comprehensive summary covering all main points."; break;
        case "bullet": styleInstructions = "Write a bullet-point summary with key points."; break;
        case "eli5": styleInstructions = "Explain it like I'm 5 years old."; break;
      }

      const lengthConstraint = max_length ? ` Keep it under ${max_length} words.` : "";
      const prompt = `${styleInstructions}${lengthConstraint}\n\nText to summarize:\n${text}`;

      const response = await routeToLLM(model, text, prompt, 3000);
      return { content: [{ type: "text", text: response }] };
    }
    case "extract_keywords": {
      const { text, max_keywords, model } = extractKeywordsSchema.parse(args);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }
      const prompt = `Extract the ${max_keywords} most important keywords and key phrases from the following text. Return as a JSON array of strings:\n\n${text}`;

      const response = await routeToLLM(model, text, prompt);

      // Try to parse as JSON, fallback to raw response
      try {
        const keywords = JSON.parse(response);
        return { content: [{ type: "text", text: JSON.stringify(keywords, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: response }] };
      }
    }
    case "explain_code": {
      const { code, language, detail_level, model } = explainCodeSchema.parse(args);
      if (code.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }

      let detailInstructions = "";
      switch (detail_level) {
        case "brief": detailInstructions = "Give a brief 1-2 sentence explanation."; break;
        case "detailed": detailInstructions = "Explain in detail what this code does, including the logic and any important patterns."; break;
        case "eli5": detailInstructions = "Explain it like I'm 5 years old, using simple analogies."; break;
      }

      const langHint = language ? ` (${language})` : "";
      const prompt = `${detailInstructions}\n\nCode${langHint}:\n\`\`\`\n${code}\n\`\`\``;

      const response = await routeToLLM(model, code, prompt);
      return { content: [{ type: "text", text: response }] };
    }
    case "improve_text": {
      const { text, focus, model } = improveTextSchema.parse(args);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`Input exceeds maximum size (${MAX_INPUT_CHARS} characters). Please split the input.`);
      }

      let focusInstructions = "";
      switch (focus) {
        case "grammar": focusInstructions = "Fix grammar and spelling errors."; break;
        case "clarity": focusInstructions = "Improve clarity and readability."; break;
        case "conciseness": focusInstructions = "Make it more concise without losing meaning."; break;
        case "formal": focusInstructions = "Rewrite in a formal, professional tone."; break;
        case "casual": focusInstructions = "Rewrite in a casual, friendly tone."; break;
      }

      const prompt = `${focusInstructions} Return ONLY the improved text, nothing else.\n\nOriginal:\n${text}`;

      const response = await routeToLLM(model, text, prompt);
      return { content: [{ type: "text", text: response }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
