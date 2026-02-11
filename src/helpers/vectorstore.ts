import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, extname } from "path";
import { ollamaEmbeddings } from "./ollama.js";
import { getAllFiles } from "./filesystem.js";

const DEFAULT_INDEX_PATH = ".ai_vector_index.json";
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_OVERLAP = 10;

interface VectorEntry {
  id: string;
  embedding: number[];
  text: string;
  metadata: {
    file: string;
    start_line: number;
    end_line: number;
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE, overlap: number = DEFAULT_OVERLAP): Array<{ text: string; startLine: number; endLine: number }> {
  const lines = text.split("\n");
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];

  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const end = Math.min(i + chunkSize, lines.length);
    chunks.push({
      text: lines.slice(i, end).join("\n"),
      startLine: i + 1,
      endLine: end,
    });
    if (end >= lines.length) break;
  }

  return chunks;
}

/**
 * Local vector store for semantic search over code documents.
 * Uses Ollama embeddings for vector generation and cosine similarity for search.
 */
export class LocalVectorStore {
  private entries: VectorEntry[] = [];
  private model: string;

  /**
   * Create a new vector store instance.
   *
   * @param model - Ollama embedding model name (default: "nomic-embed-text")
   */
  constructor(model: string = "nomic-embed-text") {
    this.model = model;
  }

  /**
   * Add a document to the vector store by chunking and embedding it.
   * Skips chunks that are too small or fail to embed.
   *
   * @param filePath - Path to the document file
   * @param chunkSize - Optional chunk size in lines (default: 50)
   * @returns Number of chunks successfully added
   */
  async addDocument(filePath: string, chunkSize?: number): Promise<number> {
    const fullPath = resolve(filePath);
    const content = await readFile(fullPath, "utf-8");
    const chunks = chunkText(content, chunkSize);
    let added = 0;

    for (const chunk of chunks) {
      if (chunk.text.trim().length < 10) continue; // Skip tiny chunks

      try {
        const embedding = await ollamaEmbeddings(this.model, chunk.text);
        this.entries.push({
          id: `${filePath}:${chunk.startLine}-${chunk.endLine}`,
          embedding,
          text: chunk.text,
          metadata: {
            file: filePath,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
          },
        });
        added++;
      } catch {
        // Skip chunks that fail to embed
      }
    }

    return added;
  }

  /**
   * Recursively add all source code files from a directory.
   * Filters by common source file extensions.
   *
   * @param dirPath - Directory path to scan
   * @returns Object containing file count and chunk count
   */
  async addDirectory(dirPath: string): Promise<{ files: number; chunks: number }> {
    const sourceExtensions = [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".tsx", ".jsx"];
    const files = await getAllFiles(resolve(dirPath));
    const sourceFiles = files.filter(f => sourceExtensions.includes(extname(f)));

    let totalChunks = 0;
    for (const file of sourceFiles) {
      const added = await this.addDocument(file);
      totalChunks += added;
    }

    return { files: sourceFiles.length, chunks: totalChunks };
  }

  /**
   * Search the vector store for relevant chunks using semantic similarity.
   *
   * @param query - Search query text
   * @param topK - Number of top results to return (default: 5)
   * @returns Array of matching entries with similarity scores (0-1)
   */
  async search(query: string, topK: number = 5): Promise<Array<VectorEntry & { score: number }>> {
    if (this.entries.length === 0) return [];

    const queryEmbedding = await ollamaEmbeddings(this.model, query);

    const scored = this.entries.map(entry => ({
      ...entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Save the vector store to a JSON file.
   *
   * @param path - Output file path (default: ".ai_vector_index.json")
   */
  async save(path: string = DEFAULT_INDEX_PATH): Promise<void> {
    const fullPath = resolve(path);
    await writeFile(fullPath, JSON.stringify({
      model: this.model,
      count: this.entries.length,
      entries: this.entries,
    }, null, 2), "utf-8");
  }

  /**
   * Load a vector store from a JSON file.
   *
   * @param path - Input file path (default: ".ai_vector_index.json")
   * @returns True if loaded successfully, false if file not found or invalid
   */
  async load(path: string = DEFAULT_INDEX_PATH): Promise<boolean> {
    const fullPath = resolve(path);
    if (!existsSync(fullPath)) return false;

    try {
      const data = JSON.parse(await readFile(fullPath, "utf-8"));
      if (data.model) this.model = data.model;
      if (Array.isArray(data.entries)) this.entries = data.entries;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the number of indexed chunks.
   *
   * @returns Total number of vector entries
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Clear all entries from the vector store.
   */
  clear(): void {
    this.entries = [];
  }
}
