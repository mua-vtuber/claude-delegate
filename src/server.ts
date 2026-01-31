// ============================================
// MCP Server Setup with Map-based dispatch
// ============================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./config.js";
import type { CallToolResult } from "./types.js";
import { validateArgs, logToolCall } from "./middleware.js";

// Import all tool modules
import * as filesystemTools from "./tools/filesystem.js";
import * as webTools from "./tools/web.js";
import * as memoryTools from "./tools/memory.js";
import * as databaseTools from "./tools/database.js";
import * as productivityTools from "./tools/productivity.js";
import * as githubTools from "./tools/github.js";
import * as llmTools from "./tools/llm.js";
import * as shellTools from "./tools/shell.js";
import * as thinkingTools from "./tools/thinking.js";
import * as knowledgeTools from "./tools/knowledge.js";
import * as analysisTools from "./tools/analysis.js";
import * as diffTools from "./tools/diff.js";
import * as processTools from "./tools/process.js";
import * as utilityTools from "./tools/utility.js";
import * as healthTools from "./tools/health.js";
import * as setupTools from "./tools/setup.js";
import * as ragTools from "./tools/rag.js";

// ============================================
// Module Aggregation & Dispatch Map
// ============================================

interface ToolModule {
  definitions: Array<{ name: string; description: string; inputSchema: any }>;
  handler: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

const modules: ToolModule[] = [
  filesystemTools,
  webTools,
  memoryTools,
  databaseTools,
  productivityTools,
  githubTools,
  llmTools,
  shellTools,
  thinkingTools,
  knowledgeTools,
  analysisTools,
  diffTools,
  processTools,
  utilityTools,
  healthTools,
  setupTools,
  ragTools,
];

const allDefinitions = modules.flatMap(m => m.definitions);
const dispatchMap = new Map<string, ToolModule["handler"]>();
for (const mod of modules) {
  for (const def of mod.definitions) {
    dispatchMap.set(def.name, mod.handler);
  }
}

// ============================================
// Server Instance
// ============================================

export const server = new Server(
  {
    name: "claude-delegate",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allDefinitions,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Step 1: Validate arguments
  const validated = validateArgs(name, args as Record<string, unknown>);
  if (!validated.success) return validated.error;

  // Step 2: Dispatch to handler
  const start = Date.now();
  try {
    const handle = dispatchMap.get(name);
    if (!handle) throw new Error(`Unknown tool: ${name}`);
    const result = await handle(name, validated.data);
    logToolCall(name, Date.now() - start, !!result.isError);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToolCall(name, Date.now() - start, true);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});
