#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, exec, execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from "fs";
import { resolve, join, extname, basename, dirname } from "path";
import { promisify } from "util";

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);

// ============================================
// Configuration (Environment Variables)
// ============================================
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const REVIEW_OUTPUT_DIR = process.env.MCP_REVIEW_DIR || ".ai_reviews";
const OLLAMA_MODEL_LIGHT = process.env.OLLAMA_MODEL_LIGHT || "qwen2.5-coder:7b-instruct";
const OLLAMA_MODEL_FAST = process.env.OLLAMA_MODEL_FAST || "qwen2.5-coder:14b-instruct";
const OLLAMA_MODEL_POWERFUL = process.env.OLLAMA_MODEL_POWERFUL || "qwen2.5-coder:32b-instruct-q4_K_M";
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT || "120000", 10);
const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "30000", 10);
const GEMINI_FALLBACK_TO_OLLAMA = process.env.GEMINI_FALLBACK !== "false"; // 기본: true
const PROJECT_ROOT = process.cwd();

// ============================================
// Path Validation & Security
// ============================================

function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  const rootNormalized = PROJECT_ROOT.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith(rootNormalized);
}

function assertPathSafe(targetPath: string, operation: string): string {
  const resolved = resolve(targetPath);
  if (!isPathSafe(resolved)) {
    throw new Error(`Security: ${operation} outside project directory is not allowed. Path: ${targetPath}`);
  }
  return resolved;
}

// ============================================
// State Storage
// ============================================

interface ThinkingStep {
  step: number;
  thought: string;
  timestamp: string;
}

interface GraphNode {
  id: string;
  type: string;
  properties: Record<string, any>;
}

interface GraphRelation {
  from: string;
  to: string;
  relation: string;
  properties?: Record<string, any>;
}

const thinkingSteps: Map<string, ThinkingStep[]> = new Map();
const knowledgeGraph: { nodes: GraphNode[]; relations: GraphRelation[] } = { nodes: [], relations: [] };
const responseCache: Map<string, { response: string; timestamp: number; ttl: number }> = new Map();
const envOverrides: Map<string, string> = new Map();
const backgroundProcesses: Map<string, { pid: number; command: string; startTime: number }> = new Map();
const promptTemplates: Map<string, string> = new Map();

// ============================================
// Analysis Result Types (SPEC-ANALYSIS-001)
// ============================================

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface Issue {
  id: string;
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  column?: number;
  message: string;
  rule?: string;
  suggestion?: string;
}

interface AnalysisMetadata {
  tool: string;
  version: string;
  timestamp: string;
  duration_ms: number;
  target: string;
}

interface AnalysisSummary {
  total_issues: number;
  by_severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  trend?: {
    previous_total: number;
    change: number;
    direction: "improved" | "degraded" | "unchanged";
  };
}

interface AnalysisResult {
  metadata: AnalysisMetadata;
  summary: AnalysisSummary;
  issues: Issue[];
  raw_output?: string;
}

// Analysis cache for trend tracking
const analysisCache: Map<string, { result: AnalysisResult; timestamp: number }> = new Map();

// ============================================
// Resource Cleanup Configuration
// ============================================

const MAX_CACHE_SIZE = 1000;
const MAX_THINKING_SESSIONS = 100;
const MAX_BACKGROUND_PROCESSES = 50;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredCache() {
  const now = Date.now();
  for (const [key, value] of responseCache.entries()) {
    if (now > value.timestamp + value.ttl * 1000) {
      responseCache.delete(key);
    }
  }
  // Enforce max size (remove oldest)
  if (responseCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(responseCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, responseCache.size - MAX_CACHE_SIZE);
    toDelete.forEach(([key]) => responseCache.delete(key));
  }
}

function cleanupThinkingSessions() {
  if (thinkingSteps.size > MAX_THINKING_SESSIONS) {
    const keys = Array.from(thinkingSteps.keys());
    keys.slice(0, thinkingSteps.size - MAX_THINKING_SESSIONS).forEach(k => thinkingSteps.delete(k));
  }
}

function cleanupBackgroundProcesses() {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  for (const [id, proc] of backgroundProcesses.entries()) {
    if (now - proc.startTime > ONE_HOUR) {
      backgroundProcesses.delete(id);
    }
  }
}

// Start cleanup interval
setInterval(() => {
  cleanupExpiredCache();
  cleanupThinkingSessions();
  cleanupBackgroundProcesses();
}, CACHE_CLEANUP_INTERVAL);

// ============================================
// File System Helpers
// ============================================

// ============================================
// Review Output Helpers
// ============================================

function generateReviewPath(type: string): string {
  const dir = resolve(REVIEW_OUTPUT_DIR);
  if (!existsSync(dir)) {
    const { mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(dir, `${type}_${timestamp}.md`);
}

function saveReviewToFile(content: string, type: string): string {
  const filePath = generateReviewPath(type);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  const files = readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = join(dirPath, file);
    if (statSync(fullPath).isDirectory()) {
      if (
        file !== "node_modules" &&
        file !== ".git" &&
        file !== "dist" &&
        file !== "build" &&
        file !== "coverage" &&
        !file.startsWith(".")
      ) {
        arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
      }
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

function searchInFiles(dirPath: string, pattern: string): string[] {
  const results: string[] = [];
  const files = getAllFiles(dirPath);
  const regex = new RegExp(pattern, "i");

  files.forEach((file) => {
    try {
      const content = readFileSync(file, "utf-8");
      if (regex.test(content)) {
        results.push(file);
      }
    } catch (e) {
      // binary files or permission errors ignored
    }
  });
  return results;
}

// Simple HTML to Text converter for fetch_url
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================
// Analysis Output Parsers (SPEC-ANALYSIS-001)
// ============================================

function generateIssueId(tool: string, file: string, line?: number): string {
  const hash = `${tool}-${file}-${line || 0}`.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return `${tool.toUpperCase()}-${Math.abs(hash).toString(16).toUpperCase().padStart(6, '0')}`;
}

function parseTscOutput(output: string, target: string): Issue[] {
  const issues: Issue[] = [];
  const lines = output.split('\n');

  // TypeScript error format: file(line,column): error TS1234: message
  const tscRegex = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;

  for (const line of lines) {
    const match = line.match(tscRegex);
    if (match) {
      const [, file, lineNum, column, type, code, message] = match;
      issues.push({
        id: generateIssueId('tsc', file, parseInt(lineNum)),
        severity: type === 'error' ? 'high' : 'medium',
        category: 'type-error',
        file: file.trim(),
        line: parseInt(lineNum),
        column: parseInt(column),
        message: message.trim(),
        rule: code,
        suggestion: `Fix type error ${code} in ${file}`
      });
    }
  }

  return issues;
}

function parseEslintOutput(output: string, target: string): Issue[] {
  const issues: Issue[] = [];
  const lines = output.split('\n');

  // ESLint default format: /path/file.ts
  //   line:col  severity  message  rule-name
  const eslintLineRegex = /^\s*(\d+):(\d+)\s+(error|warning|info)\s+(.+?)\s+(\S+)$/;
  let currentFile = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this is a file path line
    if (trimmed && !trimmed.match(/^\d/) && !trimmed.startsWith('✖') && existsSync(trimmed)) {
      currentFile = trimmed;
      continue;
    }

    const match = line.match(eslintLineRegex);
    if (match && currentFile) {
      const [, lineNum, column, severity, message, rule] = match;

      // Map ESLint severity to our severity
      let mappedSeverity: Severity = 'medium';
      if (severity === 'error') {
        // Check for security-related rules
        if (rule.includes('security') || rule.includes('no-eval') || rule.includes('no-new-Function')) {
          mappedSeverity = 'critical';
        } else {
          mappedSeverity = 'high';
        }
      } else if (severity === 'warning') {
        mappedSeverity = 'medium';
      } else {
        mappedSeverity = 'info';
      }

      issues.push({
        id: generateIssueId('eslint', currentFile, parseInt(lineNum)),
        severity: mappedSeverity,
        category: rule.includes('style') || rule.includes('format') ? 'style' : 'lint',
        file: currentFile,
        line: parseInt(lineNum),
        column: parseInt(column),
        message: message.trim(),
        rule: rule,
        suggestion: `Fix ${rule} violation`
      });
    }
  }

  return issues;
}

function parseDependencyOutput(content: string, filePath: string): Issue[] {
  const issues: Issue[] = [];

  if (filePath.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Check for known problematic patterns
      for (const [name, version] of Object.entries(deps)) {
        const versionStr = String(version);

        // Check for wildcard versions
        if (versionStr === '*' || versionStr === 'latest') {
          issues.push({
            id: generateIssueId('deps', filePath, 0),
            severity: 'medium',
            category: 'dependency',
            file: filePath,
            message: `Dependency "${name}" uses unsafe version specifier: ${versionStr}`,
            rule: 'no-wildcard-version',
            suggestion: `Pin "${name}" to a specific version`
          });
        }

        // Check for git dependencies
        if (versionStr.includes('git') || versionStr.includes('github')) {
          issues.push({
            id: generateIssueId('deps', filePath + name, 0),
            severity: 'low',
            category: 'dependency',
            file: filePath,
            message: `Dependency "${name}" uses git URL: ${versionStr}`,
            rule: 'no-git-dependency',
            suggestion: `Consider publishing "${name}" to npm registry`
          });
        }
      }
    } catch {
      // JSON parse error - will be reported separately
    }
  }

  return issues;
}

function parseExportOutput(exports: { file: string; name: string }[], imports: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const unused = exports.filter(e => !imports.has(e.name));

  for (const exp of unused) {
    issues.push({
      id: generateIssueId('exports', exp.file, 0),
      severity: 'info',
      category: 'unused-export',
      file: exp.file,
      message: `Export "${exp.name}" is potentially unused`,
      rule: 'no-unused-export',
      suggestion: `Remove unused export "${exp.name}" or add to public API`
    });
  }

  return issues;
}

// ============================================
// Analysis Result Builder (SPEC-ANALYSIS-001)
// ============================================

function buildAnalysisResult(
  tool: string,
  version: string,
  target: string,
  issues: Issue[],
  rawOutput: string,
  startTime: number
): AnalysisResult {
  // Sort issues by severity (critical first)
  const severityOrder: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4
  };

  const sortedIssues = [...issues].sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity]
  );

  // Count by severity
  const bySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  };

  for (const issue of sortedIssues) {
    bySeverity[issue.severity]++;
  }

  // Calculate trend from cache
  const cacheKey = `${tool}:${target}`;
  const cached = analysisCache.get(cacheKey);
  let trend: AnalysisSummary['trend'] | undefined;

  if (cached) {
    const previousTotal = cached.result.summary.total_issues;
    const change = sortedIssues.length - previousTotal;
    trend = {
      previous_total: previousTotal,
      change: change,
      direction: change < 0 ? 'improved' : change > 0 ? 'degraded' : 'unchanged'
    };
  }

  const result: AnalysisResult = {
    metadata: {
      tool,
      version,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      target
    },
    summary: {
      total_issues: sortedIssues.length,
      by_severity: bySeverity,
      trend
    },
    issues: sortedIssues,
    raw_output: rawOutput
  };

  // Update cache
  analysisCache.set(cacheKey, { result, timestamp: Date.now() });

  return result;
}

