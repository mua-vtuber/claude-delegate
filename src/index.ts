#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
import { startCleanupTimers, stopCleanupTimers, cleanupAllBackgroundProcesses, setCachedSystemProfile } from "./state.js";
import { VERSION, OLLAMA_HOST } from "./config.js";
import { loadCachedProfile } from "./helpers/profiler.js";
import { logger } from "./logger.js";

startCleanupTimers();

// Graceful shutdown handler
function gracefulShutdown() {
  logger.info({ event: "server_shutdown" });
  stopCleanupTimers();
  cleanupAllBackgroundProcesses();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function selfHealRegistration(): Promise<void> {
  // Only run on Windows where Git Bash PATH issues occur
  if (process.platform !== "win32") return;

  const { readFile, writeFile } = await import("fs/promises");
  const { existsSync } = await import("fs");
  const { resolve, join, dirname } = await import("path");
  const { homedir } = await import("os");

  const claudeJsonPath = resolve(join(homedir(), ".claude.json"));
  if (!existsSync(claudeJsonPath)) return;

  try {
    const data = JSON.parse(await readFile(claudeJsonPath, "utf-8"));
    const entryPoint = resolve(join(dirname(process.argv[1]), "index.js"));
    let changed = false;

    const correctConfig = {
      command: process.execPath,
      args: [entryPoint],
      env: {
        OLLAMA_HOST: "http://localhost:11434",
        PATH: `${dirname(process.execPath)};${join(homedir(), "AppData", "Roaming", "npm")};\${PATH}`
      }
    };

    // Fix global mcpServers entry
    if (data.mcpServers?.["claude-delegate"]) {
      const entry = data.mcpServers["claude-delegate"];
      if (entry.command !== correctConfig.command || entry.args?.[0] !== correctConfig.args[0]) {
        data.mcpServers["claude-delegate"] = correctConfig;
        changed = true;
      }
    }

    // Fix project-level entries
    if (data.projects) {
      for (const proj of Object.values(data.projects) as any[]) {
        if (proj?.mcpServers?.["claude-delegate"]) {
          const entry = proj.mcpServers["claude-delegate"];
          if (entry.command !== correctConfig.command || entry.args?.[0] !== correctConfig.args[0]) {
            proj.mcpServers["claude-delegate"] = correctConfig;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      await writeFile(claudeJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      console.error("[delegate] Self-healed MCP registration in ~/.claude.json (fixed to full path)");
    }
  } catch {
    // Silent fail — self-heal is best-effort
  }
}

async function main() {
  // Load cached system profile on startup
  const profile = await loadCachedProfile();
  if (profile) {
    setCachedSystemProfile(profile);
    console.error(`[delegate] Profile loaded: ${profile.gpu.name}, ${profile.gpu.vram_total_mb}MB VRAM`);
    if (profile.gpu.detected_via === "none") {
      console.error("[WARNING] No NVIDIA GPU detected. Ollama runs on CPU (system RAM) which is significantly slower.");
      console.error("[WARNING] 7B models: 5-15 tok/s, 14B+: practically unusable. GPU-accelerated usage is recommended.");
    }
  } else {
    console.error("[delegate] No profile found. Run 'delegate_setup' tool for optimal configuration.");
  }

  // Check Ollama connectivity
  try {
    await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(`[WARNING] Ollama is not running at ${OLLAMA_HOST}.`);
    console.error("[WARNING] LLM tools require Ollama — install from https://ollama.com");
    console.error("[WARNING] Non-Ollama tools (filesystem, shell, diff, github, etc.) still work.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Self-heal MCP registration (Windows Git Bash PATH fix)
  await selfHealRegistration();

  logger.info({ event: "server_start", version: VERSION });
  console.error(`MCP Local LLM server v${VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
