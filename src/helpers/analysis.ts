// ============================================
// Analysis Output Parsers, Builder & Formatters (SPEC-ANALYSIS-001)
// ============================================

import { existsSync } from "fs";
import type { Severity, Issue, AnalysisSummary, AnalysisResult } from "../types.js";
import { analysisCache } from "../state.js";

function generateIssueId(tool: string, file: string, line?: number): string {
  const hash = `${tool}-${file}-${line || 0}`.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return `${tool.toUpperCase()}-${Math.abs(hash).toString(16).toUpperCase().padStart(6, '0')}`;
}

/**
 * Parse TypeScript compiler (tsc) output into structured issues.
 * Extracts file, line, column, error code, and message from tsc format.
 *
 * @param output - Raw tsc output text
 * @param target - Target file or directory being checked
 * @returns Array of structured Issue objects
 */
export function parseTscOutput(output: string, _target: string): Issue[] {
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

/**
 * Parse ESLint output into structured issues.
 * Detects severity, categorizes security-related rules as critical.
 *
 * @param output - Raw ESLint output text
 * @param target - Target file or directory being checked
 * @returns Array of structured Issue objects
 */
export function parseEslintOutput(output: string, _target: string): Issue[] {
  const issues: Issue[] = [];
  const lines = output.split('\n');

  // ESLint default format: /path/file.ts
  //   line:col  severity  message  rule-name
  const eslintLineRegex = /^\s*(\d+):(\d+)\s+(error|warning|info)\s+(.+?)\s+(\S+)$/;
  let currentFile = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this is a file path line
    if (trimmed && !trimmed.match(/^\d/) && !trimmed.startsWith('\u2716') && existsSync(trimmed)) {
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

/**
 * Analyze package.json dependencies for unsafe patterns.
 * Detects wildcard versions, git dependencies, and other problematic patterns.
 *
 * @param content - Raw package.json content
 * @param filePath - Path to package.json file
 * @returns Array of dependency-related issues
 */
export function parseDependencyOutput(content: string, filePath: string): Issue[] {
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

/**
 * Detect unused exports by comparing exports to imports.
 *
 * @param exports - Array of exported symbols with file paths
 * @param imports - Set of imported symbol names
 * @returns Array of unused export issues
 */
export function parseExportOutput(exports: { file: string; name: string }[], imports: Set<string>): Issue[] {
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

/**
 * Build a comprehensive analysis result with metadata, summary, and trend tracking.
 * Updates cache for trend detection across multiple runs.
 *
 * @param tool - Analysis tool name (e.g., "tsc", "eslint")
 * @param version - Tool version string
 * @param target - Target file or directory analyzed
 * @param issues - Array of detected issues
 * @param rawOutput - Raw tool output for reference
 * @param startTime - Analysis start timestamp (ms)
 * @returns Complete AnalysisResult object with metadata and trend
 */
export function buildAnalysisResult(
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

/**
 * Format analysis result as pretty-printed JSON.
 *
 * @param result - Analysis result object
 * @returns Formatted JSON string with 2-space indentation
 */
export function formatAnalysisAsJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format analysis result as a markdown report.
 * Includes metadata, summary, trend, and detailed issue list.
 *
 * @param result - Analysis result object
 * @returns Markdown-formatted report string
 */
export function formatAnalysisAsMarkdown(result: AnalysisResult): string {
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
    const emoji = result.summary.trend.direction === 'improved' ? '\u2705' :
                  result.summary.trend.direction === 'degraded' ? '\u26A0\uFE0F' : '\u27A1\uFE0F';
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

/**
 * Format analysis result as a concise summary.
 * Single-line format suitable for terminal output or logs.
 *
 * @param result - Analysis result object
 * @returns Compact summary string with counts and trend
 */
export function formatAnalysisAsSummary(result: AnalysisResult): string {
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
    const arrow = result.summary.trend.direction === 'improved' ? '\u2193' :
                  result.summary.trend.direction === 'degraded' ? '\u2191' : '\u2192';
    lines.push(`  Trend: ${arrow} ${result.summary.trend.direction} (${result.summary.trend.change >= 0 ? '+' : ''}${result.summary.trend.change})`);
  }

  return lines.join('\n');
}
