// ========== System Setup Tools ==========

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { ollamaRequest, ollamaPull } from "../helpers/ollama.js";
import { detectGpu, buildSystemProfile, loadCachedProfile, saveCachedProfile } from "../helpers/profiler.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { PROJECT_ROOT } from "../config.js";
import type { CallToolResult, SystemProfile } from "../types.js";

export const definitions = [
  {
    name: "system_profile",
    description: "Detect GPU/VRAM and calculate optimal Ollama model configuration. Returns per-model VRAM fit analysis and recommended num_ctx values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        force_refresh: {
          type: "boolean",
          description: "Force re-detection even if cached profile exists (default: false)",
        },
      },
    },
  },
  {
    name: "auto_setup",
    description: "Automatically configure Ollama for this machine: detect hardware, calculate optimal settings, install recommended models, configure Claude settings.json permissions, and add MCP tool documentation to CLAUDE.md. Run once on new machines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dry_run: {
          type: "boolean",
          description: "Only report what would be done without making changes (default: false)",
        },
        skip_pull: {
          type: "boolean",
          description: "Skip model downloads, only detect and save profile (default: false)",
        },
      },
    },
  },
];

async function runSystemProfile(forceRefresh: boolean): Promise<SystemProfile> {
  if (!forceRefresh) {
    const cached = await loadCachedProfile();
    if (cached) return cached;
  }

  const gpu = await detectGpu();
  const profile = buildSystemProfile(gpu, {
    light: OLLAMA_MODELS.light,
    fast: OLLAMA_MODELS.fast,
    powerful: OLLAMA_MODELS.powerful,
  });

  await saveCachedProfile(profile);
  return profile;
}

const MCP_PERMISSION = "mcp__claude-delegate__*";

async function ensureSettingsPermission(): Promise<{ action: string }> {
  const settingsPath = resolve(join(PROJECT_ROOT, ".claude", "settings.json"));

  if (!existsSync(settingsPath)) {
    return { action: "settings_not_found" };
  }

  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowList: string[] = settings?.permissions?.allow || [];

    if (allowList.includes(MCP_PERMISSION)) {
      return { action: "already_configured" };
    }

    // Add to allow list
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    settings.permissions.allow.push(MCP_PERMISSION);

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { action: "added" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: `error: ${message}` };
  }
}

const CLAUDE_MD_SECTION_MARKER = "<!-- LOCAL_LLM_MCP_SECTION -->";

async function ensureClaudeMdSection(profile: SystemProfile): Promise<{ action: string }> {
  const claudeMdPath = resolve(join(PROJECT_ROOT, "CLAUDE.md"));

  try {
    let content = "";
    if (existsSync(claudeMdPath)) {
      content = await readFile(claudeMdPath, "utf-8");
    }

    if (content.includes(CLAUDE_MD_SECTION_MARKER)) {
      return { action: "already_configured" };
    }

    // Build the section with actual profile data
    const usableTiers = (["light", "fast", "powerful"] as const)
      .filter((t) => profile.models[t].fits_vram)
      .map((t) => `${t} (${profile.models[t].model_name})`)
      .join(", ");

    const section = `
${CLAUDE_MD_SECTION_MARKER}
## Local LLM MCP Tools (auto-configured)

This project has a local LLM MCP server (claude-delegate). Use these tools DIRECTLY instead of delegating to agents:

| Task | MCP Tool | Why |
|------|----------|-----|
| File translation | \`translate_file\` | Server-side file read, 99.5% token savings |
| File analysis | \`ollama_analyze_file\` | Server-side read, no Claude tokens for content |
| Multi-file analysis | \`ollama_analyze_files\` | Batch analysis with token savings |
| Code review | \`code_review\` | Local LLM review, saves Claude tokens |
| Simple questions | \`smart_ask\` | Routes to cheapest capable model |

System: ${profile.gpu.name}, ${profile.gpu.vram_total_mb}MB VRAM
Available models: ${usableTiers}

These tools are FREE (local Ollama) — prefer them over Claude token-consuming alternatives.
`;

    const updatedContent = content.trimEnd() + "\n" + section.trim() + "\n";
    await writeFile(claudeMdPath, updatedContent, "utf-8");
    return { action: "added" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: `error: ${message}` };
  }
}

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "system_profile": {
      const { force_refresh = false } = args as { force_refresh?: boolean };
      const profile = await runSystemProfile(force_refresh);
      return {
        content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
      };
    }
    case "auto_setup": {
      const { dry_run = false, skip_pull = false } = args as {
        dry_run?: boolean;
        skip_pull?: boolean;
      };

      // Step 1: Profile the system
      const profile = await runSystemProfile(true);

      // Step 2: Check installed models
      let installedModels: string[] = [];
      try {
        const res = await ollamaRequest("/api/tags");
        installedModels = res.models?.map((m: any) => m.name) || [];
      } catch {
        throw new Error(`Ollama is not running. Start Ollama first, then retry.\n\nSystem profile:\n${JSON.stringify(profile, null, 2)}`);
      }

      // Step 3: Determine actions
      const actions: Array<{
        model: string;
        tier: string;
        action: string;
        fits_vram: boolean;
      }> = [];

      for (const tier of ["light", "fast", "powerful"] as const) {
        const tierProfile = profile.models[tier];
        const modelName = tierProfile.model_name;
        const isInstalled = installedModels.some(
          (m) => m === modelName || m.startsWith(modelName.split(":")[0])
        );

        if (!tierProfile.fits_vram) {
          actions.push({ model: modelName, tier, action: "skipped_no_vram", fits_vram: false });
        } else if (isInstalled) {
          actions.push({ model: modelName, tier, action: "already_installed", fits_vram: true });
        } else if (dry_run) {
          actions.push({ model: modelName, tier, action: "would_install", fits_vram: true });
        } else if (skip_pull) {
          actions.push({ model: modelName, tier, action: "skipped_by_user", fits_vram: true });
        } else {
          // Actually install
          try {
            await ollamaPull(modelName);
            actions.push({ model: modelName, tier, action: "installed", fits_vram: true });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            actions.push({
              model: modelName,
              tier,
              action: `install_failed: ${message}`,
              fits_vram: true,
            });
          }
        }
      }

      // Step 4: Configure settings.json and CLAUDE.md
      const settingsResult = dry_run
        ? { action: "would_configure" }
        : await ensureSettingsPermission();

      const claudeMdResult = dry_run
        ? { action: "would_configure" }
        : await ensureClaudeMdSection(profile);

      const isCpuOnly = profile.gpu.detected_via === "none";
      const result = {
        profile: {
          gpu: profile.gpu,
          effective_config: profile.effective_config,
        },
        actions,
        configuration: {
          settings_json: settingsResult.action,
          claude_md: claudeMdResult.action,
        },
        summary: {
          gpu: profile.gpu.name,
          vram: `${profile.gpu.vram_total_mb} MB`,
          usable_tiers: (["light", "fast", "powerful"] as const)
            .filter((t) => profile.models[t].fits_vram)
            .join(", ") || "none",
          excluded_tiers: (["light", "fast", "powerful"] as const)
            .filter((t) => !profile.models[t].fits_vram)
            .join(", ") || "none",
        },
        ...(isCpuOnly && {
          warning: "No NVIDIA GPU detected. Ollama will run on CPU (system RAM) which is significantly slower. " +
            "Performance: 7B ~5-15 tok/s, 14B ~2-8 tok/s, 32B practically unusable. " +
            "GPU-accelerated usage is strongly recommended for this MCP server.",
        }),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
