import { z } from "zod";
import { assertPathSafe } from "../security.js";
import { ollamaChat } from "../helpers/ollama.js";
import { OLLAMA_MODELS } from "../helpers/routing.js";
import { LocalVectorStore } from "../helpers/vectorstore.js";
import { saveReviewToFile } from "../helpers/filesystem.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { CallToolResult } from "../types.js";

// Shared vector store instance
let vectorStore: LocalVectorStore | null = null;

function getStore(): LocalVectorStore {
  if (!vectorStore) {
    vectorStore = new LocalVectorStore();
  }
  return vectorStore;
}

// ===== Schemas =====
export const ragIndexSchema = z.object({
  paths: z.array(z.string()).describe("Files or directories to index"),
  clear: z.boolean().optional().default(false).describe("Clear existing index first"),
  save: z.boolean().optional().default(true).describe("Save index to disk after indexing"),
});

export const ragSearchSchema = z.object({
  query: z.string().describe("Search query"),
  top_k: z.number().optional().default(5).describe("Number of results to return"),
});

export const ragAskSchema = z.object({
  question: z.string().describe("Question to answer"),
  top_k: z.number().optional().default(5).describe("Number of context chunks to retrieve"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("rag_index", "Index a directory or file list into the vector store for RAG search. Uses Ollama embeddings.", ragIndexSchema),
  createToolDefinition("rag_search", "Search the vector index for code chunks relevant to a query. Returns top-K similar chunks.", ragSearchSchema),
  createToolDefinition("rag_ask", "RAG-powered question answering: search relevant code, then ask Ollama to answer based on retrieved context.", ragAskSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  rag_index: ragIndexSchema,
  rag_search: ragSearchSchema,
  rag_ask: ragAskSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "rag_index": {
      const { paths, clear, save } = ragIndexSchema.parse(args);
      const store = getStore();

      if (clear) store.clear();

      // Try to load existing index
      if (!clear && store.size === 0) {
        await store.load();
      }

      let totalFiles = 0;
      let totalChunks = 0;

      for (const p of paths) {
        const safePath = assertPathSafe(p, "rag_index");
        const result = await store.addDirectory(safePath);
        totalFiles += result.files;
        totalChunks += result.chunks;
      }

      if (save) {
        await store.save();
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            indexed_files: totalFiles,
            indexed_chunks: totalChunks,
            total_store_size: store.size,
            saved: save,
          }, null, 2),
        }],
      };
    }

    case "rag_search": {
      const { query, top_k } = ragSearchSchema.parse(args);
      const store = getStore();

      // Auto-load if empty
      if (store.size === 0) {
        const loaded = await store.load();
        if (!loaded) {
          throw new Error("No vector index found. Run rag_index first.");
        }
      }

      const results = await store.search(query, top_k);

      const formatted = results.map((r, i) => ({
        rank: i + 1,
        score: Math.round(r.score * 1000) / 1000,
        file: r.metadata.file,
        lines: `${r.metadata.start_line}-${r.metadata.end_line}`,
        preview: r.text.substring(0, 200) + (r.text.length > 200 ? "..." : ""),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
      };
    }

    case "rag_ask": {
      const { question, top_k } = ragAskSchema.parse(args);
      const store = getStore();

      // Auto-load if empty
      if (store.size === 0) {
        const loaded = await store.load();
        if (!loaded) {
          throw new Error("No vector index found. Run rag_index first.");
        }
      }

      // Step 1: Retrieve relevant chunks
      const results = await store.search(question, top_k);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No relevant code found in the index." }],
        };
      }

      // Step 2: Build context from retrieved chunks
      const context = results
        .map((r, i) => `### Chunk ${i + 1} (${r.metadata.file}:${r.metadata.start_line}-${r.metadata.end_line}, score: ${r.score.toFixed(3)})\n\`\`\`\n${r.text}\n\`\`\``)
        .join("\n\n");

      // Step 3: Ask LLM with context
      const prompt = `Based on the following code context, answer the question.\n\n## Retrieved Code Context:\n${context}\n\n## Question:\n${question}\n\nProvide a detailed answer based on the code above.`;

      const { text: response, model: usedModel } = await ollamaChat(OLLAMA_MODELS.powerful, prompt);

      // Save to file
      const reviewPath = await saveReviewToFile(
        `# RAG Answer\n\n**Question:** ${question}\n**Chunks retrieved:** ${results.length}\n**Model:** ${usedModel}\n\n---\n\n${response}\n\n---\n\n## Retrieved Context\n\n${context}`,
        "rag_answer"
      );

      return {
        content: [{
          type: "text",
          text: `Answer saved to: ${reviewPath}\n\n${response}`,
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
