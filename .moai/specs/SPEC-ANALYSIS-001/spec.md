# SPEC-ANALYSIS-001: Enhanced Code Analysis Reports

## Metadata

| Field | Value |
|-------|-------|
| SPEC ID | SPEC-ANALYSIS-001 |
| Title | Enhanced Code Analysis Reports |
| Created | 2026-01-28 |
| Status | Completed |
| Priority | High |
| Assigned | manager-ddd |

---

## Environment

### Project Context
- **Project**: Claude Delegate MCP Server v3.2.0
- **Language**: TypeScript 5.0+
- **Runtime**: Node.js 18+
- **Module System**: ES Modules

### Target Files
- `src/index.ts` - Main MCP server implementation (2154 lines)

### Affected Tools
| Tool | Lines | Current State |
|------|-------|---------------|
| `code_review` | 1396-1412 | Unstructured markdown output |
| `check_types` | 1788-1809 | Raw CLI passthrough |
| `run_linter` | 1810-1835 | Raw CLI passthrough |
| `analyze_dependencies` | 1727-1764 | Basic JSON output |
| `find_unused_exports` | 1765-1787 | Simple array output |

---

## Assumptions

### Technical Assumptions
- A1: 기존 도구들은 정상적으로 외부 CLI를 호출하고 있다
- A2: MCP SDK의 응답 형식은 text content를 지원한다
- A3: JSON Schema 기반 검증이 런타임에서 가능하다

### Business Assumptions
- B1: 사용자는 구조화된 분석 결과를 선호한다
- B2: 심각도 분류가 우선순위 결정에 도움이 된다
- B3: 트렌드 분석은 코드 품질 모니터링에 유용하다

### Constraint Assumptions
- C1: 하위 호환성이 유지되어야 한다 (기존 출력 형식 옵션 제공)
- C2: 성능 저하는 최소화되어야 한다 (10% 이내)

---

## Requirements

### Ubiquitous Requirements (항상 적용)

**REQ-U1**: 시스템은 **항상** 모든 코드 분석 결과를 AnalysisResult JSON Schema에 따라 출력해야 한다

**REQ-U2**: 시스템은 **항상** 모든 분석 이슈에 심각도 레벨(critical/high/medium/low/info)을 할당해야 한다

**REQ-U3**: 시스템은 **항상** 분석 메타데이터(도구명, 타임스탬프, 버전)를 결과에 포함해야 한다

### Event-Driven Requirements (이벤트 기반)

**REQ-E1**: **WHEN** 코드 분석 도구가 실행될 **THEN** 결과는 `.ai_reviews/` 디렉토리에 JSON 형식으로 저장되어야 한다

**REQ-E2**: **WHEN** 동일한 파일에 대한 반복 분석이 요청될 **THEN** 캐시된 결과와 비교하여 변경사항만 표시해야 한다

**REQ-E3**: **WHEN** 분석이 완료될 **THEN** 심각도별 요약 통계를 제공해야 한다

**REQ-E4**: **WHEN** 분석 중 오류가 발생할 **THEN** 구조화된 에러 객체를 반환해야 한다

### State-Driven Requirements (상태 기반)

**REQ-S1**: **IF** 이전 분석 결과가 존재하면 **THEN** 이슈 개수의 증감 트렌드를 표시해야 한다

**REQ-S2**: **IF** `--json` 플래그가 제공되면 **THEN** 순수 JSON만 출력해야 한다

**REQ-S3**: **IF** `--summary` 플래그가 제공되면 **THEN** 요약 통계만 출력해야 한다

### Unwanted Requirements (금지 사항)

**REQ-W1**: 시스템은 분석 결과에 민감한 파일 내용(credentials, secrets)을 **포함하지 않아야 한다**

**REQ-W2**: 시스템은 원본 CLI 출력의 ANSI 색상 코드를 결과에 **포함하지 않아야 한다**

### Optional Requirements (선택 사항)

**REQ-O1**: **가능하면** 각 이슈에 대해 자동 수정 제안을 제공해야 한다

**REQ-O2**: **가능하면** 유사한 과거 이슈에 대한 해결 패턴을 제안해야 한다

---

## Specifications

### AnalysisResult JSON Schema

```typescript
interface AnalysisResult {
  metadata: {
    tool: string;           // e.g., "check_types", "run_linter"
    version: string;        // e.g., "3.2.0"
    timestamp: string;      // ISO 8601
    duration_ms: number;    // Execution time
    target: string;         // Analyzed path
  };
  summary: {
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
      change: number;       // positive = increase
      direction: "improved" | "degraded" | "unchanged";
    };
  };
  issues: Issue[];
  raw_output?: string;      // Original CLI output (optional)
}

interface Issue {
  id: string;               // Unique identifier
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;         // e.g., "type-error", "lint-error"
  file: string;
  line?: number;
  column?: number;
  message: string;
  rule?: string;            // e.g., "no-unused-vars"
  suggestion?: string;      // Fix suggestion
}
```

### Tool-Specific Severity Mapping

| Tool | Critical | High | Medium | Low | Info |
|------|----------|------|--------|-----|------|
| check_types | - | Type errors | - | - | - |
| run_linter | Security rules | Error rules | Warning rules | Style rules | Disabled rules |
| code_review | Security issues | Logic errors | Code smells | Suggestions | Comments |
| analyze_dependencies | Major vulnerabilities | Minor vulnerabilities | Outdated packages | - | Stats |
| find_unused_exports | - | - | Unused exports | - | Export stats |

### Caching Strategy

- Cache key: `${tool}_${path}_${hash(content)}`
- Cache TTL: 5 minutes (configurable)
- Storage: In-memory Map with cleanup interval
- Trend comparison: Compare with last cached result

---

## Traceability

### Related Documents
- Product: `.moai/project/product.md` - Core Features Section 4
- Tech Stack: `.moai/project/tech.md` - Code Analysis Tools

### Implementation References
- Target file: `src/index.ts`
- Output directory: `.ai_reviews/`
- Cache storage: In-memory (existing `responseCache` Map)

---

## Tags

`#code-analysis` `#structured-output` `#quality-improvement` `#developer-experience`
