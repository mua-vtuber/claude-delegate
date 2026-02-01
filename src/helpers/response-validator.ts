// ============================================
// LLM Response Validator
// Detects suspicious patterns in LLM-generated output before writing to files.
// ============================================

import { logger } from "../logger.js";

interface SuspiciousPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium";
  message: string;
}

const SUSPICIOUS_PATTERNS: SuspiciousPattern[] = [
  {
    name: "shell_command_injection",
    pattern: /(\$\(|`|;|&&|\|\|)\s*(rm|dd|chmod|curl|wget|eval)/i,
    severity: "critical",
    message: "Shell command injection detected",
  },
  {
    name: "file_deletion_attempt",
    pattern: /rm\s+(-r|-f|-rf)\s+\//,
    severity: "critical",
    message: "Destructive file deletion detected",
  },
  {
    name: "privilege_escalation",
    pattern: /(sudo|chmod\s+[0-7]{3,4}|chown|su\s+root)/,
    severity: "high",
    message: "Privilege escalation attempt detected",
  },
  {
    name: "environment_manipulation",
    pattern: /export\s+(PATH|LD_LIBRARY_PATH|PYTHONPATH|NODE_PATH)\s*=/,
    severity: "high",
    message: "Environment variable manipulation detected",
  },
  {
    name: "dynamic_code_execution",
    pattern: /\b(eval|exec)\s*\(/,
    severity: "medium",
    message: "Dynamic code execution detected",
  },
];

export interface ValidationResult {
  safe: boolean;
  issues: Array<{ pattern: string; severity: string; message: string; line: number }>;
}

/**
 * Validate LLM-generated output for suspicious patterns before writing to files.
 * Returns safe=false only when critical-severity patterns are detected.
 *
 * @param response - LLM-generated text to validate
 * @param context - Context label for logging (e.g., tool name)
 * @returns Validation result with safety flag and list of detected issues
 */
export function validateLLMResponse(response: string, context: string): ValidationResult {
  const issues: ValidationResult["issues"] = [];

  const lines = response.split("\n");
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    for (const sp of SUSPICIOUS_PATTERNS) {
      if (sp.pattern.test(line)) {
        issues.push({
          pattern: sp.name,
          severity: sp.severity,
          message: sp.message,
          line: lineNum + 1,
        });
      }
    }
  }

  const hasCritical = issues.some(i => i.severity === "critical");
  if (issues.length > 0) {
    logger.warn({
      event: "llm_response_validation",
      context,
      issues_count: issues.length,
      has_critical: hasCritical,
      patterns: issues.map(i => i.pattern),
    });
  }

  return {
    safe: !hasCritical,
    issues,
  };
}
