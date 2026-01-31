// ========== Web & Research Tools ==========

import { stripHtml } from "../helpers/filesystem.js";
import { assertUrlSafe } from "../security.js";
import type { CallToolResult } from "../types.js";

export const definitions = [
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
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "fetch_url": {
      const { url } = args as { url: string };
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
