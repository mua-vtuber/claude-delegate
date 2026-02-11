// ============================================
// Gemini CLI Helpers
// ============================================

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { GEMINI_TIMEOUT, GEMINI_FALLBACK_TO_OLLAMA, OLLAMA_MODEL_POWERFUL, execFilePromise } from "../config.js";
import { ollamaChat } from "./ollama.js";

export function parseGeminiJsonOutput(output: string): string | null {
  // Find JSON object in output (skip log lines before it)
  const jsonMatch = output.match(/\{[\s\S]*"response"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.response) return parsed.response;
    } catch { /* fall through to text filtering */ }
  }
  return null;
}

export function filterGeminiOutput(output: string): string {
  // Try JSON parsing first (cleaner)
  const jsonResponse = parseGeminiJsonOutput(output);
  if (jsonResponse) return jsonResponse;

  // Fallback to line-based filtering for text output
  return output
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.includes("chcp") || t.includes("\uB0B4\uBD80 \uB610\uB294 \uC678\uBD80 \uBA85\uB839")) return false;
      if (t.includes("Loaded cached credentials")) return false;
      if (t.includes("credentials")) return false;
      if (t.includes("Using cached")) return false;
      if (t.includes("Initializing")) return false;
      if (t.includes("Processing")) return false;
      if (t.includes("Reading file")) return false;
      if (t.startsWith("[")) return false;
      if (t.match(/^\d+%/)) return false;
      if (t === "") return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Find the Gemini CLI installation path on Windows.
 * Uses 'where' command and npm global root to locate the CLI.
 *
 * @returns Path to Gemini CLI index.js or null if not found/non-Windows
 */
export async function findGeminiCliPath(): Promise<string | null> {
  const isWindows = process.platform === "win32";
  if (!isWindows) return null; // Non-Windows: use bare 'gemini' command via PATH

  // Method 1: Find via system PATH using 'where'
  try {
    const { stdout } = await execFilePromise("C:\\Windows\\System32\\where.exe", ["gemini"], { timeout: 5000 });
    const firstPath = stdout.trim().split(/\r?\n/)[0].trim();
    if (firstPath) {
      const npmDir = dirname(firstPath);
      const jsPath = join(npmDir, "node_modules", "@google", "gemini-cli", "dist", "index.js");
      if (existsSync(jsPath)) return jsPath;
    }
  } catch {
    // 'where' failed or gemini not in PATH
  }

  // Method 2: Find via npm global root
  try {
    const { stdout } = await execFilePromise("npm", ["root", "-g"], { timeout: 5000, shell: true });
    const npmRoot = stdout.trim();
    if (npmRoot) {
      const jsPath = join(npmRoot, "@google", "gemini-cli", "dist", "index.js");
      if (existsSync(jsPath)) return jsPath;
    }
  } catch {
    // npm not available
  }

  return null;
}

export async function runGeminiCLI(args: string[], timeout = GEMINI_TIMEOUT): Promise<string> {
  const isWindows = process.platform === "win32";
  const fullArgs = ["-o", "json", ...args];  // JSON output for cleaner parsing

  // Resolve CLI path before spawning (async discovery)
  let command: string;
  let spawnArgs: string[];
  const spawnOpts: { windowsHide?: boolean; stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv } = {
    stdio: ["ignore", "pipe", "pipe"],
  };

  if (isWindows) {
    const geminiCliPath = await findGeminiCliPath();
    if (!geminiCliPath) {
      throw new Error("Gemini CLI not found. Install with: npm install -g @google/gemini-cli");
    }
    command = "node";
    spawnArgs = [geminiCliPath, ...fullArgs];
    spawnOpts.windowsHide = true;
    spawnOpts.env = { ...process.env, FORCE_COLOR: "0" };
  } else {
    command = "gemini";
    spawnArgs = fullArgs;
  }

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, spawnArgs, spawnOpts);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Gemini CLI timeout"));
    }, timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      const output = filterGeminiOutput(stdout) || filterGeminiOutput(stderr);
      if (output) resolvePromise(output);
      else if (code === 0) resolvePromise("(empty response)");
      else reject(new Error(`Gemini CLI error (code ${code}): ${stderr || "unknown error"}`));
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Gemini CLI spawn error: ${err.message}`));
    });
  });
}

/**
 * Run Gemini CLI with automatic fallback to Ollama on failure.
 * Useful for handling Gemini token limits or API errors gracefully.
 *
 * @param prompt - Prompt to send to Gemini or Ollama
 * @param timeout - Optional timeout in milliseconds (default: GEMINI_TIMEOUT)
 * @returns Response text and source indicator (gemini or ollama)
 * @throws Error if both Gemini and Ollama fail
 */
export async function runGeminiWithFallback(prompt: string, timeout?: number): Promise<{ response: string; source: "gemini" | "ollama" }> {
  try {
    const response = await runGeminiCLI([prompt], timeout);
    return { response, source: "gemini" };
  } catch (err: unknown) {
    if (!GEMINI_FALLBACK_TO_OLLAMA) {
      throw err;
    }
    // Fallback to Ollama
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Gemini failed (${message}), falling back to Ollama...`);
    const { text } = await ollamaChat(OLLAMA_MODEL_POWERFUL, prompt);
    return { response: text, source: "ollama" };
  }
}

/**
 * Check if Gemini CLI is available without throwing.
 * Returns availability status with path or diagnostic message.
 */
export async function isGeminiCliAvailable(): Promise<{
  available: boolean;
  path?: string;
  message?: string;
}> {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    const geminiPath = await findGeminiCliPath();
    if (geminiPath) return { available: true, path: geminiPath };
    return {
      available: false,
      message: "Gemini CLI not found on Windows. Install with: npm install -g @google/gemini-cli",
    };
  }
  // Non-Windows: gemini used via PATH
  return { available: true, path: "gemini (via PATH)" };
}
