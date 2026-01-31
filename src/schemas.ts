import { z } from "zod";
import { MODEL_AUTO } from "./config.js";

// Map of tool name -> Zod schema
export const toolSchemas = new Map<string, z.ZodType>();

// ===== Filesystem Tools =====
toolSchemas.set("fs_write_file", z.object({
  file_path: z.string(),
  content: z.string(),
}));

toolSchemas.set("fs_read_file", z.object({
  file_path: z.string(),
}));

toolSchemas.set("fs_list_directory", z.object({
  dir_path: z.string().optional().default("."),
}));

toolSchemas.set("fs_search_files", z.object({
  dir_path: z.string().optional().default("."),
  pattern: z.string(),
}));

// ===== Web Tools =====
toolSchemas.set("fetch_url", z.object({
  url: z.string(),
}));

// ===== Memory Tools =====
toolSchemas.set("manage_memory", z.object({
  fact: z.string(),
  category: z.string().optional().default("general"),
}));

toolSchemas.set("read_memory", z.object({}));

// ===== Database Tools =====
toolSchemas.set("sqlite_query", z.object({
  db_path: z.string(),
  query: z.string(),
}));

// ===== Productivity Tools =====
toolSchemas.set("todo_manager", z.object({
  action: z.enum(["list", "add", "complete"]),
  task: z.string().optional(),
  index: z.number().optional(),
}));

toolSchemas.set("code_review", z.object({
  dir_path: z.string().optional().default("."),
  focus: z.string().optional().default("general"),
}));

toolSchemas.set("git_commit_helper", z.object({}));

toolSchemas.set("generate_unit_test", z.object({
  file_path: z.string(),
}));

toolSchemas.set("add_docstrings", z.object({
  file_path: z.string(),
}));

// ===== GitHub Tools =====
toolSchemas.set("gh_create_pr", z.object({
  title: z.string(),
  body: z.string(),
  draft: z.boolean().optional().default(false),
}));

toolSchemas.set("gh_list_issues", z.object({
  limit: z.number().optional().default(10),
}));

toolSchemas.set("gh_get_issue", z.object({
  issue_number: z.number(),
}));

// ===== LLM Tools =====
toolSchemas.set("ollama_chat", z.object({
  prompt: z.string(),
  model: z.string().optional().default(MODEL_AUTO),
  system: z.string().optional(),
}));

toolSchemas.set("ollama_analyze_file", z.object({
  file_path: z.string(),
  question: z.string(),
  save_to_file: z.boolean().optional().default(true),
}));

toolSchemas.set("ollama_analyze_files", z.object({
  file_paths: z.array(z.string()),
  question: z.string(),
}));

toolSchemas.set("ollama_list_models", z.object({}));

toolSchemas.set("ollama_agent", z.object({
  task: z.string(),
  model: z.string().optional().default(MODEL_AUTO),
  max_iterations: z.number().optional().default(5),
}));

toolSchemas.set("gemini_ask", z.object({
  prompt: z.string(),
}));

toolSchemas.set("gemini_analyze_codebase", z.object({
  paths: z.array(z.string()),
  question: z.string().optional(),
}));

toolSchemas.set("smart_ask", z.object({
  prompt: z.string(),
  force_model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

toolSchemas.set("ollama_embeddings", z.object({
  model: z.string().optional().default("nomic-embed-text"),
  text: z.string(),
}));

toolSchemas.set("ollama_pull", z.object({
  model: z.string(),
}));

toolSchemas.set("ollama_show", z.object({
  model: z.string(),
}));

toolSchemas.set("compare_models", z.object({
  prompt: z.string(),
}));

// ===== Shell Tools =====
toolSchemas.set("shell_execute", z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
}));

toolSchemas.set("env_get", z.object({
  name: z.string(),
}));

toolSchemas.set("env_set", z.object({
  name: z.string(),
  value: z.string(),
}));

toolSchemas.set("dotenv_parse", z.object({
  file_path: z.string().optional().default(".env"),
}));

// ===== Thinking Tools =====
toolSchemas.set("think_step", z.object({
  session_id: z.string(),
  thought: z.string().optional(),
  action: z.enum(["add", "list", "clear"]).optional().default("add"),
}));

// ===== Knowledge Graph Tools =====
toolSchemas.set("memory_add_node", z.object({
  id: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
}));

toolSchemas.set("memory_add_relation", z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
}));

toolSchemas.set("memory_query_graph", z.object({
  node_id: z.string().optional(),
  node_type: z.string().optional(),
  relation: z.string().optional(),
}));

toolSchemas.set("memory_save_graph", z.object({
  file_path: z.string().optional().default(".ai_knowledge_graph.json"),
}));

