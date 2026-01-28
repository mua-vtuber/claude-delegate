# SPEC-ANALYSIS-001: Acceptance Criteria

## Metadata

| Field | Value |
|-------|-------|
| SPEC ID | SPEC-ANALYSIS-001 |
| Title | Enhanced Code Analysis Reports - Acceptance Criteria |
| Created | 2026-01-28 |

---

## Test Scenarios

### AC1: Structured Output Schema Compliance

**Given** 코드베이스가 존재할 때
**When** `check_types` 도구가 실행되면
**Then** 결과는 AnalysisResult JSON Schema를 준수해야 한다

**Verification Method:**
```typescript
// Schema validation
const result = await callTool("check_types", { dir_path: "." });
const parsed = JSON.parse(result.content[0].text);

assert(parsed.metadata.tool === "check_types");
assert(typeof parsed.metadata.timestamp === "string");
assert(typeof parsed.summary.total_issues === "number");
assert(Array.isArray(parsed.issues));
```

**Expected Output Structure:**
```json
{
  "metadata": {
    "tool": "check_types",
    "version": "3.2.0",
    "timestamp": "2026-01-28T10:00:00.000Z",
    "duration_ms": 1234,
    "target": "."
  },
  "summary": {
    "total_issues": 5,
    "by_severity": {
      "critical": 0,
      "high": 5,
      "medium": 0,
      "low": 0,
      "info": 0
    }
  },
  "issues": [...]
}
```

---

### AC2: Severity Classification

**Given** 타입 에러가 있는 TypeScript 파일이 존재할 때
**When** `check_types` 도구가 실행되면
**Then** 모든 타입 에러는 "high" 심각도로 분류되어야 한다

**Given** 린트 경고가 있는 JavaScript 파일이 존재할 때
**When** `run_linter` 도구가 실행되면
**Then** 경고는 "medium" 심각도로, 에러는 "high" 심각도로 분류되어야 한다

**Verification Method:**
```typescript
const result = await callTool("check_types", { dir_path: "." });
const parsed = JSON.parse(result.content[0].text);

for (const issue of parsed.issues) {
  assert(["critical", "high", "medium", "low", "info"].includes(issue.severity));
}
```

---

### AC3: Trend Analysis

**Given** 이전 분석 결과가 캐시에 존재할 때
**When** 동일한 도구로 동일한 경로를 재분석하면
**Then** 결과에 트렌드 정보(이전 총계, 변화량, 방향)가 포함되어야 한다

**Verification Method:**
```typescript
// First analysis
const result1 = await callTool("check_types", { dir_path: "." });
// Second analysis (same path)
const result2 = await callTool("check_types", { dir_path: "." });

const parsed = JSON.parse(result2.content[0].text);
assert(parsed.summary.trend !== undefined);
assert(typeof parsed.summary.trend.previous_total === "number");
assert(typeof parsed.summary.trend.change === "number");
assert(["improved", "degraded", "unchanged"].includes(parsed.summary.trend.direction));
```

**Expected Trend Output:**
```json
{
  "summary": {
    "trend": {
      "previous_total": 5,
      "change": -2,
      "direction": "improved"
    }
  }
}
```

---

### AC4: JSON-Only Output Mode

**Given** 분석 결과가 있을 때
**When** `output_format: "json"` 옵션과 함께 도구가 호출되면
**Then** 순수 JSON만 반환되어야 한다 (마크다운 없음)

**Verification Method:**
```typescript
const result = await callTool("check_types", {
  dir_path: ".",
  output_format: "json"
});

const text = result.content[0].text;
assert(text.startsWith("{") && text.endsWith("}"));
JSON.parse(text); // Should not throw
```

---

### AC5: Severity Ordering

**Given** 여러 심각도의 이슈가 발견될 때
**When** 결과가 반환되면
**Then** 이슈는 심각도 순서(critical > high > medium > low > info)로 정렬되어야 한다

**Verification Method:**
```typescript
const severityOrder = ["critical", "high", "medium", "low", "info"];

const result = await callTool("run_linter", { dir_path: "." });
const parsed = JSON.parse(result.content[0].text);

let prevSeverityIndex = -1;
for (const issue of parsed.issues) {
  const currentIndex = severityOrder.indexOf(issue.severity);
  assert(currentIndex >= prevSeverityIndex, "Issues should be sorted by severity");
  prevSeverityIndex = currentIndex;
}
```

