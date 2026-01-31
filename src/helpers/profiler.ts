// ============================================
// System Profiler: GPU Detection & VRAM Math
// ============================================

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFilePromise, PROFILE_PATH } from "../config.js";
import { cachedSystemProfile, setCachedSystemProfile } from "../state.js";
import type { GpuInfo, ModelTierProfile, SystemProfile } from "../types.js";

// Model VRAM requirements in MB (Q4_K_M quantization)
// Source: Measured via `ollama ps` peak VRAM usage at num_ctx=2048
// 7B:  qwen2.5-coder:7b-instruct     → ~4.7 GB
// 14B: qwen2.5-coder:14b-instruct    → ~9.5 GB
// 32B: qwen2.5-coder:32b-instruct-q4 → ~18.0 GB
const MODEL_VRAM: Record<string, number> = {
  "7b": 4813,
  "14b": 9728,
  "32b": 18432,
};

// KV cache memory per 1K context tokens (in MB)
// Derived from: (VRAM at 8K ctx - VRAM at 2K ctx) / 6
// Varies by model architecture (GQA heads, layer count)
const KV_CACHE_PER_1K: Record<string, number> = {
  "7b": 0.5,
  "14b": 1.0,
  "32b": 2.0,
};

const VRAM_BUFFER_MB = 2048;       // 2GB reserved for OS/driver/display
const SAFE_NUM_CTX_CAP = 32768;    // 32K safe cap (diminishing returns beyond this for code tasks)
const MIN_NUM_CTX = 2048;          // Below this, model is unusable for meaningful code generation

function detectModelSize(modelName: string): string {
  if (/\b7b\b/i.test(modelName)) return "7b";
  if (/\b14b\b/i.test(modelName)) return "14b";
  if (/\b32b\b/i.test(modelName)) return "32b";
  // Default guesses based on tier
  return "7b";
}

export async function detectGpu(): Promise<GpuInfo> {
  // Try nvidia-smi (standard path on Windows)
  const nvidiaSmiPaths = [
    "nvidia-smi",
    "C:\\Windows\\System32\\nvidia-smi.exe",
  ];

  for (const smiPath of nvidiaSmiPaths) {
    try {
      const { stdout } = await execFilePromise(smiPath, [
        "--query-gpu=name,memory.total,memory.free",
        "--format=csv,noheader,nounits",
      ], { timeout: 5000 });

      const line = stdout.trim().split("\n")[0]; // First GPU
      const parts = line.split(",").map((s: string) => s.trim());

      if (parts.length >= 3) {
        const vramTotal = parseInt(parts[1], 10);
        const vramFree = parseInt(parts[2], 10);

        if (!isNaN(vramTotal) && vramTotal > 0) {
          return {
            name: parts[0],
            vram_total_mb: vramTotal,
            vram_free_mb: vramFree,
            detected_via: "nvidia-smi",
          };
        }
      }
    } catch {
      // Try next path
    }
  }

  // No NVIDIA GPU detected — return CPU-only fallback
  return {
    name: "CPU only (No NVIDIA GPU detected)",
    vram_total_mb: 0,
    vram_free_mb: 0,
    detected_via: "none",
  };
}

export function calculateModelFit(
  vramTotalMb: number,
  tier: "light" | "fast" | "powerful",
  modelName: string
): ModelTierProfile {
  const sizeKey = detectModelSize(modelName);
  const modelSizeMb = MODEL_VRAM[sizeKey] || MODEL_VRAM["7b"];
  const kvPer1k = KV_CACHE_PER_1K[sizeKey] || KV_CACHE_PER_1K["7b"];

  const availableVram = vramTotalMb - modelSizeMb - VRAM_BUFFER_MB;
  const fitsVram = availableVram > 0;

  let maxNumCtx = 0;
  let safeNumCtx = 0;

  if (fitsVram) {
    // Available VRAM for KV cache -> max tokens
    maxNumCtx = Math.floor((availableVram / kvPer1k) * 1000);
    maxNumCtx = Math.min(maxNumCtx, 131072); // 128K absolute ceiling
    safeNumCtx = Math.min(maxNumCtx, SAFE_NUM_CTX_CAP);

    if (safeNumCtx < MIN_NUM_CTX) {
      // Not enough even for minimum context
      safeNumCtx = 0;
      maxNumCtx = 0;
    }
  }

  return {
    tier,
    model_name: modelName,
    model_size_mb: modelSizeMb,
    fits_vram: fitsVram && safeNumCtx >= MIN_NUM_CTX,
    max_num_ctx: maxNumCtx,
    safe_num_ctx: safeNumCtx,
    available_vram_mb: availableVram,
  };
}

export function buildSystemProfile(
  gpu: GpuInfo,
  models: { light: string; fast: string; powerful: string }
): SystemProfile {
  const light = calculateModelFit(gpu.vram_total_mb, "light", models.light);
  const fast = calculateModelFit(gpu.vram_total_mb, "fast", models.fast);
  const powerful = calculateModelFit(gpu.vram_total_mb, "powerful", models.powerful);

  // Effective config: downgrade tiers that don't fit
  // 7B always fits (requires only ~4.8GB) — no downgrade path needed
  const effectiveLight = models.light;
  const effectiveFast = fast.fits_vram ? models.fast : models.light;
  const effectivePowerful = powerful.fits_vram
    ? models.powerful
    : fast.fits_vram
      ? models.fast
      : models.light;

  return {
    version: 1,
    created_at: new Date().toISOString(),
    gpu,
    models: { light, fast, powerful },
    effective_config: {
      OLLAMA_MODEL_LIGHT: effectiveLight,
      OLLAMA_MODEL_FAST: effectiveFast,
      OLLAMA_MODEL_POWERFUL: effectivePowerful,
    },
  };
}

export async function loadCachedProfile(): Promise<SystemProfile | null> {
  // Check in-memory cache first
  if (cachedSystemProfile) return cachedSystemProfile;

  // Try file
  try {
    const filePath = resolve(PROFILE_PATH);
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(await readFile(filePath, "utf-8"));
    if (data.version === 1) {
      setCachedSystemProfile(data);
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveCachedProfile(profile: SystemProfile): Promise<void> {
  const filePath = resolve(PROFILE_PATH);
  await writeFile(filePath, JSON.stringify(profile, null, 2), "utf-8");
  setCachedSystemProfile(profile);
}

export async function getEffectiveNumCtx(model: string): Promise<number | undefined> {
  const profile = await loadCachedProfile();
  if (!profile) return undefined;

  // Match model name to tier
  for (const tier of ["light", "fast", "powerful"] as const) {
    if (profile.models[tier].model_name === model && profile.models[tier].fits_vram) {
      return profile.models[tier].safe_num_ctx || undefined;
    }
  }

  // Also check effective_config (in case model was downgraded)
  for (const tier of ["light", "fast", "powerful"] as const) {
    const configKey = `OLLAMA_MODEL_${tier.toUpperCase()}` as keyof typeof profile.effective_config;
    if (profile.effective_config[configKey] === model) {
      // Find the tier this model actually belongs to
      for (const t of ["light", "fast", "powerful"] as const) {
        if (profile.models[t].model_name === model && profile.models[t].fits_vram) {
          return profile.models[t].safe_num_ctx || undefined;
        }
      }
    }
  }

  return undefined;
}
