// ============================================
// All Interfaces & Types
// ============================================

export interface ThinkingStep {
  step: number;
  thought: string;
  timestamp: string;
}

export interface GraphNode {
  id: string;
  type: string;
  properties: Record<string, any>;
}

export interface GraphRelation {
  from: string;
  to: string;
  relation: string;
  properties?: Record<string, any>;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Issue {
  id: string;
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  column?: number;
  message: string;
  rule?: string;
  suggestion?: string;
}

export interface AnalysisMetadata {
  tool: string;
  version: string;
  timestamp: string;
  duration_ms: number;
  target: string;
}

export interface AnalysisSummary {
  total_issues: number;
  by_severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  trend?: {
    previous_total: number;
    change: number;
    direction: "improved" | "degraded" | "unchanged";
  };
}

export interface AnalysisResult {
  metadata: AnalysisMetadata;
  summary: AnalysisSummary;
  issues: Issue[];
  raw_output?: string;
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      required: string[];
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    };
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, any> } }>;
}

export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ============================================
// System Profile Types
// ============================================

export interface GpuInfo {
  name: string;
  vram_total_mb: number;
  vram_free_mb: number;
  detected_via: "nvidia-smi" | "ollama" | "manual" | "none";
}

export interface ModelTierProfile {
  tier: "light" | "fast" | "powerful";
  model_name: string;
  model_size_mb: number;
  fits_vram: boolean;
  max_num_ctx: number;
  safe_num_ctx: number;
  available_vram_mb: number;
}

export interface SystemProfile {
  version: number;
  created_at: string;
  gpu: GpuInfo;
  models: {
    light: ModelTierProfile;
    fast: ModelTierProfile;
    powerful: ModelTierProfile;
  };
  effective_config: {
    OLLAMA_MODEL_LIGHT: string;
    OLLAMA_MODEL_FAST: string;
    OLLAMA_MODEL_POWERFUL: string;
  };
}

export type ModelPurpose = "translation" | "code_review" | "agent" | "analysis" | "general";
