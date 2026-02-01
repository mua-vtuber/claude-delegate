// ========== Knowledge Graph Memory Tools ==========

import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { knowledgeGraph, nodeIndex } from "../state.js";
import { assertPathSafe } from "../security.js";
import { createToolDefinition } from "../utils/schema-converter.js";
import type { GraphRelation, CallToolResult } from "../types.js";

// ===== Schemas =====
export const memoryAddNodeSchema = z.object({
  id: z.string().describe("Unique node ID"),
  type: z.string().describe("Node type (e.g., 'person', 'concept', 'file')"),
  properties: z.record(z.string(), z.unknown()).optional().describe("Additional properties"),
});

export const memoryAddRelationSchema = z.object({
  from: z.string().describe("Source node ID"),
  to: z.string().describe("Target node ID"),
  relation: z.string().describe("Relation type (e.g., 'depends_on', 'created_by')"),
  properties: z.record(z.string(), z.unknown()).optional().describe("Additional properties"),
});

export const memoryQueryGraphSchema = z.object({
  node_id: z.string().optional().describe("Find specific node by ID"),
  node_type: z.string().optional().describe("Filter by node type"),
  relation: z.string().optional().describe("Filter by relation type"),
});

export const memorySaveGraphSchema = z.object({
  file_path: z.string().optional().default(".ai_knowledge_graph.json"),
});

export const memoryLoadGraphSchema = z.object({
  file_path: z.string().optional().default(".ai_knowledge_graph.json"),
});

// ===== Definitions =====
export const definitions = [
  createToolDefinition("memory_add_node", "Add a node to the knowledge graph.", memoryAddNodeSchema),
  createToolDefinition("memory_add_relation", "Add a relation between two nodes in the knowledge graph.", memoryAddRelationSchema),
  createToolDefinition("memory_query_graph", "Query the knowledge graph.", memoryQueryGraphSchema),
  createToolDefinition("memory_save_graph", "Save knowledge graph to a JSON file.", memorySaveGraphSchema),
  createToolDefinition("memory_load_graph", "Load knowledge graph from a JSON file.", memoryLoadGraphSchema),
];

// ===== Schema Exports =====
export const allSchemas: Record<string, z.ZodType> = {
  memory_add_node: memoryAddNodeSchema,
  memory_add_relation: memoryAddRelationSchema,
  memory_query_graph: memoryQueryGraphSchema,
  memory_save_graph: memorySaveGraphSchema,
  memory_load_graph: memoryLoadGraphSchema,
};

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "memory_add_node": {
      const { id, type, properties = {} } = memoryAddNodeSchema.parse(args);
      const existingIdx = nodeIndex.get(id);
      if (existingIdx !== undefined) {
        knowledgeGraph.nodes[existingIdx] = { id, type, properties };
        return { content: [{ type: "text", text: `Updated node: ${id}` }] };
      }
      nodeIndex.set(id, knowledgeGraph.nodes.length);
      knowledgeGraph.nodes.push({ id, type, properties });
      return { content: [{ type: "text", text: `Added node: ${id} (${type})` }] };
    }
    case "memory_add_relation": {
      const parsed = memoryAddRelationSchema.parse(args);
      const { from, to, relation, properties } = parsed as unknown as GraphRelation;
      const existing = knowledgeGraph.relations.findIndex(r => r.from === from && r.to === to && r.relation === relation);
      if (existing >= 0) {
        knowledgeGraph.relations[existing] = { from, to, relation, properties };
        return { content: [{ type: "text", text: `Updated relation: ${from} -[${relation}]-> ${to}` }] };
      }
      knowledgeGraph.relations.push({ from, to, relation, properties });
      return { content: [{ type: "text", text: `Added relation: ${from} -[${relation}]-> ${to}` }] };
    }
    case "memory_query_graph": {
      const { node_id, node_type, relation } = memoryQueryGraphSchema.parse(args);
      let resultNodes = knowledgeGraph.nodes;
      let resultRelations = knowledgeGraph.relations;

      if (node_id) resultNodes = resultNodes.filter(n => n.id === node_id);
      if (node_type) resultNodes = resultNodes.filter(n => n.type === node_type);
      if (relation) resultRelations = resultRelations.filter(r => r.relation === relation);
      if (node_id) resultRelations = resultRelations.filter(r => r.from === node_id || r.to === node_id);

      return { content: [{ type: "text", text: JSON.stringify({ nodes: resultNodes, relations: resultRelations }, null, 2) }] };
    }
    case "memory_save_graph": {
      const { file_path } = memorySaveGraphSchema.parse(args);
      const safePath = assertPathSafe(file_path, "save_graph");
      await writeFile(safePath, JSON.stringify(knowledgeGraph, null, 2), "utf-8");
      return { content: [{ type: "text", text: `Knowledge graph saved to ${file_path}` }] };
    }
    case "memory_load_graph": {
      const { file_path } = memoryLoadGraphSchema.parse(args);
      const fullPath = assertPathSafe(file_path, "load_graph");
      if (!existsSync(fullPath)) return { content: [{ type: "text", text: `File not found: ${fullPath}` }] };

      const data = JSON.parse(await readFile(fullPath, "utf-8"));
      if (!Array.isArray(data.nodes) || !Array.isArray(data.relations)) {
        throw new Error("Invalid knowledge graph format: expected { nodes: [], relations: [] }");
      }
      // Filter out prototype pollution keys
      data.nodes = data.nodes.filter((n: any) => n && typeof n.id === "string" && !n.id.startsWith("__"));
      data.relations = data.relations.filter((r: any) => r && typeof r.from === "string" && typeof r.to === "string");

      knowledgeGraph.nodes = data.nodes || [];
      knowledgeGraph.relations = data.relations || [];

      // Rebuild node index
      nodeIndex.clear();
      knowledgeGraph.nodes.forEach((n, i) => nodeIndex.set(n.id, i));

      return { content: [{ type: "text", text: `Loaded ${knowledgeGraph.nodes.length} nodes and ${knowledgeGraph.relations.length} relations` }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
