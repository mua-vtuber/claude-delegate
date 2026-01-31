// ============================================
// Path Validation & Security
// ============================================

import { resolve, basename } from "path";
import { realpathSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { PROJECT_ROOT } from "./config.js";
import { logger } from "./logger.js";

export function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    // File doesn't exist yet (write operation) - use resolve result
    realPath = resolved;
  }
  const normalized = realPath.replace(/\\/g, '/').toLowerCase();
  const rootNormalized = PROJECT_ROOT.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith(rootNormalized);
}

export function assertPathSafe(targetPath: string, operation: string): string {
  const resolved = resolve(targetPath);
  if (!isPathSafe(resolved)) {
    logger.warn({ event: "security_violation", type: "path_traversal", path: targetPath, operation });
    throw new Error(`Security: ${operation} outside project directory is not allowed. Path: ${targetPath}`);
  }
  return resolved;
}

// Agent command allowlist (configurable via AGENT_ALLOWED_COMMANDS env var)
const DEFAULT_AGENT_COMMANDS = "ls,dir,cat,type,find,grep,rg,head,tail,wc,node,npm,npx,tsc,python,pip,git,echo,pwd,where,which,whoami";
export const ALLOWED_AGENT_COMMANDS = new Set(
  (process.env.AGENT_ALLOWED_COMMANDS || DEFAULT_AGENT_COMMANDS)
    .split(",")
    .map((cmd) => cmd.trim().toLowerCase())
    .filter(Boolean)
);

// URL validation for SSRF protection
const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./,
  /^\[?::1\]?$/, /^localhost$/i,
];

function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
  }
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    return isPrivateIP(mapped);
  }
  return false;
}

export async function assertUrlSafe(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn({ event: "security_violation", type: "unsafe_url", url });
    throw new Error(`Security: Invalid URL format: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    logger.warn({ event: "security_violation", type: "unsafe_url", url });
    throw new Error(`Security: Only http/https URLs are allowed. Got: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (PRIVATE_IP_PATTERNS.some(p => p.test(hostname))) {
    logger.warn({ event: "security_violation", type: "unsafe_url", url });
    throw new Error(`Security: Access to private/internal network addresses is not allowed: ${hostname}`);
  }

  // Resolve DNS and check actual IP to prevent IPv6/hex/decimal bypasses
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      logger.warn({ event: "security_violation", type: "unsafe_url", url, resolved_ip: address });
      throw new Error(`Security: URL resolves to private IP address`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Security:")) throw err;
    // DNS resolution failure - allow (could be non-resolvable hostname for other reasons)
  }
}

// Sensitive environment variable denylist
const DEFAULT_SENSITIVE_PATTERNS = ["SECRET", "KEY", "TOKEN", "PASSWORD", "CREDENTIAL", "PRIVATE"];
export const SENSITIVE_ENV_PATTERNS = new Set(
  (process.env.SENSITIVE_ENV_DENYLIST || DEFAULT_SENSITIVE_PATTERNS.join(","))
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
);

export function isSensitiveEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return [...SENSITIVE_ENV_PATTERNS].some(pattern => upper.includes(pattern));
}

export function assertCommandAllowed(command: string): void {
  const cmd = basename(command).toLowerCase().replace(/\.exe$/, "");
  if (!ALLOWED_AGENT_COMMANDS.has(cmd)) {
    logger.warn({ event: "security_violation", type: "blocked_command", command });
    throw new Error(
      `Security: Command "${command}" is not in the agent allowlist. ` +
      `Allowed: ${[...ALLOWED_AGENT_COMMANDS].join(", ")}. ` +
      `Set AGENT_ALLOWED_COMMANDS env var to extend.`
    );
  }
}

const DANGEROUS_ARGS: Record<string, string[]> = {
  "node": ["-e", "--eval", "--input-type", "-p", "--print"],
  "python": ["-c", "-m"],
  "python3": ["-c", "-m"],
  "npm": ["exec"],
  "npx": [],  // npx itself runs arbitrary packages - already risky but keep for compatibility
};

export function assertArgsAllowed(command: string, args: string[]): void {
  const cmd = basename(command).toLowerCase().replace(/\.exe$/, "");
  const blockedArgs = DANGEROUS_ARGS[cmd];
  if (!blockedArgs) return;

  for (const arg of args) {
    const lowerArg = arg.toLowerCase();
    if (blockedArgs.some(blocked => lowerArg === blocked || lowerArg.startsWith(blocked + "="))) {
      logger.warn({ event: "security_violation", type: "blocked_argument", command, arg });
      throw new Error(
        `Security: Argument "${arg}" is not allowed for command "${command}".`
      );
    }
  }
}
