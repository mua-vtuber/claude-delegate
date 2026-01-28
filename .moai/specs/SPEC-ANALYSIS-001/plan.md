# SPEC-ANALYSIS-001: Implementation Plan

## Metadata

| Field | Value |
|-------|-------|
| SPEC ID | SPEC-ANALYSIS-001 |
| Title | Enhanced Code Analysis Reports - Implementation Plan |
| Created | 2026-01-28 |

---

## Milestones

### Primary Goal: Core Schema Implementation

**Deliverables:**
- AnalysisResult TypeScript interface 정의
- Issue TypeScript interface 정의
- Severity enum 정의
- 결과 포맷터 함수 구현 (`formatAsJson`, `formatAsMarkdown`, `formatAsSummary`)

**Dependencies:**
- 없음 (기반 구현)

**Validation:**
- TypeScript 컴파일 성공
- 인터페이스 내보내기 확인

### Secondary Goal: Tool Integration

**Deliverables:**
- `check_types` 결과 파싱 및 구조화
- `run_linter` 결과 파싱 및 구조화
- `analyze_dependencies` 출력 형식 표준화
- `find_unused_exports` 신뢰도 점수 추가

**Dependencies:**
- Primary Goal 완료

**Validation:**
- 각 도구의 구조화된 출력 확인
- 심각도 분류 정확성 검증

### Tertiary Goal: Caching & Trend Analysis

**Deliverables:**
- 분석 결과 캐싱 레이어 구현
- 트렌드 비교 로직 구현
- 캐시 만료 및 정리 로직

**Dependencies:**
- Secondary Goal 완료

**Validation:**
- 캐시 적중률 테스트
- 트렌드 계산 정확성 검증

### Optional Goal: code_review Enhancement

**Deliverables:**
- LLM 응답 파싱 및 구조화
- 심각도 자동 분류
- 실행 가능한 권장사항 추출

**Dependencies:**
- Secondary Goal 완료

**Validation:**
- 파싱 정확도 검증
- 마크다운 출력 품질 확인

---

## Technical Approach

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Tool Handler                         │
├─────────────────────────────────────────────────────────────┤
│ check_types │ run_linter │ analyze_deps │ find_unused │ ... │
├─────────────────────────────────────────────────────────────┤
│                   Result Parser Layer                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │tscParser │ │eslintPars│ │depParser │ │exportPars│       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│                   AnalysisResult Builder                    │
├─────────────────────────────────────────────────────────────┤
│                   Output Formatter                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │  JSON    │ │ Markdown │ │ Summary  │                    │
│  └──────────┘ └──────────┘ └──────────┘                    │
├─────────────────────────────────────────────────────────────┤
│                   Caching Layer                             │
│  ┌──────────────────────────────────────┐                  │
│  │ analysisCache: Map<string, Result>   │                  │
│  └──────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Strategy

**Phase 1: Interface Definition**
1. `src/index.ts` 상단에 인터페이스 추가
2. Severity enum 정의
3. 유틸리티 타입 정의

**Phase 2: Parser Implementation**
1. TypeScript 에러 출력 파싱 (`/error TS\d+:/` 패턴)
2. ESLint JSON 출력 파싱 (`--format json` 옵션)
3. npm/pip 의존성 출력 구조화

**Phase 3: Formatter Implementation**
1. `formatAnalysisResult()` - JSON 변환
2. `formatAsMarkdown()` - 가독성 높은 마크다운
3. `formatAsSummary()` - 간략 통계

**Phase 4: Caching Integration**
1. 기존 `responseCache` Map 확장
2. 분석 결과 전용 캐시 키 생성
3. 트렌드 비교 함수 구현

### Code Changes

**New Interfaces (estimated 50-70 lines):**
```typescript
// Add after line 76 (after existing interfaces)
interface AnalysisResult { ... }
interface Issue { ... }
type Severity = "critical" | "high" | "medium" | "low" | "info";
```

**New Parser Functions (estimated 100-150 lines):**
```typescript
function parseTscOutput(raw: string): Issue[] { ... }
function parseEslintOutput(raw: string): Issue[] { ... }
function buildAnalysisResult(tool: string, issues: Issue[], raw: string): AnalysisResult { ... }
```

**Tool Handler Modifications:**
- `check_types`: 결과 파싱 추가 (~30 lines)
- `run_linter`: ESLint JSON 모드 활성화 (~30 lines)
- `analyze_dependencies`: 구조 표준화 (~20 lines)
- `find_unused_exports`: 신뢰도 점수 추가 (~20 lines)

---

## Risks and Mitigations

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| CLI 출력 형식 변경 | Low | High | 버전 감지 및 fallback 파서 구현 |
| 파싱 오류 | Medium | Medium | 원본 출력 보존, 에러 핸들링 강화 |
| 성능 저하 | Low | Medium | 파싱 최적화, 캐싱 활용 |

### Compatibility Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| 기존 워크플로우 파괴 | Low | High | 하위 호환 출력 옵션 제공 |
| 외부 도구 의존성 | Medium | Low | graceful degradation 구현 |

---

## Success Criteria

- [ ] 모든 5개 도구가 AnalysisResult 형식 출력
- [ ] 심각도 분류 정확도 90% 이상
- [ ] 캐시 적중 시 응답 시간 50% 감소
- [ ] 트렌드 비교 기능 동작 확인
- [ ] 하위 호환성 100% 유지
- [ ] TypeScript 컴파일 오류 없음

---

## Tags

`#implementation-plan` `#SPEC-ANALYSIS-001` `#code-analysis`
