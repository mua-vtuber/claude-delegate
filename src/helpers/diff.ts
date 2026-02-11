// Myers diff algorithm implementation
export interface DiffLine {
  type: "equal" | "insert" | "delete";
  content: string;
}

/**
 * Compute diff using Myers algorithm
 * @param a First array of lines
 * @param b Second array of lines
 * @returns Array of diff lines with type equal/insert/delete
 */
export function computeDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v: Map<number, number> = new Map();
  const trace: Map<number, number>[] = [];

  v.set(1, 0);

  // Find the shortest edit script
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      let x: number;

      // Determine if we should move down or right
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0; // Move down (delete from a)
      } else {
        x = (v.get(k - 1) ?? 0) + 1; // Move right (insert from b)
      }

      let y = x - k;

      // Follow diagonal (equal lines)
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v.set(k, x);

      // Check if we've reached the end
      if (x >= n && y >= m) {
        return backtrack(a, b, trace, d);
      }
    }
  }

  // Should never reach here if inputs are valid
  return [];
}

/**
 * Backtrack through the trace to construct the diff
 */
function backtrack(a: string[], b: string[], trace: Map<number, number>[], d: number): DiffLine[] {
  const result: DiffLine[] = [];
  let x = a.length;
  let y = b.length;

  // Walk backwards through the trace
  for (let depth = d; depth >= 0; depth--) {
    const v = trace[depth];
    const k = x - y;

    let prevK: number;
    if (k === -depth || (k !== depth && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // Follow diagonal backwards
    while (x > prevX && y > prevY) {
      result.unshift({ type: "equal", content: a[x - 1] });
      x--;
      y--;
    }

    // Add the edit operation
    if (depth > 0) {
      if (x === prevX) {
        // Insert
        result.unshift({ type: "insert", content: b[y - 1] });
        y--;
      } else {
        // Delete
        result.unshift({ type: "delete", content: a[x - 1] });
        x--;
      }
    }
  }

  return result;
}

/**
 * Format diff lines as unified diff format
 * @param diffLines Array of diff lines
 * @param contextLines Number of context lines to include
 * @param labelA Label for first file
 * @param labelB Label for second file
 * @returns Unified diff format string
 */
export function formatUnifiedDiff(
  diffLines: DiffLine[],
  contextLines: number,
  labelA?: string,
  labelB?: string
): string {
  const result: string[] = [];

  if (labelA) result.push(`--- ${labelA}`);
  if (labelB) result.push(`+++ ${labelB}`);

  // Find hunks (groups of changes with context)
  const hunks = findHunks(diffLines, contextLines);

  for (const hunk of hunks) {
    // Calculate hunk header
    const oldStart = hunk.oldStart + 1; // 1-indexed
    const oldLines = hunk.oldCount;
    const newStart = hunk.newStart + 1; // 1-indexed
    const newLines = hunk.newCount;

    result.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);

    // Add hunk lines
    for (const line of hunk.lines) {
      switch (line.type) {
        case "equal":
          result.push(` ${line.content}`);
          break;
        case "insert":
          result.push(`+${line.content}`);
          break;
        case "delete":
          result.push(`-${line.content}`);
          break;
      }
    }
  }

  return result.join("\n");
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * Group diff lines into hunks with context
 */
function findHunks(diffLines: DiffLine[], contextLines: number): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let contextCount = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    const isChange = line.type !== "equal";

    if (isChange) {
      // Start a new hunk or extend current one
      if (!currentHunk) {
        // Include preceding context
        const contextStart = Math.max(0, i - contextLines);
        currentHunk = {
          oldStart: oldLine - (i - contextStart),
          oldCount: 0,
          newStart: newLine - (i - contextStart),
          newCount: 0,
          lines: [],
        };

        // Add preceding context
        for (let j = contextStart; j < i; j++) {
          currentHunk.lines.push(diffLines[j]);
          currentHunk.oldCount++;
          currentHunk.newCount++;
        }
      }

      contextCount = 0;
      currentHunk.lines.push(line);

      if (line.type === "delete") {
        currentHunk.oldCount++;
        oldLine++;
      } else if (line.type === "insert") {
        currentHunk.newCount++;
        newLine++;
      }
    } else {
      // Equal line
      if (currentHunk) {
        currentHunk.lines.push(line);
        currentHunk.oldCount++;
        currentHunk.newCount++;
        contextCount++;

        // Check if we should close the hunk
        if (contextCount >= contextLines * 2) {
          // Keep only the first contextLines
          const excessContext = contextCount - contextLines;
          currentHunk.oldCount -= excessContext;
          currentHunk.newCount -= excessContext;
          currentHunk.lines.splice(currentHunk.lines.length - excessContext);

          hunks.push(currentHunk);
          currentHunk = null;
          contextCount = 0;
        }
      }

      oldLine++;
      newLine++;
    }
  }

  // Close any remaining hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}
