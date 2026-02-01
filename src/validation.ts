import type { z } from "zod";

// Import allSchemas from each tool module
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

const schemaMap = new Map<string, z.ZodType>();

const modules = [
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

for (const mod of modules) {
  if ('allSchemas' in mod) {
    for (const [name, schema] of Object.entries(mod.allSchemas)) {
      schemaMap.set(name, schema as z.ZodType);
    }
  }
}

export { schemaMap };
