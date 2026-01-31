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

async function main() {
  // Load cached system profile on startup
  const profile = await loadCachedProfile();
  if (profile) {
    setCachedSystemProfile(profile);
    console.error(`[auto-setup] Profile loaded: ${profile.gpu.name}, ${profile.gpu.vram_total_mb}MB VRAM`);
    if (profile.gpu.detected_via === "none") {
      console.error("[WARNING] No NVIDIA GPU detected. Ollama runs on CPU (system RAM) which is significantly slower.");
      console.error("[WARNING] 7B models: 5-15 tok/s, 14B+: practically unusable. GPU-accelerated usage is recommended.");
    }
  } else {
    console.error("[auto-setup] No profile found. Run 'auto_setup' tool for optimal configuration.");
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
  logger.info({ event: "server_start", version: VERSION });
  console.error(`MCP Local LLM server v${VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
