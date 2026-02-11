// ============================================
// File System Helpers & Review Output Helpers
// ============================================

import { readFile, writeFile, readdir, lstat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { REVIEW_OUTPUT_DIR } from "../config.js";

/**
 * Generate a timestamped file path for code review output.
 * Creates the review output directory if it doesn't exist.
 *
 * @param type - Review type identifier (e.g., "code_review", "security")
 * @returns Full path to the review file
 */
export async function generateReviewPath(type: string): Promise<string> {
  const dir = resolve(REVIEW_OUTPUT_DIR);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(dir, `${type}_${timestamp}.md`);
}

/**
 * Save review content to a timestamped markdown file.
 *
 * @param content - Review content in markdown format
 * @param type - Review type identifier
 * @returns Path to the saved review file
 */
export async function saveReviewToFile(content: string, type: string): Promise<string> {
  const filePath = await generateReviewPath(type);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

const MAX_DEPTH = 10;
const MAX_FILES = 10_000;

/**
 * Recursively get all file paths in a directory.
 * Excludes common build artifacts and hidden directories. Follows safety limits for depth and file count.
 *
 * @param dirPath - Directory path to scan
 * @param arrayOfFiles - Accumulator array (internal use)
 * @param maxDepth - Maximum recursion depth (default: 10)
 * @param maxFiles - Maximum file count (default: 10,000)
 * @param _currentDepth - Current depth (internal use)
 * @returns Array of absolute file paths
 */
export async function getAllFiles(
  dirPath: string,
  arrayOfFiles: string[] = [],
  maxDepth: number = MAX_DEPTH,
  maxFiles: number = MAX_FILES,
  _currentDepth: number = 0
): Promise<string[]> {
  if (_currentDepth >= maxDepth || arrayOfFiles.length >= maxFiles) return arrayOfFiles;

  const files = await readdir(dirPath);

  for (const file of files) {
    if (arrayOfFiles.length >= maxFiles) break;
    const fullPath = join(dirPath, file);
    try {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) continue; // Skip symlinks to prevent cycles
      if (stat.isDirectory()) {
        if (
          file !== "node_modules" &&
          file !== ".git" &&
          file !== "dist" &&
          file !== "build" &&
          file !== "coverage" &&
          !file.startsWith(".")
        ) {
          arrayOfFiles = await getAllFiles(fullPath, arrayOfFiles, maxDepth, maxFiles, _currentDepth + 1);
        }
      } else {
        arrayOfFiles.push(fullPath);
      }
    } catch {
      // Permission errors, broken symlinks — skip
    }
  }

  return arrayOfFiles;
}

const MAX_PATTERN_LENGTH = 200;

/**
 * Search for files containing a regex pattern.
 * Falls back to literal string matching if pattern is invalid regex.
 *
 * @param dirPath - Directory path to search in
 * @param pattern - Regex pattern to search for
 * @returns Array of file paths containing the pattern
 * @throws Error if pattern exceeds maximum length (200 chars)
 */
export async function searchInFiles(dirPath: string, pattern: string): Promise<string[]> {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Search pattern too long (max ${MAX_PATTERN_LENGTH} characters)`);
  }

  const results: string[] = [];
  const files = await getAllFiles(dirPath);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    // Invalid regex: fall back to literal string matching
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      if (regex.test(content)) {
        results.push(file);
      }
    } catch {
      // binary files or permission errors ignored
    }
  }
  return results;
}

/**
 * Strip HTML tags and scripts from HTML content.
 * Simple converter for extracting text from web pages.
 *
 * @param html - HTML content
 * @returns Plain text with tags removed and whitespace normalized
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
