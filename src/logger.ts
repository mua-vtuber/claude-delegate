import pino from "pino";
import { join } from "path";
import { PROJECT_ROOT } from "./config.js";

/**
 * Structured logger for the MCP server.
 * Writes to .mcp-server.log file (stderr/stdout reserved for MCP protocol).
 * Control log level via LOG_LEVEL env var (default: "info").
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino/file",
    options: {
      destination: join(PROJECT_ROOT, ".mcp-server.log"),
      mkdir: true,
    },
  },
});
