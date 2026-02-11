// ========== Web & Research Tools ==========

import { z } from "zod";
import { stripHtml } from "../helpers/filesystem.js";
import { assertUrlSafe } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// ===== Schemas =====
export const fetchUrlSchema = z.object({
  url: z.string().describe("URL to fetch (http/https)"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("fetch_url", "Fetch and extract text content from a URL. Useful for reading documentation or articles.", fetchUrlSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  fetch_url: fetchUrlSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "fetch_url": {
      const { url } = fetchUrlSchema.parse(args);
      await assertUrlSafe(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
        });

        // Check for redirects - return redirect info instead of following
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          return {
            content: [{ type: "text", text: `Redirect detected (${response.status}) to: ${location}. Fetch the redirect URL separately after validation.` }],
          };
        }

        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        const html = await response.text();
        const text = stripHtml(html);
        return { content: [{ type: "text", text: text.substring(0, 8000) + (text.length > 8000 ? "...(truncated)" : "") }] };
      } finally {
        clearTimeout(timeout);
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
