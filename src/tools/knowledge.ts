// ========== Knowledge Graph Memory Tools ==========

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { knowledgeGraph, nodeIndex } from "../state.js";
import { assertPathSafe } from "../security.js";
import type { GraphRelation, CallToolResult } from "../types.js";

export const definitions = [
  {
    name: "memory_add_node",
    description: "Add a node to the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique node ID" },
        type: { type: "string", description: "Node type (e.g., 'person', 'concept', 'file')" },
        properties: { type: "object", description: "Additional properties" },
      },
      required: ["id", "type"],
    },
  },
  {
    name: "memory_add_relation",
    description: "Add a relation between two nodes in the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source node ID" },
        to: { type: "string", description: "Target node ID" },
        relation: { type: "string", description: "Relation type (e.g., 'depends_on', 'created_by')" },
        properties: { type: "object", description: "Additional properties" },
      },
      required: ["from", "to", "relation"],
    },
  },
  {
    name: "memory_query_graph",
    description: "Query the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Find specific node by ID" },
        node_type: { type: "string", description: "Filter by node type" },
        relation: { type: "string", description: "Filter by relation type" },
      },
    },
  },
  {
    name: "memory_save_graph",
    description: "Save knowledge graph to a JSON file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", default: ".ai_knowledge_graph.json" } },
    },
  },
  {
    name: "memory_load_graph",
    description: "Load knowledge graph from a JSON file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", default: ".ai_knowledge_graph.json" } },
    },
  },
];

export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "memory_add_node": {
      const { id, type, properties = {} } = args as { id: string; type: string; properties?: Record<string, any> };
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
      const { from, to, relation, properties } = args as unknown as GraphRelation;
      const existing = knowledgeGraph.relations.findIndex(r => r.from === from && r.to === to && r.relation === relation);
      if (existing >= 0) {
        knowledgeGraph.relations[existing] = { from, to, relation, properties };
        return { content: [{ type: "text", text: `Updated relation: ${from} -[${relation}]-> ${to}` }] };
      }
      knowledgeGraph.relations.push({ from, to, relation, properties });
      return { content: [{ type: "text", text: `Added relation: ${from} -[${relation}]-> ${to}` }] };
    }
    case "memory_query_graph": {
      const { node_id, node_type, relation } = args as { node_id?: string; node_type?: string; relation?: string };
      let resultNodes = knowledgeGraph.nodes;
      let resultRelations = knowledgeGraph.relations;

      if (node_id) resultNodes = resultNodes.filter(n => n.id === node_id);
      if (node_type) resultNodes = resultNodes.filter(n => n.type === node_type);
      if (relation) resultRelations = resultRelations.filter(r => r.relation === relation);
      if (node_id) resultRelations = resultRelations.filter(r => r.from === node_id || r.to === node_id);

      return { content: [{ type: "text", text: JSON.stringify({ nodes: resultNodes, relations: resultRelations }, null, 2) }] };
    }
    case "memory_save_graph": {
      const { file_path = ".ai_knowledge_graph.json" } = args as { file_path?: string };
      const safePath = assertPathSafe(file_path, "save_graph");
      await writeFile(safePath, JSON.stringify(knowledgeGraph, null, 2), "utf-8");
      return { content: [{ type: "text", text: `Knowledge graph saved to ${file_path}` }] };
    }
    case "memory_load_graph": {
      const { file_path = ".ai_knowledge_graph.json" } = args as { file_path?: string };
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
