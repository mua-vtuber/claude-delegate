// ============================================
// Smart Routing Logic
// ============================================

import { OLLAMA_MODEL_LIGHT, OLLAMA_MODEL_FAST, OLLAMA_MODEL_POWERFUL, MODEL_AUTO } from "../config.js";
import { cachedSystemProfile } from "../state.js";
import type { ModelPurpose } from "../types.js";

export const OLLAMA_MODELS = {
  light: OLLAMA_MODEL_LIGHT,
  fast: OLLAMA_MODEL_FAST,
  powerful: OLLAMA_MODEL_POWERFUL,
};

/**
 * Estimate task complexity based on prompt characteristics.
 * Analyzes word count, code blocks, file references, and keywords.
 *
 * @param prompt - User prompt or task description
 * @returns Complexity level (low, medium, or high)
 */
export function estimateComplexity(prompt: string): "low" | "medium" | "high" {
  const wordCount = prompt.split(/\s+/).length;
  const hasCodeBlock = /```[\s\S]*?```/.test(prompt);
  const hasMultipleFiles = (prompt.match(/@[\w./\\]+/g) || []).length > 2;
  const complexKeywords = /architect|refactor|analyze|debug|security|performance|optimize|bug|error|\uC124\uACC4|\uBD84\uC11D|\uB9AC\uD329\uD1A0\uB9C1|\uB514\uBC84\uADF8|\uCD5C\uC801\uD654|\uBC84\uADF8|\uC5D0\uB7EC/i;
  const simpleKeywords = /what is|\uBFD0\uC57C|\uAC04\uB2E8\uD788|simply|quick|\uBE68\uB9AC|\uBC88\uC5ED|translate|\uC694\uC57D|summary|\uC77D\uC5B4|read/i;

  if (simpleKeywords.test(prompt) && wordCount < 50 && !hasCodeBlock) return "low";
  if (hasMultipleFiles || wordCount > 500 || complexKeywords.test(prompt)) return "high";
  if (hasCodeBlock || wordCount > 100) return "medium";
  return "low";
}

/**
 * Select the optimal Ollama model based on task purpose or complexity.
 * Considers VRAM constraints from system profile and automatically downgrades if needed.
 *
 * @param prompt - User prompt for complexity estimation
 * @param forceModel - Optional model override (if not "auto")
 * @param purpose - Optional task purpose (translation, code_review, agent)
 * @returns Selected model name and selection reason
 */
export function selectOllamaModel(
  prompt: string,
  forceModel?: string,
  purpose?: ModelPurpose
): { model: string; reason: string } {
  if (forceModel && forceModel !== MODEL_AUTO) {
    return { model: forceModel, reason: `User specified: ${forceModel}` };
  }

  // Purpose-based selection (takes priority over complexity)
  let selectedModel: string;
  let reason: string;

  switch (purpose) {
    case "translation":
      selectedModel = OLLAMA_MODELS.light;
      reason = "Translation task: 7B sufficient";
      break;
    case "code_review":
      selectedModel = OLLAMA_MODELS.fast;
      reason = "Code review: 14B recommended";
      break;
    case "agent":
      selectedModel = OLLAMA_MODELS.fast;
      reason = "Agent/tool-calling: 14B required for reasoning";
      break;
    default: {
      // Fall back to complexity-based selection
      const complexity = estimateComplexity(prompt);
      switch (complexity) {
        case "high":
          selectedModel = OLLAMA_MODELS.powerful;
          reason = `Auto-selected 32B (complexity: high)`;
          break;
        case "medium":
          selectedModel = OLLAMA_MODELS.fast;
          reason = `Auto-selected 14B (complexity: medium)`;
          break;
        case "low":
        default:
          selectedModel = OLLAMA_MODELS.light;
          reason = `Auto-selected 7B (complexity: low)`;
      }
    }
  }

  // VRAM-aware downgrade if profile exists
  if (cachedSystemProfile) {
    const profile = cachedSystemProfile;
    // Check if selected model's tier fits VRAM
    for (const tier of ["powerful", "fast", "light"] as const) {
      if (profile.models[tier].model_name === selectedModel) {
        if (!profile.models[tier].fits_vram) {
          // Downgrade to next fitting tier
          if (tier === "powerful" && profile.models.fast.fits_vram) {
            selectedModel = OLLAMA_MODELS.fast;
            reason += " (downgraded: 32B exceeds VRAM)";
          } else if ((tier === "powerful" || tier === "fast") && profile.models.light.fits_vram) {
            selectedModel = OLLAMA_MODELS.light;
            reason += " (downgraded: exceeds VRAM)";
          }
        }
        break;
      }
    }
  }

  return { model: selectedModel, reason };
}