---

### AC6: Issue Details Completeness

**Given** 코드 분석에서 이슈가 발견될 때
**When** 결과가 반환되면
**Then** 각 이슈는 필수 필드(id, severity, category, file, message)를 포함해야 한다

**Verification Method:**
```typescript
const result = await callTool("check_types", { dir_path: "." });
const parsed = JSON.parse(result.content[0].text);

for (const issue of parsed.issues) {
  assert(typeof issue.id === "string" && issue.id.length > 0);
  assert(typeof issue.severity === "string");
  assert(typeof issue.category === "string");
  assert(typeof issue.file === "string");
  assert(typeof issue.message === "string");
}
```

---

### AC7: Backward Compatibility

**Given** 기존 워크플로우가 레거시 출력 형식에 의존할 때
**When** `legacy_output: true` 옵션과 함께 도구가 호출되면
**Then** 기존과 동일한 형식의 출력이 반환되어야 한다

**Verification Method:**
```typescript
// Legacy mode
const legacyResult = await callTool("check_types", {
  dir_path: ".",
  legacy_output: true
});

// Should return text format, not JSON
const text = legacyResult.content[0].text;
assert(!text.startsWith("{"), "Legacy output should not be JSON");
```

---

### AC8: Error Handling

**Given** 외부 CLI 도구가 실패할 때
**When** 분석 도구가 호출되면
**Then** 구조화된 에러 응답이 반환되어야 한다

**Verification Method:**
```typescript
const result = await callTool("check_types", {
  dir_path: "/nonexistent/path"
});

const parsed = JSON.parse(result.content[0].text);
assert(parsed.metadata.tool === "check_types");
assert(parsed.summary.total_issues === 0);
assert(parsed.error !== undefined);
assert(typeof parsed.error.message === "string");
```

---

### AC9: Sensitive Data Exclusion

**Given** 분석 대상에 민감한 정보(API keys, passwords)가 포함될 때
**When** `code_review` 도구가 실행되면
**Then** 결과에 민감한 정보가 노출되지 않아야 한다

**Verification Method:**
```typescript
const result = await callTool("code_review", { dir_path: "." });
const text = result.content[0].text;

// Sensitive patterns should not appear in output
const sensitivePatterns = [
  /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
  /password\s*[:=]\s*['"][^'"]+['"]/i,
  /secret\s*[:=]\s*['"][^'"]+['"]/i
];

for (const pattern of sensitivePatterns) {
  assert(!pattern.test(text), "Sensitive data should not appear in output");
}
```

---

### AC10: Performance Requirement

**Given** 캐시가 활성화되어 있을 때
**When** 동일한 분석이 두 번 연속 실행되면
**Then** 두 번째 실행은 첫 번째보다 50% 이상 빨라야 한다

**Verification Method:**
```typescript
// First run (cold cache)
const start1 = Date.now();
await callTool("check_types", { dir_path: "." });
const duration1 = Date.now() - start1;

// Second run (warm cache)
const start2 = Date.now();
await callTool("check_types", { dir_path: "." });
const duration2 = Date.now() - start2;

assert(duration2 < duration1 * 0.5, "Cached result should be 50% faster");
```

---

## Quality Gate Criteria

### Definition of Done

- [ ] 모든 AC 테스트 통과
- [ ] TypeScript 컴파일 오류 없음
- [ ] 린트 경고 없음
- [ ] 기존 테스트 통과 (회귀 없음)
- [ ] 코드 리뷰 완료
- [ ] 문서 업데이트 완료

### TRUST 5 Compliance

| Principle | Requirement | Status |
|-----------|-------------|--------|
| **Tested** | AC1-AC10 테스트 통과 | Pending |
| **Readable** | 명확한 함수명, 주석 | Pending |
| **Unified** | 코딩 컨벤션 준수 | Pending |
| **Secured** | 민감 정보 필터링 (AC9) | Pending |
| **Trackable** | SPEC 참조 커밋 메시지 | Pending |

---

## Tags

`#acceptance-criteria` `#SPEC-ANALYSIS-001` `#code-analysis` `#testing`
