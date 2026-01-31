// ========== Code Analysis Tools ==========

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFilePromise } from "../config.js";
import { getAllFiles } from "../helpers/filesystem.js";
import {
  parseTscOutput,
  parseEslintOutput,
  parseDependencyOutput,
  parseExportOutput,
  buildAnalysisResult,
  formatAnalysisAsJson,
  formatAnalysisAsMarkdown,
  formatAnalysisAsSummary,
} from "../helpers/analysis.js";
import { assertPathSafe } from "../security.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
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
];

function formatOutput(result: ReturnType<typeof buildAnalysisResult>, output_format: string): string {
  switch (output_format) {
    case "markdown":
      return formatAnalysisAsMarkdown(result);
    case "summary":
      return formatAnalysisAsSummary(result);
    case "json":
    default:
      return formatAnalysisAsJson(result);
  }
}

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "analyze_dependencies": {
      const { output_format = "json" } = args as { file_path?: string; output_format?: string };
      let { file_path } = args as { file_path?: string };
      const startTime = Date.now();

      // Auto-detect if not provided
      if (!file_path) {
        if (existsSync(resolve("package.json"))) file_path = "package.json";
        else if (existsSync(resolve("requirements.txt"))) file_path = "requirements.txt";
        else throw new Error("No package.json or requirements.txt found");
      }

      assertPathSafe(file_path, "analyze_dependencies");
      const fullPath = resolve(file_path);
      const content = await readFile(fullPath, "utf-8");

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

      return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
    }

    case "find_unused_exports": {
      const { dir_path = ".", output_format = "json" } = args as { dir_path?: string; output_format?: string };
      assertPathSafe(dir_path, "find_unused_exports");
      const fullPath = resolve(dir_path);
      const startTime = Date.now();
      const files = (await getAllFiles(fullPath)).filter(f => /\.(ts|js|tsx|jsx)$/.test(f));

      const exports: { file: string; name: string }[] = [];
      const imports: Set<string> = new Set();

      for (const file of files) {
        const content = await readFile(file, "utf-8");
        // Find exports
        const exportMatches = content.matchAll(/export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g);
        for (const m of exportMatches) exports.push({ file, name: m[1] });
        // Find imports
        const importMatches = content.matchAll(/import\s+\{([^}]+)\}/g);
        for (const m of importMatches) {
          m[1].split(",").forEach(imp => imports.add(imp.trim().split(" ")[0]));
        }
      }

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

      return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
    }

    case "check_types": {
      const { dir_path = ".", language = "typescript", output_format = "json" } = args as { dir_path?: string; language?: string; output_format?: string };
      assertPathSafe(dir_path, "check_types");
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
          } catch (err: unknown) {
            const execErr = err as { message?: string; stderr?: string; stdout?: string };
            rawOutput = execErr.stdout || execErr.stderr || execErr.message || "";
            toolVersion = "tsc";
          }
        } else {
          // Python - try mypy first, then pyright
          try {
            const { stdout } = await execFilePromise("mypy", ["."], { cwd: fullPath });
            rawOutput = stdout || "";
            toolVersion = "mypy";
          } catch (mypyErr: unknown) {
            try {
              const { stdout } = await execFilePromise("pyright", ["."], { cwd: fullPath });
              rawOutput = stdout || "";
              toolVersion = "pyright";
            } catch (pyrightErr: unknown) {
              const mypyExecErr = mypyErr as { stdout?: string; stderr?: string };
              const pyrightExecErr = pyrightErr as { stdout?: string; stderr?: string };
              rawOutput = mypyExecErr.stdout || mypyExecErr.stderr || pyrightExecErr.stdout || pyrightExecErr.stderr || "";
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

        return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
      } catch (err: unknown) {
        const execErr = err as { message?: string; stderr?: string; stdout?: string };
        // Even on error, try to return structured output
        if (output_format === "legacy") {
          return { content: [{ type: "text", text: execErr.stdout || execErr.stderr || execErr.message || "" }] };
        }

        const issues = parseTscOutput(execErr.stdout || execErr.stderr || "", fullPath);
        const result = buildAnalysisResult(
          `check_types:${language}`,
          toolVersion,
          fullPath,
          issues,
          execErr.stdout || execErr.stderr || execErr.message || "",
          startTime
        );

        return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
      }
    }

    case "run_linter": {
      const { dir_path = ".", language = "typescript", fix = false, output_format = "json" } = args as { dir_path?: string; language?: string; fix?: boolean; output_format?: string };
      assertPathSafe(dir_path, "run_linter");
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
          } catch (err: unknown) {
            const execErr = err as { message?: string; stderr?: string; stdout?: string };
            rawOutput = execErr.stdout || execErr.stderr || execErr.message || "";
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
          } catch (ruffErr: unknown) {
            try {
              const { stdout } = await execFilePromise("pylint", ["."], { cwd: fullPath });
              rawOutput = stdout || "";
              toolVersion = "pylint";
            } catch (pylintErr: unknown) {
              const ruffExecErr = ruffErr as { stdout?: string; stderr?: string };
              const pylintExecErr = pylintErr as { stdout?: string; stderr?: string };
              rawOutput = ruffExecErr.stdout || ruffExecErr.stderr || pylintExecErr.stdout || pylintExecErr.stderr || "";
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

        return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
      } catch (err: unknown) {
        const execErr = err as { message?: string; stderr?: string; stdout?: string };
        // Even on error, try to return structured output
        if (output_format === "legacy") {
          return { content: [{ type: "text", text: execErr.stdout || execErr.stderr || execErr.message || "" }] };
        }

        const issues = parseEslintOutput(execErr.stdout || execErr.stderr || "", fullPath);
        const result = buildAnalysisResult(
          `run_linter:${language}`,
          toolVersion,
          fullPath,
          issues,
          execErr.stdout || execErr.stderr || execErr.message || "",
          startTime
        );

        return { content: [{ type: "text", text: formatOutput(result, output_format) }] };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