toolSchemas.set("memory_load_graph", z.object({
  file_path: z.string().optional().default(".ai_knowledge_graph.json"),
}));

// ===== Analysis Tools =====
toolSchemas.set("analyze_dependencies", z.object({
  file_path: z.string().optional(),
  output_format: z.enum(["json", "markdown", "summary", "legacy"]).optional().default("json"),
}));

toolSchemas.set("find_unused_exports", z.object({
  dir_path: z.string().optional().default("."),
  output_format: z.enum(["json", "markdown", "summary", "legacy"]).optional().default("json"),
}));

toolSchemas.set("check_types", z.object({
  dir_path: z.string().optional().default("."),
  language: z.enum(["typescript", "python"]).optional().default("typescript"),
  output_format: z.enum(["json", "markdown", "summary", "legacy"]).optional().default("json"),
}));

toolSchemas.set("run_linter", z.object({
  dir_path: z.string().optional().default("."),
  language: z.enum(["typescript", "python"]).optional().default("typescript"),
  fix: z.boolean().optional().default(false),
  output_format: z.enum(["json", "markdown", "summary", "legacy"]).optional().default("json"),
}));

// ===== Diff Tools =====
toolSchemas.set("diff_files", z.object({
  file1: z.string(),
  file2: z.string(),
  context_lines: z.number().optional().default(3),
}));

toolSchemas.set("diff_strings", z.object({
  text1: z.string(),
  text2: z.string(),
  label1: z.string().optional().default("original"),
  label2: z.string().optional().default("modified"),
}));

// ===== Process Tools =====
toolSchemas.set("process_list", z.object({
  filter: z.string().optional(),
}));

toolSchemas.set("process_kill", z.object({
  pid: z.number(),
  force: z.boolean().optional().default(false),
}));

toolSchemas.set("background_run", z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
}));

toolSchemas.set("background_status", z.object({
  handle_id: z.string().optional(),
}));

// ===== Utility Tools =====
toolSchemas.set("prompt_template", z.object({
  action: z.enum(["save", "get", "list", "apply", "delete"]),
  name: z.string().optional(),
  template: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
}));

toolSchemas.set("response_cache", z.object({
  action: z.enum(["get", "set", "clear", "stats"]),
  key: z.string().optional(),
  value: z.string().optional(),
  ttl: z.number().optional().default(3600),
}));

toolSchemas.set("token_count", z.object({
  text: z.string(),
  model: z.enum(["gpt", "claude", "llama"]).optional().default("gpt"),
}));

toolSchemas.set("translate_text", z.object({
  text: z.string(),
  target_lang: z.string(),
  source_lang: z.string().optional(),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

toolSchemas.set("translate_file", z.object({
  file_path: z.string(),
  target_lang: z.string(),
  source_lang: z.string().optional(),
  output_path: z.string().optional(),
  model: z.string().optional(),
  num_ctx: z.number().optional().default(32768),
}));

toolSchemas.set("summarize_text", z.object({
  text: z.string(),
  style: z.enum(["brief", "detailed", "bullet", "eli5"]).optional().default("brief"),
  max_length: z.number().optional(),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

toolSchemas.set("extract_keywords", z.object({
  text: z.string(),
  max_keywords: z.number().optional().default(10),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

toolSchemas.set("explain_code", z.object({
  code: z.string(),
  language: z.string().optional(),
  detail_level: z.enum(["brief", "detailed", "eli5"]).optional().default("detailed"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

toolSchemas.set("improve_text", z.object({
  text: z.string(),
  focus: z.enum(["grammar", "clarity", "conciseness", "formal", "casual"]).optional().default("clarity"),
  model: z.enum(["ollama", "gemini", MODEL_AUTO]).optional().default(MODEL_AUTO),
}));

// ===== Health Tools =====
toolSchemas.set("health_check", z.object({
  check: z.enum(["all", "ollama", "gemini"]).optional().default("all"),
}));

// ===== Setup Tools =====
toolSchemas.set("system_profile", z.object({
  force_refresh: z.boolean().optional().default(false),
}));

toolSchemas.set("auto_setup", z.object({
  dry_run: z.boolean().optional().default(false),
  skip_pull: z.boolean().optional().default(false),
}));

// ===== RAG Tools =====
toolSchemas.set("rag_index", z.object({
  paths: z.array(z.string()),
  clear: z.boolean().optional().default(false),
  save: z.boolean().optional().default(true),
}));

toolSchemas.set("rag_search", z.object({
  query: z.string(),
  top_k: z.number().optional().default(5),
}));

toolSchemas.set("rag_ask", z.object({
  question: z.string(),
  top_k: z.number().optional().default(5),
}));
