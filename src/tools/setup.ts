// ========== System Setup Tools ==========

import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { ollamaRequest, ollamaPull } from "../helpers/ollama.js";
import { detectGpu, buildSystemProfile, loadCachedProfile, saveCachedProfile } from "../helpers/profiler.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { PROJECT_ROOT } from "../config.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult, SystemProfile } from "../types.js";

// ===== Schemas =====
export const systemProfileSchema = z.object({
  force_refresh: z.boolean().optional().default(false).describe("Force re-detection even if cached profile exists (default: false)"),
});

export const autoSetupSchema = z.object({
  dry_run: z.boolean().optional().default(false).describe("Only report what would be done without making changes (default: false)"),
  skip_pull: z.boolean().optional().default(false).describe("Skip model downloads, only detect and save profile (default: false)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("delegate_system_profile", "Detect GPU/VRAM and calculate optimal Ollama model configuration. Returns per-model VRAM fit analysis and recommended num_ctx values.", systemProfileSchema),
  createToolDefinition("delegate_setup", "Automatically configure Ollama for this machine: detect hardware, calculate optimal settings, install recommended models, configure Claude settings.json permissions, and add MCP tool documentation to CLAUDE.md. Run once on new machines.", autoSetupSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  delegate_system_profile: systemProfileSchema,
  delegate_setup: autoSetupSchema,
};

// ===== Handler =====
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
  const claudeDir = resolve(join(PROJECT_ROOT, ".claude"));
  const settingsPath = resolve(join(claudeDir, "settings.json"));

  if (!existsSync(settingsPath)) {
    try {
      // Create .claude directory if it doesn't exist
      if (!existsSync(claudeDir)) {
        mkdirSync(claudeDir, { recursive: true });
      }

      // Create minimal settings.json with permission already included
      const minimalSettings = {
        permissions: {
          allow: [MCP_PERMISSION],
        },
      };

      await writeFile(settingsPath, JSON.stringify(minimalSettings, null, 2) + "\n", "utf-8");
      return { action: "created" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { action: `error_creating: ${message}` };
    }
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

const SKILL_VERSION = "1.2.0";
const SKILL_VERSION_MARKER = `<!-- CLAUDE-DELEGATE-SKILL v${SKILL_VERSION} -->`;

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

async function ensureSkillInstallation(profile: SystemProfile): Promise<{ action: string }> {
  const skillDir = resolve(join(PROJECT_ROOT, ".claude", "skills", "claude-delegate-guide"));
  const skillPath = resolve(join(skillDir, "SKILL.md"));

  // Check existing skill and version before making any changes
  const existed = existsSync(skillPath);
  if (existed) {
    try {
      const existing = await readFile(skillPath, "utf-8");
      if (existing.includes(SKILL_VERSION_MARKER)) {
        return { action: "already_configured" };
      }
      // Older version exists — will update
    } catch {
      // Can't read — will overwrite
    }
  }

  // Build dynamic content based on profile
  const usableTiers = (["light", "fast", "powerful"] as const)
    .filter((t) => profile.models[t].fits_vram)
    .map((t) => `${t} (${profile.models[t].model_name})`)
    .join(", ");

  const isCpuOnly = profile.gpu.detected_via === "none";

  const skillContent = `${SKILL_VERSION_MARKER}
---
name: "claude-delegate-guide"
description: "Usage guide for claude-delegate MCP server — hybrid LLM routing with Ollama and Gemini CLI for token savings"
version: ${SKILL_VERSION}
category: "tool"
modularized: false
user-invocable: false
tags: ['claude-delegate', 'ollama', 'gemini', 'local-llm', 'mcp', 'translate', 'code-review']
updated: ${new Date().toISOString().split("T")[0]}
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
status: "active"

triggers:
  keywords:
    - ollama
    - gemini
    - local-llm
    - translate
    - translate_file
    - code_review
    - smart_ask
    - delegate_setup
    - VRAM
    - GPU
    - token savings
    - claude-delegate
---

# Claude Delegate MCP Server Guide

## Quick Reference

This project has a local LLM MCP server (claude-delegate) with 60 tools.
System: ${profile.gpu.name}, ${profile.gpu.vram_total_mb}MB VRAM
Available models: ${usableTiers || "none (CPU-only mode)"}

## Token-Saving Tools (Use These First)

These tools process files server-side, saving 99.5% of Claude API tokens:

| Task | Tool | Token Savings |
|------|------|--------------|
| Translate a file | \`translate_file\` | ~99.5% (send path, not content) |
| Analyze a file | \`ollama_analyze_file\` | ~99.5% |
| Analyze multiple files | \`ollama_analyze_files\` | ~99.5% |
| Code review | \`code_review\` | Claude+Gemini collaborative |
| Simple questions | \`smart_ask\` | 100% (free local model) |

## Smart Routing

| Task Type | Recommended Tool | Model Used |
|-----------|-----------------|------------|
| Translation | \`translate_file\`, \`translate_text\` | 7B (Light) |
| Code review | \`code_review\` + \`code_review_discuss\` | Gemini CLI |
| Quick questions | \`smart_ask\`, \`ollama_chat\` | Auto (complexity-based) |
| Deep analysis | \`gemini_analyze_codebase\` | Gemini 1M context |
| Compare answers | \`compare_models\` | Ollama + Gemini side-by-side |
| Autonomous tasks | \`ollama_agent\` | 14B (Fast) |

## Model Selection

Models are automatically selected based on task purpose and VRAM:

| Tier | Model | VRAM Required | Best For |
|------|-------|--------------|----------|
| Light (7B) | \`OLLAMA_MODEL_LIGHT\` | ~5 GB | Translation, simple tasks |
| Fast (14B) | \`OLLAMA_MODEL_FAST\` | ~10 GB | Code review, agents |
| Powerful (32B) | \`OLLAMA_MODEL_POWERFUL\` | ~18 GB | Complex analysis |

### VRAM-Aware Downgrade

If a model exceeds available VRAM, it automatically downgrades:

\`\`\`
32B requested → VRAM insufficient → auto-switch to 14B
14B requested → VRAM insufficient → auto-switch to 7B
\`\`\`
## Response Verification

All Ollama-powered tools include verification aids in their responses:

### Text-Returning Tools
Responses include a \`[model: model_name]\` tag showing which model was used.
Example: \`[model: qwen2.5-coder:14b-instruct]\`

### File-Saving Tools
Responses include:
- The saved file path
- \`[model: model_name]\` tag
- A preview of the first 5 lines of the generated content

When the preview looks insufficient or the task is critical, read the full saved file to verify the result.

### Gemini Fallback Tools
Responses show \`[Fallback: Ollama]\` when Gemini failed and Ollama was used instead.

${isCpuOnly ? `
### CPU-Only Mode

No NVIDIA GPU detected. Ollama runs on system RAM (CPU mode).
Expected performance:
- 7B: ~5-15 tokens/sec (usable for translation)
- 14B: ~2-8 tokens/sec (slow but functional)
- 32B: not recommended (too slow)

GPU acceleration is strongly recommended for better experience.
` : ""}
## Gemini Integration

Gemini CLI provides 1M token context for large codebase analysis:

| Tool | Use When |
|------|----------|
| \`gemini_ask\` | Large context questions (auto-fallback to Ollama) |
| \`gemini_analyze_codebase\` | Full codebase analysis |

If Gemini fails (auth error, token limit), automatic fallback to Ollama occurs.
Response shows \`[Fallback: Ollama]\` indicator.

## All Tool Categories

| Category | Count | Key Tools |
|----------|-------|-----------|
| LLM Chat & Analysis | 12 | \`ollama_chat\`, \`smart_ask\`, \`gemini_ask\` |
| LLM Utilities | 9 | \`translate_file\`, \`summarize_text\`, \`explain_code\` |
| File System | 4 | \`fs_read_file\`, \`fs_write_file\`, \`fs_search_files\` |
| Productivity | 6 | \`code_review\`, \`code_review_discuss\`, \`git_commit_helper\` |
| Code Analysis | 4 | \`check_types\`, \`run_linter\`, \`analyze_dependencies\` |
| Knowledge Graph | 5 | \`memory_add_node\`, \`memory_query_graph\` |
| Shell & Process | 8 | \`shell_execute\`, \`process_list\`, \`background_run\` |
| GitHub | 3 | \`gh_create_pr\`, \`gh_list_issues\` |
| Other | 10 | \`fetch_url\`, \`sqlite_query\`, \`health_check\` |

## Troubleshooting

Run \`health_check\` to verify service status:

| Check | What It Verifies |
|-------|-----------------|
| Ollama connection | Server running at configured host |
| Model availability | Required models installed |
| Gemini CLI | Authentication and binary found |

## Setup

If tools aren't working, run:
\`\`\`
delegate_setup()           // Full setup (detect, install, configure)
delegate_setup({ dry_run: true })  // Preview without changes
health_check()         // Diagnose issues
\`\`\`
`;

  try {
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    await writeFile(skillPath, skillContent, "utf-8");
    return { action: existed ? "updated" : "created" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: `error: ${message}` };
  }
}

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "delegate_system_profile": {
      const { force_refresh } = systemProfileSchema.parse(args);
      const profile = await runSystemProfile(force_refresh);
      return {
        content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
      };
    }
    case "delegate_setup": {
      const { dry_run, skip_pull } = autoSetupSchema.parse(args);

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

      const skillResult = dry_run
        ? { action: "would_configure" }
        : await ensureSkillInstallation(profile);

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
          skill_guide: skillResult.action,
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
