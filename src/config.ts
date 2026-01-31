// ============================================
// Configuration (Environment Variables)
// ============================================

import { exec, execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "path";

export const execPromise = promisify(exec);
export const execFilePromise = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root is the parent of src/
export const PROJECT_ROOT = resolve(__dirname, "..");
export const PROFILE_PATH = join(PROJECT_ROOT, ".mcp-profile.json");

// Dynamic version from package.json
function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
export const VERSION = loadVersion();

// Validate OLLAMA_HOST points to localhost only (prevent remote code execution)
function validateOllamaHost(host: string): string {
  try {
    const url = new URL(host);
    const hostname = url.hostname.toLowerCase();
    const allowedHosts = ["localhost", "127.0.0.1", "::1"];
    if (!allowedHosts.includes(hostname)) {
      console.error(
        `[SECURITY WARNING] OLLAMA_HOST points to non-localhost address: ${hostname}. ` +
        `This may expose source code and prompts to external servers. ` +
        `Falling back to http://localhost:11434`
      );
      return "http://localhost:11434";
    }
    return host;
  } catch {
    return "http://localhost:11434";
  }
}

export const OLLAMA_HOST = validateOllamaHost(
  process.env.OLLAMA_HOST || "http://localhost:11434"
);
export const REVIEW_OUTPUT_DIR = process.env.MCP_REVIEW_DIR || ".ai_reviews";
export const OLLAMA_MODEL_LIGHT = process.env.OLLAMA_MODEL_LIGHT || "qwen2.5-coder:7b-instruct";
export const OLLAMA_MODEL_FAST = process.env.OLLAMA_MODEL_FAST || "qwen2.5-coder:14b-instruct";
export const OLLAMA_MODEL_POWERFUL = process.env.OLLAMA_MODEL_POWERFUL || "qwen2.5-coder:32b-instruct-q4_K_M";
export const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT || "120000", 10);
export const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "30000", 10);
export const GEMINI_FALLBACK_TO_OLLAMA = process.env.GEMINI_FALLBACK !== "false"; // default: true

// LLM input size limit (~125K tokens)
export const MAX_INPUT_CHARS = 500_000;

// Model selection constant
export const MODEL_AUTO = "auto" as const;
