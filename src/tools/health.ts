// ========== Health Check Tools ==========

import { z } from "zod";
import { OLLAMA_HOST, VERSION } from "../config.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { findGeminiCliPath } from "../helpers/gemini.js";
import { ollamaRequest } from "../helpers/ollama.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const healthCheckSchema = z.object({
  check: z.enum(["all", "ollama", "gemini"]).optional().default("all").describe("Which service to check (default: all)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("health_check", "Check connectivity and status of Ollama and Gemini CLI services. Returns structured health information including installed models and service availability.", healthCheckSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  health_check: healthCheckSchema,
};

// ===== Handler =====
interface ModelStatus {
  name: string;
  installed: boolean;
}

interface HealthCheckResult {
  server_version: string;
  ollama?: {
    status: "ok" | "error";
    host: string;
    error?: string;
    models?: string[];
    configured: {
      light: ModelStatus;
      fast: ModelStatus;
      powerful: ModelStatus;
    };
  };
  gemini?: {
    status: "ok" | "error";
    path?: string;
    error?: string;
  };
}

async function checkOllama(): Promise<HealthCheckResult["ollama"]> {
  try {
    const res = await ollamaRequest("/api/tags");
    const installedModels = res.models?.map((m: any) => m.name) || [];

    return {
      status: "ok",
      host: OLLAMA_HOST,
      models: installedModels,
      configured: {
        light: {
          name: OLLAMA_MODELS.light,
          installed: installedModels.includes(OLLAMA_MODELS.light),
        },
        fast: {
          name: OLLAMA_MODELS.fast,
          installed: installedModels.includes(OLLAMA_MODELS.fast),
        },
        powerful: {
          name: OLLAMA_MODELS.powerful,
          installed: installedModels.includes(OLLAMA_MODELS.powerful),
        },
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      host: OLLAMA_HOST,
      error: msg,
      configured: {
        light: { name: OLLAMA_MODELS.light, installed: false },
        fast: { name: OLLAMA_MODELS.fast, installed: false },
        powerful: { name: OLLAMA_MODELS.powerful, installed: false },
      },
    };
  }
}

async function checkGemini(): Promise<HealthCheckResult["gemini"]> {
  try {
    const geminiPath = await findGeminiCliPath();
    if (!geminiPath) {
      // On non-Windows, gemini is used via PATH directly
      const isWindows = process.platform === "win32";
      if (!isWindows) {
        return { status: "ok", path: "gemini (via PATH)" };
      }
      return {
        status: "error",
        error: "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
      };
    }

    return {
      status: "ok",
      path: geminiPath,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      error: msg,
    };
  }
}

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { check } = healthCheckSchema.parse(args);

  const result: HealthCheckResult = {
    server_version: VERSION,
  };

  if (check === "all" || check === "ollama") {
    result.ollama = await checkOllama();
  }

  if (check === "all" || check === "gemini") {
    result.gemini = await checkGemini();
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