// ============================================
// Analysis Output Formatters (SPEC-ANALYSIS-001)
// ============================================

function formatAnalysisAsJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

function formatAnalysisAsMarkdown(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push(`# ${result.metadata.tool} Analysis Report`);
  lines.push('');
  lines.push('## Metadata');
  lines.push(`- **Tool**: ${result.metadata.tool}`);
  lines.push(`- **Version**: ${result.metadata.version}`);
  lines.push(`- **Target**: ${result.metadata.target}`);
  lines.push(`- **Timestamp**: ${result.metadata.timestamp}`);
  lines.push(`- **Duration**: ${result.metadata.duration_ms}ms`);
  lines.push('');

  lines.push('## Summary');
  lines.push(`- **Total Issues**: ${result.summary.total_issues}`);
  lines.push('- **By Severity**:');
  lines.push(`  - Critical: ${result.summary.by_severity.critical}`);
  lines.push(`  - High: ${result.summary.by_severity.high}`);
  lines.push(`  - Medium: ${result.summary.by_severity.medium}`);
  lines.push(`  - Low: ${result.summary.by_severity.low}`);
  lines.push(`  - Info: ${result.summary.by_severity.info}`);

  if (result.summary.trend) {
    lines.push('');
    lines.push('### Trend');
    const emoji = result.summary.trend.direction === 'improved' ? '✅' :
                  result.summary.trend.direction === 'degraded' ? '⚠️' : '➡️';
    lines.push(`${emoji} ${result.summary.trend.direction.toUpperCase()}: ${result.summary.trend.change >= 0 ? '+' : ''}${result.summary.trend.change} issues (previous: ${result.summary.trend.previous_total})`);
  }

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('## Issues');
    lines.push('');

    for (const issue of result.issues) {
      const location = issue.line ? `${issue.file}:${issue.line}${issue.column ? ':' + issue.column : ''}` : issue.file;
      lines.push(`### [${issue.severity.toUpperCase()}] ${issue.id}`);
      lines.push(`- **Location**: \`${location}\``);
      lines.push(`- **Category**: ${issue.category}`);
      if (issue.rule) lines.push(`- **Rule**: ${issue.rule}`);
      lines.push(`- **Message**: ${issue.message}`);
      if (issue.suggestion) lines.push(`- **Suggestion**: ${issue.suggestion}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatAnalysisAsSummary(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push(`[${result.metadata.tool}] ${result.summary.total_issues} issues found in ${result.metadata.duration_ms}ms`);

  const counts: string[] = [];
  if (result.summary.by_severity.critical > 0) counts.push(`${result.summary.by_severity.critical} critical`);
  if (result.summary.by_severity.high > 0) counts.push(`${result.summary.by_severity.high} high`);
  if (result.summary.by_severity.medium > 0) counts.push(`${result.summary.by_severity.medium} medium`);
  if (result.summary.by_severity.low > 0) counts.push(`${result.summary.by_severity.low} low`);
  if (result.summary.by_severity.info > 0) counts.push(`${result.summary.by_severity.info} info`);

  if (counts.length > 0) {
    lines.push(`  Breakdown: ${counts.join(', ')}`);
  }

  if (result.summary.trend) {
    const arrow = result.summary.trend.direction === 'improved' ? '↓' :
                  result.summary.trend.direction === 'degraded' ? '↑' : '→';
    lines.push(`  Trend: ${arrow} ${result.summary.trend.direction} (${result.summary.trend.change >= 0 ? '+' : ''}${result.summary.trend.change})`);
  }

  return lines.join('\n');
}

// ============================================
// Ollama API Helpers
// ============================================

async function ollamaRequest(endpoint: string, body?: object): Promise<any> {
  const url = `${OLLAMA_HOST}${endpoint}`;
  const options: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function ollamaChat(
  model: string,
  prompt: string,
  system?: string
): Promise<string> {
  const url = `${OLLAMA_HOST}/api/generate`;
  const body = {
    model,
    prompt,
    system: system || "You are a helpful assistant.",
    stream: false,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const result = await response.json();
  return result.response;
}

// ============================================
// Ollama Tool Calling
// ============================================

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      required: string[];
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    };
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, any> } }>;
}

// 올라마 에이전트가 사용할 수 있는 도구들
const OLLAMA_AGENT_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path to read" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files in a directory",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Directory path" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files containing a pattern",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)" },
          path: { type: "string", description: "Directory to search in (default: current)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Content to write" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Command to execute" },
          args: { type: "string", description: "Command arguments (space-separated)" },
        },
      },
    },
  },
];

// 올라마 에이전트 도구 실행
async function executeAgentTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const fullPath = assertPathSafe(args.path, "read");
        if (!existsSync(fullPath)) return `Error: File not found: ${args.path}`;
        return readFileSync(fullPath, "utf-8");
      }
      case "list_directory": {
        const fullPath = resolve(args.path || ".");
        if (!existsSync(fullPath)) return `Error: Directory not found: ${args.path}`;
        return readdirSync(fullPath).join("\n");
      }
      case "search_files": {
        const results = searchInFiles(resolve(args.path || "."), args.pattern);
        return results.length > 0 ? results.join("\n") : "No matches found.";
      }
      case "write_file": {
        const fullPath = assertPathSafe(args.path, "write");
        writeFileSync(fullPath, args.content, "utf-8");
        return `Successfully wrote to ${args.path}`;
      }
      case "run_command": {
        const cmdArgs = args.args ? args.args.split(" ") : [];
        const { stdout, stderr } = await execFilePromise(args.command, cmdArgs, { timeout: SHELL_TIMEOUT });
        return stdout || stderr || "(no output)";
      }
      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// Tool Calling을 지원하는 올라마 채팅 (에이전트 루프)
async function ollamaChatWithTools(
  model: string,
  prompt: string,
  options?: {
    system?: string;
    tools?: OllamaTool[];
    maxIterations?: number;
  }
): Promise<{ response: string; toolCalls: Array<{ tool: string; args: any; result: string }> }> {
  const url = `${OLLAMA_HOST}/api/chat`;
  const tools = options?.tools || OLLAMA_AGENT_TOOLS;
  const maxIterations = options?.maxIterations || 5;
  const toolCallHistory: Array<{ tool: string; args: any; result: string }> = [];

  const messages: OllamaMessage[] = [
    { role: "system", content: options?.system || "You are a helpful assistant. Use the provided tools when needed to complete tasks." },
    { role: "user", content: prompt },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const result = await response.json();
    const assistantMessage = result.message;

    // 도구 호출이 없으면 최종 응답 반환
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return { response: assistantMessage.content, toolCalls: toolCallHistory };
    }

    // 어시스턴트 메시지 추가
    messages.push(assistantMessage);

    // 도구 호출 실행
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;
      const toolResult = await executeAgentTool(toolName, toolArgs);

      toolCallHistory.push({ tool: toolName, args: toolArgs, result: toolResult });

      // 도구 결과를 메시지에 추가
      messages.push({
        role: "tool",
        content: toolResult,
      });
    }
  }

  // 최대 반복 도달
  return { response: "(Max iterations reached)", toolCalls: toolCallHistory };
}

async function ollamaEmbeddings(model: string, text: string): Promise<number[]> {
  const url = `${OLLAMA_HOST}/api/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embeddings error: ${response.status}`);
  }

  const result = await response.json();
  return result.embedding;
}

async function ollamaPull(model: string): Promise<string> {
  const url = `${OLLAMA_HOST}/api/pull`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: false }),
  });

  if (!response.ok) {
    throw new Error(`Ollama pull error: ${response.status}`);
  }

  return `Model ${model} pulled successfully`;
}

async function ollamaShow(model: string): Promise<any> {
  const url = `${OLLAMA_HOST}/api/show`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model }),
  });

  if (!response.ok) {
    throw new Error(`Ollama show error: ${response.status}`);
  }

  return response.json();
}

// ============================================
// Gemini CLI Helpers
// ============================================

function filterGeminiOutput(output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // Filter out common noise
      if (t.includes("chcp") || t.includes("내부 또는 외부 명령")) return false;
      if (t.includes("Loaded cached credentials")) return false;
      if (t.includes("credentials")) return false;
      if (t.includes("Using cached")) return false;
      if (t.includes("Initializing")) return false;
      if (t.includes("Processing")) return false;
      if (t.includes("Reading file")) return false;
      if (t.startsWith("[")) return false;  // Log prefixes like [INFO], [DEBUG]
      if (t.match(/^\d+%/)) return false;   // Progress percentages
      if (t === "") return false;           // Empty lines at start
      return true;
    })
    .join("\n")
    .trim();
}

function findGeminiCliPath(): string | null {
  const isWindows = process.platform === "win32";
  if (!isWindows) return null; // Use 'gemini' command on non-Windows

  const { existsSync } = require("fs");
  const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";

  // Try multiple possible paths
  const possiblePaths = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'),
    join(userProfile, 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'),
    join(userProfile, '.npm-global', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'),
  ].filter(Boolean) as string[];

  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function runGeminiCLI(args: string[], timeout = GEMINI_TIMEOUT): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const isWindows = process.platform === "win32";
    const fullArgs = ["-o", "text", ...args];

    let proc;
    if (isWindows) {
      const geminiCliPath = findGeminiCliPath();
      if (!geminiCliPath) {
        reject(new Error("Gemini CLI not found. Install with: npm install -g @google/gemini-cli"));
        return;
      }

      proc = spawn("node", [geminiCliPath, ...fullArgs], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });
    } else {
      proc = spawn("gemini", fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Gemini CLI timeout"));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = filterGeminiOutput(stdout) || filterGeminiOutput(stderr);
      if (output) resolvePromise(output);
      else if (code === 0) resolvePromise("(empty response)");
      else reject(new Error(`Gemini CLI error (code ${code}): ${stderr || "unknown error"}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Gemini CLI spawn error: ${err.message}`));
    });
  });
}

// Gemini with Ollama fallback
async function runGeminiWithFallback(prompt: string, timeout?: number): Promise<{ response: string; source: "gemini" | "ollama" }> {
  try {
    const response = await runGeminiCLI([prompt], timeout);
    return { response, source: "gemini" };
  } catch (err: any) {
    if (!GEMINI_FALLBACK_TO_OLLAMA) {
      throw err;
    }
    // Fallback to Ollama
    console.error(`Gemini failed (${err.message}), falling back to Ollama...`);
    const response = await ollamaChat(OLLAMA_MODEL_POWERFUL, prompt);
    return { response, source: "ollama" };
  }
}

// ============================================
// Smart Routing Logic
// ============================================

const OLLAMA_MODELS = {
  light: OLLAMA_MODEL_LIGHT,
  fast: OLLAMA_MODEL_FAST,
  powerful: OLLAMA_MODEL_POWERFUL,
};

function estimateComplexity(prompt: string): "low" | "medium" | "high" {
  const wordCount = prompt.split(/\s+/).length;
  const hasCodeBlock = /```[\s\S]*?```/.test(prompt);
  const hasMultipleFiles = (prompt.match(/@[\w./\\]+/g) || []).length > 2;
  const complexKeywords = /architect|refactor|analyze|debug|security|performance|optimize|bug|error|설계|분석|리팩토링|디버그|최적화|버그|에러/i;
  const simpleKeywords = /what is|뭐야|간단히|simply|quick|빨리|번역|translate|요약|summary|읽어|read/i;

  if (simpleKeywords.test(prompt) && wordCount < 50 && !hasCodeBlock) return "low";
  if (hasMultipleFiles || wordCount > 500 || complexKeywords.test(prompt)) return "high";
  if (hasCodeBlock || wordCount > 100) return "medium";
  return "low";
}

function selectOllamaModel(prompt: string, forceModel?: string): { model: string; reason: string } {
  if (forceModel && forceModel !== "auto") {
    return { model: forceModel, reason: `User specified: ${forceModel}` };
  }
  const complexity = estimateComplexity(prompt);
  switch (complexity) {
    case "high":
      return { model: OLLAMA_MODELS.powerful, reason: `Auto-selected 32B (complexity: high)` };
    case "medium":
      return { model: OLLAMA_MODELS.fast, reason: `Auto-selected 14B (complexity: medium)` };
    case "low":
    default:
      return { model: OLLAMA_MODELS.light, reason: `Auto-selected 7B (complexity: low)` };
  }
}

// ============================================
// MCP Server Setup
// ============================================

const server = new Server(
  {
    name: "claude-delegate",
    version: "3.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ========== File System Tools ==========
      {
        name: "fs_write_file",
        description: "Create or overwrite a file with specific content.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to write" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["file_path", "content"],
        },
      },
      {
        name: "fs_read_file",
        description: "Read the content of a file.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
      {
        name: "fs_list_directory",
        description: "List files and directories.",
        inputSchema: {
          type: "object",
          properties: { dir_path: { type: "string", default: "." } },
        },
      },
      {
        name: "fs_search_files",
        description: "Search for files containing a specific pattern.",
        inputSchema: {
          type: "object",
          properties: {
            dir_path: { type: "string", default: "." },
            pattern: { type: "string" },
          },
          required: ["pattern"],
        },
      },

      // ========== Web & Research Tools (New) ==========
      {
        name: "fetch_url",
        description: "Fetch and extract text content from a URL. Useful for reading documentation or articles.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch (http/https)" },
          },
          required: ["url"],
        },
      },

      // ========== Memory Tools (New) ==========
      {
        name: "manage_memory",
        description: "Add a new fact or context to the project memory (.ai_context.md). Use this to remember user preferences or architectural decisions.",
        inputSchema: {
          type: "object",
          properties: {
            fact: { type: "string", description: "Information to remember" },
            category: { type: "string", description: "Category (e.g., convention, architecture, user_pref)", default: "general" },
          },
          required: ["fact"],
        },
      },
      {
        name: "read_memory",
        description: "Read the project memory (.ai_context.md).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // ========== Database Tools (New) ==========
      {
        name: "sqlite_query",
        description: "Execute a SQL query on a SQLite database file using 'sqlite3' CLI. Returns the result as JSON.",
        inputSchema: {
          type: "object",
          properties: {
            db_path: { type: "string", description: "Path to .sqlite or .db file" },
            query: { type: "string", description: "SQL query to execute (SELECT only recommended)" },
          },
          required: ["db_path", "query"],
        },
      },

      // ========== Productivity Tools (New & Updated) ==========
      {
        name: "todo_manager",
        description: "Manage a TODO.md file. Can list, add, or complete tasks.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "add", "complete"], description: "Action to perform" },
            task: { type: "string", description: "Task description (for 'add')" },
            index: { type: "number", description: "Task index (for 'complete')" },
          },
          required: ["action"],
        },
      },
      {
        name: "code_review",
        description: "Perform a comprehensive code review. Saves result to .ai_reviews/ and returns file path.",
        inputSchema: {
          type: "object",
          properties: {
            dir_path: { type: "string", default: "." },
            focus: { type: "string", default: "general" },
          },
        },
      },
      {
        name: "git_commit_helper",
        description: "Generate a commit message based on 'git diff'.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "generate_unit_test",
        description: "Generate unit tests for a file.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
      {
        name: "add_docstrings",
        description: "Add docstrings to a file.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },

      // ========== GitHub Tools ==========
      {
        name: "gh_create_pr",
        description: "Create a Pull Request.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            draft: { type: "boolean", default: false },
          },
          required: ["title", "body"],
        },
      },
      {
        name: "gh_list_issues",
        description: "List recent issues.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", default: 10 } },
        },
      },
      {
        name: "gh_get_issue",
        description: "View an issue.",
        inputSchema: {
          type: "object",
          properties: { issue_number: { type: "number" } },
          required: ["issue_number"],
        },
      },

      // ========== LLM Tools ==========
      {
        name: "ollama_chat",
        description: "Chat with Ollama.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            model: { type: "string", default: "auto" },
            system: { type: "string" },
          },
          required: ["prompt"],
        },
      },
      {
        name: "ollama_analyze_file",
        description: "Analyze a file using Ollama. MCP reads the file and sends to Ollama, so Claude doesn't consume tokens for file content.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to file to analyze" },
            question: { type: "string", description: "What to analyze (e.g., 'Find bugs', 'Explain this code')" },
            save_to_file: { type: "boolean", default: true, description: "Save result to .ai_reviews/ folder" },
          },
          required: ["file_path", "question"],
        },
      },
      {
        name: "ollama_analyze_files",
        description: "Analyze multiple files using Ollama. Returns file path to review document.",
        inputSchema: {
          type: "object",
          properties: {
            file_paths: { type: "array", items: { type: "string" }, description: "Paths to files" },
            question: { type: "string", description: "What to analyze" },
          },
          required: ["file_paths", "question"],
        },
      },
      {
        name: "ollama_list_models",
        description: "List Ollama models.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "ollama_agent",
        description: "Ollama agent with tool calling. Can read/write files, search, and run commands autonomously. Use for complex tasks that require multiple steps.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task description for the agent" },
            model: { type: "string", default: "auto", description: "Model to use (auto selects based on complexity)" },
            max_iterations: { type: "number", default: 5, description: "Maximum tool call iterations" },
          },
          required: ["task"],
        },
      },
      {
        name: "gemini_ask",
        description: "Ask Gemini CLI.",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      },
      {
        name: "gemini_analyze_codebase",
        description: "Analyze codebase with Gemini (1M context). Saves result to .ai_reviews/ and returns file path.",
        inputSchema: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string" } },
            question: { type: "string" },
          },
          required: ["paths"],
        },
      },
      {
        name: "smart_ask",
        description: "Auto-route to Ollama or Gemini.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            force_model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["prompt"],
        },
      },
      {
        name: "ollama_embeddings",
        description: "Generate text embeddings using Ollama.",
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string", default: "nomic-embed-text" },
            text: { type: "string", description: "Text to embed" },
          },
          required: ["text"],
        },
      },
      {
        name: "ollama_pull",
        description: "Download a model from Ollama library.",
        inputSchema: {
          type: "object",
          properties: { model: { type: "string", description: "Model name to pull" } },
          required: ["model"],
        },
      },
      {
        name: "ollama_show",
        description: "Show details of an Ollama model.",
        inputSchema: {
          type: "object",
          properties: { model: { type: "string", description: "Model name" } },
          required: ["model"],
        },
      },
      {
        name: "compare_models",
        description: "Compare responses from Ollama and Gemini for the same prompt.",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string", description: "Prompt to send to both models" } },
          required: ["prompt"],
        },
      },

      // ========== Shell & Environment Tools ==========
      {
        name: "shell_execute",
        description: "Execute a shell command safely. Returns stdout, stderr, and exit code.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute" },
            args: { type: "array", items: { type: "string" }, description: "Command arguments" },
            cwd: { type: "string", description: "Working directory" },
            timeout: { type: "number", description: "Timeout in milliseconds", default: 30000 },
          },
          required: ["command"],
        },
      },
      {
        name: "env_get",
        description: "Get environment variable value.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Variable name" } },
          required: ["name"],
        },
      },
      {
        name: "env_set",
        description: "Set environment variable (session only).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Variable name" },
            value: { type: "string", description: "Variable value" },
          },
          required: ["name", "value"],
        },
      },
      {
        name: "dotenv_parse",
        description: "Parse a .env file and return key-value pairs.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string", description: "Path to .env file", default: ".env" } },
        },
      },

      // ========== Sequential Thinking ==========
      {
        name: "think_step",
        description: "Record a thinking step for sequential reasoning. Use session_id to group related thoughts.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session identifier" },
            thought: { type: "string", description: "The thought or reasoning step" },
            action: { type: "string", enum: ["add", "list", "clear"], default: "add" },
          },
          required: ["session_id"],
        },
      },

      // ========== Knowledge Graph Memory ==========
      {
        name: "memory_add_node",
        description: "Add a node to the knowledge graph.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique node ID" },
            type: { type: "string", description: "Node type (e.g., 'person', 'concept', 'file')" },
            properties: { type: "object", description: "Additional properties" },
          },
          required: ["id", "type"],
        },
      },
      {
        name: "memory_add_relation",
        description: "Add a relation between two nodes in the knowledge graph.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source node ID" },
            to: { type: "string", description: "Target node ID" },
            relation: { type: "string", description: "Relation type (e.g., 'depends_on', 'created_by')" },
            properties: { type: "object", description: "Additional properties" },
          },
          required: ["from", "to", "relation"],
        },
      },
      {
        name: "memory_query_graph",
        description: "Query the knowledge graph.",
        inputSchema: {
          type: "object",
          properties: {
            node_id: { type: "string", description: "Find specific node by ID" },
            node_type: { type: "string", description: "Filter by node type" },
            relation: { type: "string", description: "Filter by relation type" },
          },
        },
      },
      {
        name: "memory_save_graph",
        description: "Save knowledge graph to a JSON file.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string", default: ".ai_knowledge_graph.json" } },
        },
      },
      {
        name: "memory_load_graph",
        description: "Load knowledge graph from a JSON file.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string", default: ".ai_knowledge_graph.json" } },
        },
      },

      // ========== Code Analysis Tools ==========
      {
        name: "analyze_dependencies",
        description: "Analyze project dependencies from package.json or requirements.txt. Returns structured AnalysisResult with dependency issues.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to package.json or requirements.txt" },
            output_format: { type: "string", enum: ["json", "markdown", "summary", "legacy"], default: "json", description: "Output format: json (structured), markdown (readable), summary (compact), legacy (original format)" },
          },
        },
      },
      {
        name: "find_unused_exports",
        description: "Find potentially unused exports in JavaScript/TypeScript files. Returns structured AnalysisResult with unused export issues.",
        inputSchema: {
          type: "object",
          properties: {
            dir_path: { type: "string", default: ".", description: "Directory to scan" },
            output_format: { type: "string", enum: ["json", "markdown", "summary", "legacy"], default: "json", description: "Output format: json (structured), markdown (readable), summary (compact), legacy (original format)" },
          },
        },
      },
      {
        name: "check_types",
        description: "Run TypeScript type checking (tsc --noEmit) or Python type checking (mypy/pyright). Returns structured AnalysisResult with issues, severity, and trend tracking.",
        inputSchema: {
          type: "object",
          properties: {
            dir_path: { type: "string", default: "." },
            language: { type: "string", enum: ["typescript", "python"], default: "typescript" },
            output_format: { type: "string", enum: ["json", "markdown", "summary", "legacy"], default: "json", description: "Output format: json (structured), markdown (readable), summary (compact), legacy (raw CLI output)" },
          },
        },
      },
      {
        name: "run_linter",
        description: "Run linter (ESLint for JS/TS, Pylint/Ruff for Python). Returns structured AnalysisResult with issues categorized by severity.",
        inputSchema: {
          type: "object",
          properties: {
            dir_path: { type: "string", default: "." },
            language: { type: "string", enum: ["typescript", "python"], default: "typescript" },
            fix: { type: "boolean", default: false, description: "Auto-fix issues if possible" },
            output_format: { type: "string", enum: ["json", "markdown", "summary", "legacy"], default: "json", description: "Output format: json (structured), markdown (readable), summary (compact), legacy (raw CLI output)" },
          },
        },
      },

      // ========== Diff & Patch Tools ==========
      {
        name: "diff_files",
        description: "Compare two files and return unified diff.",
        inputSchema: {
          type: "object",
          properties: {
            file1: { type: "string", description: "First file path" },
            file2: { type: "string", description: "Second file path" },
            context_lines: { type: "number", default: 3, description: "Number of context lines" },
          },
          required: ["file1", "file2"],
        },
      },
      {
        name: "diff_strings",
        description: "Compare two strings and return unified diff.",
        inputSchema: {
          type: "object",
          properties: {
            text1: { type: "string", description: "First text" },
            text2: { type: "string", description: "Second text" },
            label1: { type: "string", default: "original" },
            label2: { type: "string", default: "modified" },
          },
          required: ["text1", "text2"],
        },
      },

      // ========== Process Management Tools ==========
      {
        name: "process_list",
        description: "List running processes (filtered by name if provided).",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by process name" },
          },
        },
      },
      {
        name: "process_kill",
        description: "Kill a process by PID.",
        inputSchema: {
          type: "object",
          properties: {
            pid: { type: "number", description: "Process ID to kill" },
            force: { type: "boolean", default: false, description: "Force kill (SIGKILL)" },
          },
          required: ["pid"],
        },
      },
      {
        name: "background_run",
        description: "Run a command in the background. Returns a handle ID.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to run" },
            args: { type: "array", items: { type: "string" } },
          },
          required: ["command"],
        },
      },
      {
        name: "background_status",
        description: "Check status of background processes.",
        inputSchema: {
          type: "object",
          properties: {
            handle_id: { type: "string", description: "Specific handle ID to check (optional)" },
          },
        },
      },

      // ========== LLM Utility Tools ==========
      {
        name: "prompt_template",
        description: "Manage prompt templates. Store, retrieve, and apply templates with variables.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["save", "get", "list", "apply", "delete"], description: "Action to perform" },
            name: { type: "string", description: "Template name" },
            template: { type: "string", description: "Template content with {{variable}} placeholders" },
            variables: { type: "object", description: "Variables to substitute when applying" },
          },
          required: ["action"],
        },
      },
      {
        name: "response_cache",
        description: "Cache LLM responses to save tokens and reduce latency.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "set", "clear", "stats"], description: "Action" },
            key: { type: "string", description: "Cache key (usually the prompt hash)" },
            value: { type: "string", description: "Response to cache" },
            ttl: { type: "number", default: 3600, description: "Time-to-live in seconds" },
          },
          required: ["action"],
        },
      },
      {
        name: "token_count",
        description: "Estimate token count for text (approximation based on word/character count).",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to count tokens for" },
            model: { type: "string", enum: ["gpt", "claude", "llama"], default: "gpt", description: "Model family for estimation" },
          },
          required: ["text"],
        },
      },
      {
        name: "translate_text",
        description: "Translate text using Ollama or Gemini.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to translate" },
            target_lang: { type: "string", description: "Target language (e.g., 'Korean', 'English', 'Japanese')" },
            source_lang: { type: "string", description: "Source language (auto-detect if not provided)" },
            model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["text", "target_lang"],
        },
      },
      {
        name: "summarize_text",
        description: "Summarize text using Ollama or Gemini.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to summarize" },
            style: { type: "string", enum: ["brief", "detailed", "bullet", "eli5"], default: "brief" },
            max_length: { type: "number", description: "Maximum length in words" },
            model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["text"],
        },
      },
      {
        name: "extract_keywords",
        description: "Extract keywords and key phrases from text using LLM.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to analyze" },
            max_keywords: { type: "number", default: 10 },
            model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["text"],
        },
      },
      {
        name: "explain_code",
        description: "Explain code in natural language using LLM.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Code to explain" },
            language: { type: "string", description: "Programming language" },
            detail_level: { type: "string", enum: ["brief", "detailed", "eli5"], default: "detailed" },
            model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["code"],
        },
      },
      {
        name: "improve_text",
        description: "Improve text quality (grammar, clarity, style) using LLM.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to improve" },
            focus: { type: "string", enum: ["grammar", "clarity", "conciseness", "formal", "casual"], default: "clarity" },
            model: { type: "string", enum: ["ollama", "gemini", "auto"], default: "auto" },
          },
          required: ["text"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ========== File System ==========
      case "fs_write_file": {
        const { file_path, content } = args as any;
        const fullPath = assertPathSafe(file_path, "write");
        writeFileSync(fullPath, content, "utf-8");
        return { content: [{ type: "text", text: `Successfully wrote to ${file_path}` }] };
      }
      case "fs_read_file": {
        const { file_path } = args as any;
        const fullPath = assertPathSafe(file_path, "read");
        if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
        return { content: [{ type: "text", text: readFileSync(fullPath, "utf-8") }] };
      }
      case "fs_list_directory": {
        const { dir_path = "." } = args as any;
        const fullPath = resolve(dir_path);
        return { content: [{ type: "text", text: readdirSync(fullPath).join("\n") }] };
      }
      case "fs_search_files": {
        const { dir_path = ".", pattern } = args as any;
        const results = searchInFiles(resolve(dir_path), pattern);
        return { content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches." }] };
      }

      // ========== Web & Research ==========
      case "fetch_url": {
        const { url } = args as { url: string };
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        const html = await response.text();
        const text = stripHtml(html);
        return { content: [{ type: "text", text: text.substring(0, 8000) + (text.length > 8000 ? "...(truncated)" : "") }] };
      }

      // ========== Memory ==========
      case "manage_memory": {
        const { fact, category = "general" } = args as { fact: string; category?: string };
        const memoryPath = resolve(".ai_context.md");
        const entry = `\n- [${category}] ${fact} (Added: ${new Date().toISOString()})`;
        appendFileSync(memoryPath, entry, "utf-8");
        return { content: [{ type: "text", text: `Added to memory: ${fact}` }] };
      }
      case "read_memory": {
        const memoryPath = resolve(".ai_context.md");
        if (!existsSync(memoryPath)) return { content: [{ type: "text", text: "No memory file found (.ai_context.md)." }] };
        return { content: [{ type: "text", text: readFileSync(memoryPath, "utf-8") }] };
      }

      // ========== Database ==========
      case "sqlite_query": {
        const { db_path, query } = args as { db_path: string; query: string };
        const fullPath = resolve(db_path);
        if (!existsSync(fullPath)) throw new Error(`DB file not found: ${fullPath}`);

        const { stdout } = await execFilePromise("sqlite3", ["-json", fullPath, query]);
        return { content: [{ type: "text", text: stdout || "[]" }] };
      }

      // ========== Productivity ==========
      case "todo_manager": {
        const { action, task, index } = args as { action: string; task?: string; index?: number };
        const todoPath = resolve("TODO.md");
        let content = existsSync(todoPath) ? readFileSync(todoPath, "utf-8") : "# Project TODOs\n";
        
        if (action === "list") {
          return { content: [{ type: "text", text: content }] };
        } else if (action === "add" && task) {
          content += `\n- [ ] ${task}`;
          writeFileSync(todoPath, content, "utf-8");
          return { content: [{ type: "text", text: `Added task: ${task}` }] };
        } else if (action === "complete" && typeof index === "number") {
          const lines = content.split("\n");
          let taskCount = 0;
          let found = false;
          const newLines = lines.map(line => {
            if (line.trim().startsWith("- [ ]")) {
              taskCount++;
              if (taskCount === index) {
                found = true;
                return line.replace("- [ ]", "- [x]");
              }
            }
            return line;
          });
          if (!found) throw new Error(`Task #${index} not found.`);
          writeFileSync(todoPath, newLines.join("\n"), "utf-8");
          return { content: [{ type: "text", text: `Completed task #${index}` }] };
        }
        throw new Error("Invalid parameters for todo_manager");
      }

      case "code_review": {
        const { dir_path = ".", focus = "general" } = args as any;
        const fullPath = resolve(dir_path);
        const allFiles = getAllFiles(fullPath);
        const sourceExtensions = [".ts", ".js", ".py", ".go", ".java", ".c", ".cpp", ".rs", ".html", ".css", ".json"];
        const sourceFiles = allFiles.filter((f) => sourceExtensions.includes(extname(f)));
        if (sourceFiles.length === 0) return { content: [{ type: "text", text: "No source files." }] };

        const fileRefs = sourceFiles.map((f) => `@${f}`).join(" ");
        const systemPrompt = `Role: Senior developer. Task: Comprehensive code review. Focus: ${focus}. Identify issues, suggest improvements, and highlight best practices.`;
        const prompt = `${fileRefs} ${systemPrompt}`;
        const { response, source } = await runGeminiWithFallback(prompt, 300000);

        // Save to file instead of returning directly
        const sourceNote = source === "ollama" ? " (Ollama fallback)" : "";
        const reviewPath = saveReviewToFile(`# Code Review${sourceNote}\n\n**Focus:** ${focus}\n**Directory:** ${dir_path}\n**Files:** ${sourceFiles.length}\n\n---\n\n${response}`, "code_review");
        return { content: [{ type: "text", text: `Review saved to: ${reviewPath}${source === "ollama" ? " (used Ollama fallback)" : ""}\n\nUse Read tool to view the full review.` }] };
      }

      case "git_commit_helper": {
        let diff: string;
        try {
          diff = (await execPromise("git diff --staged")).stdout || (await execPromise("git diff")).stdout;
        } catch { throw new Error("Not a git repo or no git detected."); }
        if (!diff.trim()) return { content: [{ type: "text", text: "No changes to commit." }] };
        
        const prompt = `Generate a conventional commit message for:\n${diff.substring(0, 4000)}`;
        const msg = await ollamaChat(OLLAMA_MODELS.fast, prompt);
        return { content: [{ type: "text", text: msg.trim() }] };
      }

      case "generate_unit_test": {
        const { file_path } = args as { file_path: string };
        const fullPath = resolve(file_path);
        const content = readFileSync(fullPath, "utf-8");
        const prompt = `Generate unit tests for:\n\`\`\`\n${content}\n\`\`\``;
        let testCode = await ollamaChat(OLLAMA_MODELS.powerful, prompt);
        testCode = testCode.replace(/^```\w*\n/, "").replace(/```$/, "").trim();

        let testPath = fullPath.replace(extname(fullPath), `.test${extname(fullPath)}`);
        let counter = 1;
        while (existsSync(testPath)) {
          testPath = fullPath.replace(extname(fullPath), `.test.${counter}${extname(fullPath)}`);
          counter++;
        }
        writeFileSync(testPath, testCode, "utf-8");
        return { content: [{ type: "text", text: `Generated: ${testPath}` }] };
      }

      case "add_docstrings": {
        const { file_path } = args as { file_path: string };
        const fullPath = resolve(file_path);
        const content = readFileSync(fullPath, "utf-8");

        // Create backup
        const backupPath = `${fullPath}.bak`;
        writeFileSync(backupPath, content, "utf-8");

        const prompt = `Add docstrings to:\n${content}\nReturn FULL code only.`;
        let newCode = await ollamaChat(OLLAMA_MODELS.fast, prompt);
        newCode = newCode.replace(/^```\w*\n/, "").replace(/```$/, "").trim();
        writeFileSync(fullPath, newCode, "utf-8");
        return { content: [{ type: "text", text: `Updated ${file_path} (backup: ${backupPath})` }] };
      }

      // ========== GitHub ==========
      case "gh_create_pr": {
        const { title, body, draft } = args as { title: string; body: string; draft?: boolean };
        const ghArgs = ["pr", "create", "--title", title, "--body", body];
        if (draft) ghArgs.push("--draft");
        const { stdout } = await execFilePromise("gh", ghArgs);
        return { content: [{ type: "text", text: `PR Created: ${stdout}` }] };
      }
      case "gh_list_issues": {
        const { limit = 10 } = args as { limit?: number };
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
        const { stdout } = await execFilePromise("gh", ["issue", "list", "--limit", String(safeLimit)]);
        return { content: [{ type: "text", text: stdout || "No issues." }] };
      }
      case "gh_get_issue": {
        const { issue_number } = args as { issue_number: number };
        const safeNum = Math.floor(Number(issue_number));
        if (!safeNum || safeNum < 1) throw new Error("Invalid issue number");
        const { stdout } = await execFilePromise("gh", ["issue", "view", String(safeNum)]);
        return { content: [{ type: "text", text: stdout }] };
      }

      // ========== LLM & Router ==========
      case "ollama_chat": {
        const { prompt, model, system } = args as any;
        const { model: selected } = selectOllamaModel(prompt, model);
        const res = await ollamaChat(selected, prompt, system);
        return { content: [{ type: "text", text: res }] };
      }
      case "ollama_analyze_file": {
        const { file_path, question, save_to_file = true } = args as any;
        const fullPath = resolve(file_path);
        if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);

        const fileContent = readFileSync(fullPath, "utf-8");
        const prompt = `Analyze the following file and answer: ${question}\n\nFile: ${file_path}\n\`\`\`\n${fileContent}\n\`\`\``;

        const { model: selected } = selectOllamaModel(prompt);
        const response = await ollamaChat(selected, prompt);

        if (save_to_file) {
          const reviewPath = saveReviewToFile(`# Ollama Analysis\n\n**File:** ${file_path}\n**Question:** ${question}\n**Model:** ${selected}\n\n---\n\n${response}`, "ollama_analysis");
          return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}\n\nUse Read tool to view the full analysis.` }] };
        }
        return { content: [{ type: "text", text: response }] };
      }
      case "ollama_analyze_files": {
        const { file_paths, question } = args as any;
        const fileContents: string[] = [];

        for (const fp of file_paths) {
          const fullPath = resolve(fp);
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath, "utf-8");
            fileContents.push(`### File: ${fp}\n\`\`\`\n${content}\n\`\`\``);
          }
        }

        if (fileContents.length === 0) throw new Error("No valid files found");

        const prompt = `Analyze the following files and answer: ${question}\n\n${fileContents.join("\n\n")}`;
        const { model: selected } = selectOllamaModel(prompt);
        const response = await ollamaChat(selected, prompt);

        const reviewPath = saveReviewToFile(`# Ollama Multi-File Analysis\n\n**Files:** ${file_paths.join(", ")}\n**Question:** ${question}\n**Model:** ${selected}\n\n---\n\n${response}`, "ollama_multi_analysis");
        return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}\n\nUse Read tool to view the full analysis.` }] };
      }
      case "gemini_ask": {
        const { prompt } = args as { prompt: string };
        const { response, source } = await runGeminiWithFallback(prompt);
        const prefix = source === "ollama" ? "[Fallback: Ollama]\n\n" : "";
        return { content: [{ type: "text", text: prefix + response }] };
      }
      case "gemini_analyze_codebase": {
        const { paths, question = "Analyze this codebase" } = args as any;
        const fileRefs = paths.map((p: string) => `@${resolve(p)}`).join(" ");
        const { response, source } = await runGeminiWithFallback(`${fileRefs} ${question}`, 300000);

        // Save to file
        const sourceNote = source === "ollama" ? " (Ollama fallback)" : "";
        const reviewPath = saveReviewToFile(`# Gemini Analysis${sourceNote}\n\n**Question:** ${question}\n**Files:** ${paths.join(", ")}\n\n---\n\n${response}`, "gemini_analysis");
        return { content: [{ type: "text", text: `Analysis saved to: ${reviewPath}${source === "ollama" ? " (used Ollama fallback)" : ""}\n\nUse Read tool to view the full analysis.` }] };
      }
      case "ollama_list_models": {
        const res = await ollamaRequest("/api/tags");
        return { content: [{ type: "text", text: JSON.stringify(res.models, null, 2) }] };
      }
      case "ollama_agent": {
        const { task, model, max_iterations = 5 } = args as { task: string; model?: string; max_iterations?: number };
        const { model: selectedModel } = selectOllamaModel(task, model);

        const result = await ollamaChatWithTools(selectedModel, task, {
          maxIterations: max_iterations,
          system: "You are a helpful assistant that can use tools to complete tasks. Use the available tools when needed. Be thorough but efficient.",
        });

        // 결과 포맷팅
        let output = `## Agent Response\n\n${result.response}`;
        if (result.toolCalls.length > 0) {
          output += `\n\n## Tool Calls (${result.toolCalls.length})\n`;
          result.toolCalls.forEach((tc, i) => {
            output += `\n### ${i + 1}. ${tc.tool}\n`;
            output += `**Args:** \`${JSON.stringify(tc.args)}\`\n`;
            output += `**Result:** ${tc.result.substring(0, 500)}${tc.result.length > 500 ? "..." : ""}\n`;
          });
        }

        return { content: [{ type: "text", text: output }] };
      }
      case "smart_ask": {
        const { prompt, force_model } = args as any;
        const complexity = estimateComplexity(prompt);
        const preferGemini = force_model === "gemini" || (force_model === "auto" && complexity === "high");

        if (preferGemini) {
          const { response, source } = await runGeminiWithFallback(prompt);
          return { content: [{ type: "text", text: `[Routing: ${source === "gemini" ? "Gemini" : "Ollama (fallback)"}]\n\n${response}` }] };
        } else {
          const res = await ollamaChat(selectOllamaModel(prompt).model, prompt);
          return { content: [{ type: "text", text: `[Routing: Ollama]\n\n${res}` }] };
        }
      }
      case "ollama_embeddings": {
        const { model = "nomic-embed-text", text } = args as { model?: string; text: string };
        const embedding = await ollamaEmbeddings(model, text);
        return { content: [{ type: "text", text: JSON.stringify(embedding) }] };
      }
      case "ollama_pull": {
        const { model } = args as { model: string };
        const result = await ollamaPull(model);
        return { content: [{ type: "text", text: result }] };
      }
      case "ollama_show": {
        const { model } = args as { model: string };
        const info = await ollamaShow(model);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      case "compare_models": {
        const { prompt } = args as { prompt: string };
        const [ollamaRes, geminiRes] = await Promise.all([
          ollamaChat(selectOllamaModel(prompt).model, prompt).catch(e => `Ollama Error: ${e.message}`),
          runGeminiCLI([prompt]).catch(e => `Gemini Error: ${e.message}`)
        ]);
        const comparison = `## Ollama Response:\n${ollamaRes}\n\n---\n\n## Gemini Response:\n${geminiRes}`;
        return { content: [{ type: "text", text: comparison }] };
      }

      // ========== Shell & Environment ==========
      case "shell_execute": {
        const { command, args: cmdArgs = [], cwd, timeout = SHELL_TIMEOUT } = args as any;
        const options: any = { timeout };
        if (cwd) options.cwd = resolve(cwd);

        try {
          const { stdout, stderr } = await execFilePromise(command, cmdArgs, options);
          return { content: [{ type: "text", text: JSON.stringify({ stdout, stderr, exitCode: 0 }, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: JSON.stringify({ stdout: err.stdout || "", stderr: err.stderr || err.message, exitCode: err.code || 1 }, null, 2) }] };
        }
      }
      case "env_get": {
        const { name: varName } = args as { name: string };
        const value = envOverrides.get(varName) ?? process.env[varName] ?? null;
        return { content: [{ type: "text", text: value !== null ? value : `Environment variable '${varName}' not found` }] };
      }
      case "env_set": {
        const { name: varName, value } = args as { name: string; value: string };
        envOverrides.set(varName, value);
        return { content: [{ type: "text", text: `Set ${varName}=${value} (session only)` }] };
      }
      case "dotenv_parse": {
        const { file_path = ".env" } = args as { file_path?: string };
        const fullPath = resolve(file_path);
        if (!existsSync(fullPath)) return { content: [{ type: "text", text: `File not found: ${fullPath}` }] };

        const content = readFileSync(fullPath, "utf-8");
        const result: Record<string, string> = {};
        content.split("\n").forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            const eqIndex = trimmed.indexOf("=");
            if (eqIndex > 0) {
              const key = trimmed.substring(0, eqIndex).trim();
              let value = trimmed.substring(eqIndex + 1).trim();
              if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
              }
              result[key] = value;
            }
          }
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ========== Sequential Thinking ==========
      case "think_step": {
        const { session_id, thought, action = "add" } = args as { session_id: string; thought?: string; action?: string };

        if (action === "clear") {
          thinkingSteps.delete(session_id);
          return { content: [{ type: "text", text: `Cleared thinking steps for session: ${session_id}` }] };
        }

        if (action === "list") {
          const steps = thinkingSteps.get(session_id) || [];
          return { content: [{ type: "text", text: JSON.stringify(steps, null, 2) }] };
        }

        if (!thought) throw new Error("'thought' is required for 'add' action");

        const steps = thinkingSteps.get(session_id) || [];
        steps.push({ step: steps.length + 1, thought, timestamp: new Date().toISOString() });
        thinkingSteps.set(session_id, steps);
        return { content: [{ type: "text", text: `Step ${steps.length} recorded: ${thought.substring(0, 50)}...` }] };
      }

      // ========== Knowledge Graph Memory ==========
      case "memory_add_node": {
        const { id, type, properties = {} } = args as { id: string; type: string; properties?: Record<string, any> };
        const existing = knowledgeGraph.nodes.findIndex(n => n.id === id);
        if (existing >= 0) {
          knowledgeGraph.nodes[existing] = { id, type, properties };
          return { content: [{ type: "text", text: `Updated node: ${id}` }] };
        }
        knowledgeGraph.nodes.push({ id, type, properties });
        return { content: [{ type: "text", text: `Added node: ${id} (${type})` }] };
      }
      case "memory_add_relation": {
        const { from, to, relation, properties } = args as unknown as GraphRelation;
        const existing = knowledgeGraph.relations.findIndex(r => r.from === from && r.to === to && r.relation === relation);
        if (existing >= 0) {
          knowledgeGraph.relations[existing] = { from, to, relation, properties };
          return { content: [{ type: "text", text: `Updated relation: ${from} -[${relation}]-> ${to}` }] };
        }
        knowledgeGraph.relations.push({ from, to, relation, properties });
        return { content: [{ type: "text", text: `Added relation: ${from} -[${relation}]-> ${to}` }] };
      }
      case "memory_query_graph": {
        const { node_id, node_type, relation } = args as { node_id?: string; node_type?: string; relation?: string };
        let resultNodes = knowledgeGraph.nodes;
        let resultRelations = knowledgeGraph.relations;

        if (node_id) resultNodes = resultNodes.filter(n => n.id === node_id);
        if (node_type) resultNodes = resultNodes.filter(n => n.type === node_type);
        if (relation) resultRelations = resultRelations.filter(r => r.relation === relation);
        if (node_id) resultRelations = resultRelations.filter(r => r.from === node_id || r.to === node_id);

        return { content: [{ type: "text", text: JSON.stringify({ nodes: resultNodes, relations: resultRelations }, null, 2) }] };
      }
      case "memory_save_graph": {
        const { file_path = ".ai_knowledge_graph.json" } = args as { file_path?: string };
        writeFileSync(resolve(file_path), JSON.stringify(knowledgeGraph, null, 2), "utf-8");
        return { content: [{ type: "text", text: `Knowledge graph saved to ${file_path}` }] };
      }
      case "memory_load_graph": {
        const { file_path = ".ai_knowledge_graph.json" } = args as { file_path?: string };
        const fullPath = resolve(file_path);
        if (!existsSync(fullPath)) return { content: [{ type: "text", text: `File not found: ${fullPath}` }] };

        const data = JSON.parse(readFileSync(fullPath, "utf-8"));
        knowledgeGraph.nodes = data.nodes || [];
        knowledgeGraph.relations = data.relations || [];
        return { content: [{ type: "text", text: `Loaded ${knowledgeGraph.nodes.length} nodes and ${knowledgeGraph.relations.length} relations` }] };
      }

      // ========== Code Analysis ==========
      case "analyze_dependencies": {
        let { file_path, output_format = "json" } = args as { file_path?: string; output_format?: string };
        const startTime = Date.now();

        // Auto-detect if not provided
        if (!file_path) {
          if (existsSync(resolve("package.json"))) file_path = "package.json";
          else if (existsSync(resolve("requirements.txt"))) file_path = "requirements.txt";
          else throw new Error("No package.json or requirements.txt found");
        }

        const fullPath = resolve(file_path);
        const content = readFileSync(fullPath, "utf-8");

        // Legacy format for backward compatibility
        if (output_format === "legacy") {
          if (file_path.endsWith("package.json")) {
            const pkg = JSON.parse(content);
            const deps = pkg.dependencies || {};
            const devDeps = pkg.devDependencies || {};
            return { content: [{ type: "text", text: JSON.stringify({
              name: pkg.name,
              version: pkg.version,
              dependencies: Object.keys(deps).length,
              devDependencies: Object.keys(devDeps).length,
              deps,
              devDeps,
            }, null, 2) }] };
          } else {
            // requirements.txt
            const deps = content.split("\n")
              .map(l => l.trim())
              .filter(l => l && !l.startsWith("#"))
              .map(l => {
                const match = l.match(/^([a-zA-Z0-9_-]+)(.*)$/);
                return match ? { name: match[1], version: match[2] || "any" } : null;
              })
              .filter(Boolean);
            return { content: [{ type: "text", text: JSON.stringify({ count: deps.length, dependencies: deps }, null, 2) }] };
          }
        }

        // Parse dependency issues
        const issues = parseDependencyOutput(content, fullPath);
        const result = buildAnalysisResult(
          "analyze_dependencies",
          file_path.endsWith("package.json") ? "npm" : "pip",
          fullPath,
          issues,
          content,
          startTime
        );

        // Add dependency count info to metadata (extend raw_output with summary)
        if (file_path.endsWith("package.json")) {
          const pkg = JSON.parse(content);
          const depsCount = Object.keys(pkg.dependencies || {}).length;
          const devDepsCount = Object.keys(pkg.devDependencies || {}).length;
          result.raw_output = `package: ${pkg.name}@${pkg.version}\ndependencies: ${depsCount}\ndevDependencies: ${devDepsCount}`;
        } else {
          const depsCount = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("#")).length;
          result.raw_output = `requirements.txt: ${depsCount} dependencies`;
        }

        // Format output based on requested format
        let formattedOutput: string;
        switch (output_format) {
          case "markdown":
            formattedOutput = formatAnalysisAsMarkdown(result);
            break;
          case "summary":
            formattedOutput = formatAnalysisAsSummary(result);
            break;
          case "json":
          default:
            formattedOutput = formatAnalysisAsJson(result);
            break;
        }

        return { content: [{ type: "text", text: formattedOutput }] };
      }
      case "find_unused_exports": {
        const { dir_path = ".", output_format = "json" } = args as { dir_path?: string; output_format?: string };
        const fullPath = resolve(dir_path);
        const startTime = Date.now();
        const files = getAllFiles(fullPath).filter(f => /\.(ts|js|tsx|jsx)$/.test(f));

        const exports: { file: string; name: string }[] = [];
        const imports: Set<string> = new Set();

        files.forEach(file => {
          const content = readFileSync(file, "utf-8");
          // Find exports
          const exportMatches = content.matchAll(/export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g);
          for (const m of exportMatches) exports.push({ file, name: m[1] });
          // Find imports
          const importMatches = content.matchAll(/import\s+\{([^}]+)\}/g);
          for (const m of importMatches) {
            m[1].split(",").forEach(imp => imports.add(imp.trim().split(" ")[0]));
          }
        });

        // Legacy format for backward compatibility
        if (output_format === "legacy") {
          const unused = exports.filter(e => !imports.has(e.name));
          return { content: [{ type: "text", text: JSON.stringify({ total_exports: exports.length, potentially_unused: unused.slice(0, 50) }, null, 2) }] };
        }

        // Parse output using our parser
        const issues = parseExportOutput(exports, imports);
        const result = buildAnalysisResult(
          "find_unused_exports",
          "1.0.0",
          fullPath,
          issues,
          `Scanned ${files.length} files, found ${exports.length} exports, ${issues.length} potentially unused`,
          startTime
        );

        // Format output based on requested format
        let formattedOutput: string;
        switch (output_format) {
          case "markdown":
            formattedOutput = formatAnalysisAsMarkdown(result);
            break;
          case "summary":
            formattedOutput = formatAnalysisAsSummary(result);
            break;
          case "json":
          default:
            formattedOutput = formatAnalysisAsJson(result);
            break;
        }

        return { content: [{ type: "text", text: formattedOutput }] };
      }
      case "check_types": {
        const { dir_path = ".", language = "typescript", output_format = "json" } = args as any;
        const fullPath = resolve(dir_path);
        const startTime = Date.now();

        let rawOutput = "";
        let toolVersion = "unknown";

        try {
          if (language === "typescript") {
            try {
              const { stdout, stderr } = await execFilePromise("npx", ["tsc", "--noEmit", "--pretty"], { cwd: fullPath });
              rawOutput = stdout || stderr || "";
              toolVersion = "tsc";
            } catch (err: any) {
              rawOutput = err.stdout || err.stderr || err.message || "";
              toolVersion = "tsc";
            }
          } else {
            // Python - try mypy first, then pyright
            try {
              const { stdout } = await execFilePromise("mypy", ["."], { cwd: fullPath });
              rawOutput = stdout || "";
              toolVersion = "mypy";
            } catch (mypyErr: any) {
              try {
                const { stdout } = await execFilePromise("pyright", ["."], { cwd: fullPath });
                rawOutput = stdout || "";
                toolVersion = "pyright";
              } catch (pyrightErr: any) {
                rawOutput = mypyErr.stdout || mypyErr.stderr || pyrightErr.stdout || pyrightErr.stderr || "";
                toolVersion = "pyright";
              }
            }
          }

          // Return legacy format if requested
          if (output_format === "legacy") {
            return { content: [{ type: "text", text: rawOutput || "No type errors found!" }] };
          }

          // Parse output and build structured result
          const issues = parseTscOutput(rawOutput, fullPath);
          const result = buildAnalysisResult(
            `check_types:${language}`,
            toolVersion,
            fullPath,
            issues,
            rawOutput,
            startTime
          );

          // Format output based on requested format
          let formattedOutput: string;
          switch (output_format) {
            case "markdown":
              formattedOutput = formatAnalysisAsMarkdown(result);
              break;
            case "summary":
              formattedOutput = formatAnalysisAsSummary(result);
              break;
            case "json":
            default:
              formattedOutput = formatAnalysisAsJson(result);
              break;
          }

          return { content: [{ type: "text", text: formattedOutput }] };
        } catch (err: any) {
          // Even on error, try to return structured output
          if (output_format === "legacy") {
            return { content: [{ type: "text", text: err.stdout || err.stderr || err.message }] };
          }

          const issues = parseTscOutput(err.stdout || err.stderr || "", fullPath);
          const result = buildAnalysisResult(
            `check_types:${language}`,
            toolVersion,
            fullPath,
            issues,
            err.stdout || err.stderr || err.message,
            startTime
          );

          let formattedOutput: string;
          switch (output_format) {
            case "markdown":
              formattedOutput = formatAnalysisAsMarkdown(result);
              break;
            case "summary":
              formattedOutput = formatAnalysisAsSummary(result);
              break;
            case "json":
            default:
              formattedOutput = formatAnalysisAsJson(result);
              break;
          }

          return { content: [{ type: "text", text: formattedOutput }] };
        }
      }
      case "run_linter": {
        const { dir_path = ".", language = "typescript", fix = false, output_format = "json" } = args as any;
        const fullPath = resolve(dir_path);
        const startTime = Date.now();

        let rawOutput = "";
        let toolVersion = "unknown";

        try {
          if (language === "typescript") {
            const lintArgs = ["eslint", ".", "--ext", ".ts,.tsx,.js,.jsx"];
            if (fix) lintArgs.push("--fix");
            try {
              const { stdout } = await execFilePromise("npx", lintArgs, { cwd: fullPath });
              rawOutput = stdout || "";
              toolVersion = "eslint";
            } catch (err: any) {
              rawOutput = err.stdout || err.stderr || err.message || "";
              toolVersion = "eslint";
            }
          } else {
            // Python - try ruff first (faster), then pylint
            try {
              const ruffArgs = ["check", "."];
              if (fix) ruffArgs.push("--fix");
              const { stdout } = await execFilePromise("ruff", ruffArgs, { cwd: fullPath });
              rawOutput = stdout || "";
              toolVersion = "ruff";
            } catch (ruffErr: any) {
              try {
                const { stdout } = await execFilePromise("pylint", ["."], { cwd: fullPath });
                rawOutput = stdout || "";
                toolVersion = "pylint";
              } catch (pylintErr: any) {
                rawOutput = ruffErr.stdout || ruffErr.stderr || pylintErr.stdout || pylintErr.stderr || "";
                toolVersion = "ruff";
              }
            }
          }

          // Return legacy format if requested
          if (output_format === "legacy") {
            return { content: [{ type: "text", text: rawOutput || "No linting issues found!" }] };
          }

          // Parse output and build structured result
          const issues = parseEslintOutput(rawOutput, fullPath);
          const result = buildAnalysisResult(
            `run_linter:${language}`,
            toolVersion,
            fullPath,
            issues,
            rawOutput,
            startTime
          );

          // Format output based on requested format
          let formattedOutput: string;
          switch (output_format) {
            case "markdown":
              formattedOutput = formatAnalysisAsMarkdown(result);
              break;
            case "summary":
              formattedOutput = formatAnalysisAsSummary(result);
              break;
            case "json":
            default:
              formattedOutput = formatAnalysisAsJson(result);
              break;
          }

          return { content: [{ type: "text", text: formattedOutput }] };
        } catch (err: any) {
          // Even on error, try to return structured output
          if (output_format === "legacy") {
            return { content: [{ type: "text", text: err.stdout || err.stderr || err.message }] };
          }

          const issues = parseEslintOutput(err.stdout || err.stderr || "", fullPath);
          const result = buildAnalysisResult(
            `run_linter:${language}`,
            toolVersion,
            fullPath,
            issues,
            err.stdout || err.stderr || err.message,
            startTime
          );

          let formattedOutput: string;
          switch (output_format) {
            case "markdown":
              formattedOutput = formatAnalysisAsMarkdown(result);
              break;
            case "summary":
              formattedOutput = formatAnalysisAsSummary(result);
              break;
            case "json":
            default:
              formattedOutput = formatAnalysisAsJson(result);
              break;
          }

          return { content: [{ type: "text", text: formattedOutput }] };
        }
      }

      // ========== Diff & Patch ==========
      case "diff_files": {
        const { file1, file2, context_lines = 3 } = args as { file1: string; file2: string; context_lines?: number };
        const content1 = readFileSync(resolve(file1), "utf-8").split("\n");
        const content2 = readFileSync(resolve(file2), "utf-8").split("\n");

        // Simple line-by-line diff
        const diff: string[] = [`--- ${file1}`, `+++ ${file2}`];
        let lineNum1 = 0, lineNum2 = 0;

        while (lineNum1 < content1.length || lineNum2 < content2.length) {
          if (lineNum1 >= content1.length) {
            diff.push(`+${content2[lineNum2]}`);
            lineNum2++;
          } else if (lineNum2 >= content2.length) {
            diff.push(`-${content1[lineNum1]}`);
            lineNum1++;
          } else if (content1[lineNum1] === content2[lineNum2]) {
            diff.push(` ${content1[lineNum1]}`);
            lineNum1++;
            lineNum2++;
          } else {
            diff.push(`-${content1[lineNum1]}`);
            diff.push(`+${content2[lineNum2]}`);
            lineNum1++;
            lineNum2++;
          }
        }

        return { content: [{ type: "text", text: diff.join("\n") }] };
      }
      case "diff_strings": {
        const { text1, text2, label1 = "original", label2 = "modified" } = args as any;
        const lines1 = text1.split("\n");
        const lines2 = text2.split("\n");

        const diff: string[] = [`--- ${label1}`, `+++ ${label2}`];
        let i = 0, j = 0;

        while (i < lines1.length || j < lines2.length) {
          if (i >= lines1.length) {
            diff.push(`+${lines2[j++]}`);
          } else if (j >= lines2.length) {
            diff.push(`-${lines1[i++]}`);
          } else if (lines1[i] === lines2[j]) {
            diff.push(` ${lines1[i]}`);
            i++; j++;
          } else {
            diff.push(`-${lines1[i++]}`);
            diff.push(`+${lines2[j++]}`);
          }
        }

        return { content: [{ type: "text", text: diff.join("\n") }] };
      }

      // ========== Process Management ==========
      case "process_list": {
        const { filter } = args as { filter?: string };
        const isWindows = process.platform === "win32";

        try {
          const { stdout } = isWindows
            ? await execFilePromise("tasklist", ["/FO", "CSV"])
            : await execFilePromise("ps", ["aux"]);

          let lines = stdout.split("\n");
          if (filter) {
            lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
          }
          return { content: [{ type: "text", text: lines.slice(0, 50).join("\n") }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
      case "process_kill": {
        const { pid, force = false } = args as { pid: number; force?: boolean };
        const isWindows = process.platform === "win32";

        try {
          if (isWindows) {
            const killArgs = ["/PID", String(pid)];
            if (force) killArgs.push("/F");
            await execFilePromise("taskkill", killArgs);
          } else {
            const signal = force ? "-9" : "-15";
            await execFilePromise("kill", [signal, String(pid)]);
          }
          return { content: [{ type: "text", text: `Process ${pid} terminated` }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
      case "background_run": {
        const { command, args: cmdArgs = [] } = args as { command: string; args?: string[] };
        const handleId = `bg_${Date.now()}`;

        const proc = spawn(command, cmdArgs, { detached: true, stdio: "ignore" });
        proc.unref();

        backgroundProcesses.set(handleId, { pid: proc.pid || 0, command, startTime: Date.now() });
        return { content: [{ type: "text", text: JSON.stringify({ handle_id: handleId, pid: proc.pid }, null, 2) }] };
      }
      case "background_status": {
        const { handle_id } = args as { handle_id?: string };

        if (handle_id) {
          const proc = backgroundProcesses.get(handle_id);
          if (!proc) return { content: [{ type: "text", text: `Handle not found: ${handle_id}` }] };
          return { content: [{ type: "text", text: JSON.stringify(proc, null, 2) }] };
        }

        const all = Object.fromEntries(backgroundProcesses);
        return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
      }

      // ========== LLM Utilities ==========
      case "prompt_template": {
        const { action, name, template, variables } = args as any;

        switch (action) {
          case "save":
            if (!name || !template) throw new Error("'name' and 'template' required for save");
            promptTemplates.set(name, template);
            return { content: [{ type: "text", text: `Template '${name}' saved` }] };
          case "get":
            if (!name) throw new Error("'name' required for get");
            const t = promptTemplates.get(name);
            return { content: [{ type: "text", text: t || `Template '${name}' not found` }] };
          case "list":
            return { content: [{ type: "text", text: JSON.stringify(Array.from(promptTemplates.keys()), null, 2) }] };
          case "apply":
            if (!name) throw new Error("'name' required for apply");
            let tpl = promptTemplates.get(name);
            if (!tpl) throw new Error(`Template '${name}' not found`);
            if (variables) {
              for (const [k, v] of Object.entries(variables)) {
                tpl = tpl.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
              }
            }
            return { content: [{ type: "text", text: tpl }] };
          case "delete":
            if (!name) throw new Error("'name' required for delete");
            promptTemplates.delete(name);
            return { content: [{ type: "text", text: `Template '${name}' deleted` }] };
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      }
      case "response_cache": {
        const { action, key, value, ttl = 3600 } = args as any;
        const now = Date.now();

        switch (action) {
          case "get":
            if (!key) throw new Error("'key' required for get");
            const cached = responseCache.get(key);
            if (!cached) return { content: [{ type: "text", text: "MISS" }] };
            if (now > cached.timestamp + cached.ttl * 1000) {
              responseCache.delete(key);
              return { content: [{ type: "text", text: "EXPIRED" }] };
            }
            return { content: [{ type: "text", text: cached.response }] };
          case "set":
            if (!key || !value) throw new Error("'key' and 'value' required for set");
            responseCache.set(key, { response: value, timestamp: now, ttl });
            return { content: [{ type: "text", text: `Cached with TTL ${ttl}s` }] };
          case "clear":
            if (key) {
              responseCache.delete(key);
              return { content: [{ type: "text", text: `Cleared cache for key: ${key}` }] };
            }
            responseCache.clear();
            return { content: [{ type: "text", text: "Cache cleared" }] };
          case "stats":
            let validCount = 0;
            responseCache.forEach((v, k) => {
              if (now <= v.timestamp + v.ttl * 1000) validCount++;
            });
            return { content: [{ type: "text", text: JSON.stringify({ total: responseCache.size, valid: validCount }, null, 2) }] };
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      }
      case "token_count": {
        const { text, model = "gpt" } = args as { text: string; model?: string };
        const charCount = text.length;
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        // Rough estimation based on model family
        let tokenEstimate: number;
        switch (model) {
          case "claude":
            tokenEstimate = Math.ceil(charCount / 3.5);
            break;
          case "llama":
            tokenEstimate = Math.ceil(charCount / 3.8);
            break;
          case "gpt":
          default:
            tokenEstimate = Math.ceil(charCount / 4);
        }

        return { content: [{ type: "text", text: JSON.stringify({ characters: charCount, words: wordCount, estimated_tokens: tokenEstimate, model }, null, 2) }] };
      }
      case "translate_text": {
        const { text, target_lang, source_lang, model = "auto" } = args as any;
        const prompt = source_lang
          ? `Translate the following text from ${source_lang} to ${target_lang}. Return ONLY the translation, nothing else:\n\n${text}`
          : `Translate the following text to ${target_lang}. Return ONLY the translation, nothing else:\n\n${text}`;

        const useGemini = model === "gemini" || (model === "auto" && text.length > 2000);
        const response = useGemini
          ? await runGeminiCLI([prompt])
          : await ollamaChat(OLLAMA_MODELS.fast, prompt);

        return { content: [{ type: "text", text: response.trim() }] };
      }
      case "summarize_text": {
        const { text, style = "brief", max_length, model = "auto" } = args as any;

        let styleInstructions = "";
        switch (style) {
          case "brief": styleInstructions = "Write a 1-2 sentence summary."; break;
          case "detailed": styleInstructions = "Write a comprehensive summary covering all main points."; break;
          case "bullet": styleInstructions = "Write a bullet-point summary with key points."; break;
          case "eli5": styleInstructions = "Explain it like I'm 5 years old."; break;
        }

        const lengthConstraint = max_length ? ` Keep it under ${max_length} words.` : "";
        const prompt = `${styleInstructions}${lengthConstraint}\n\nText to summarize:\n${text}`;

        const useGemini = model === "gemini" || (model === "auto" && text.length > 3000);
        const response = useGemini
          ? await runGeminiCLI([prompt])
          : await ollamaChat(OLLAMA_MODELS.fast, prompt);

        return { content: [{ type: "text", text: response.trim() }] };
      }
      case "extract_keywords": {
        const { text, max_keywords = 10, model = "auto" } = args as any;
        const prompt = `Extract the ${max_keywords} most important keywords and key phrases from the following text. Return as a JSON array of strings:\n\n${text}`;

        const useGemini = model === "gemini" || (model === "auto" && text.length > 2000);
        const response = useGemini
          ? await runGeminiCLI([prompt])
          : await ollamaChat(OLLAMA_MODELS.fast, prompt);

        // Try to parse as JSON, fallback to raw response
        try {
          const keywords = JSON.parse(response);
          return { content: [{ type: "text", text: JSON.stringify(keywords, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: response.trim() }] };
        }
      }
      case "explain_code": {
        const { code, language, detail_level = "detailed", model = "auto" } = args as any;

        let detailInstructions = "";
        switch (detail_level) {
          case "brief": detailInstructions = "Give a brief 1-2 sentence explanation."; break;
          case "detailed": detailInstructions = "Explain in detail what this code does, including the logic and any important patterns."; break;
          case "eli5": detailInstructions = "Explain it like I'm 5 years old, using simple analogies."; break;
        }

        const langHint = language ? ` (${language})` : "";
        const prompt = `${detailInstructions}\n\nCode${langHint}:\n\`\`\`\n${code}\n\`\`\``;

        const useGemini = model === "gemini" || (model === "auto" && code.length > 2000);
        const response = useGemini
          ? await runGeminiCLI([prompt])
          : await ollamaChat(OLLAMA_MODELS.fast, prompt);

        return { content: [{ type: "text", text: response.trim() }] };
      }
      case "improve_text": {
        const { text, focus = "clarity", model = "auto" } = args as any;

        let focusInstructions = "";
        switch (focus) {
          case "grammar": focusInstructions = "Fix grammar and spelling errors."; break;
          case "clarity": focusInstructions = "Improve clarity and readability."; break;
          case "conciseness": focusInstructions = "Make it more concise without losing meaning."; break;
          case "formal": focusInstructions = "Rewrite in a formal, professional tone."; break;
          case "casual": focusInstructions = "Rewrite in a casual, friendly tone."; break;
        }

        const prompt = `${focusInstructions} Return ONLY the improved text, nothing else.\n\nOriginal:\n${text}`;

        const useGemini = model === "gemini" || (model === "auto" && text.length > 2000);
        const response = useGemini
          ? await runGeminiCLI([prompt])
          : await ollamaChat(OLLAMA_MODELS.fast, prompt);

        return { content: [{ type: "text", text: response.trim() }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Local LLM server v3.2.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
