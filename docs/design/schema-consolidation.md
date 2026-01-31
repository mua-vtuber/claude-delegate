# 스키마 통합 설계 (M-5)

## 개요

claude-delegate MCP 서버는 모든 도구에서 **JSON Schema(MCP 전송용)** 와 **Zod 스키마(런타임 검증용)** 를 **이중으로 정의**하고 있어, 유지보수 부담이 크고 스키마 드리프트(drift)가 발생하고 있습니다.

**목표**: `zod-to-json-schema` 라이브러리를 사용하여 Zod을 단일 소스로 통합하고, JSON Schema를 자동 생성하도록 개선합니다.

---

## 현재 문제

### 1. 이중 정의(Dual Definition)

**위치 1: `src/schemas.ts`**
```typescript
toolSchemas.set("diff_strings", z.object({
  text1: z.string(),
  text2: z.string(),
  label1: z.string().optional().default("original"),
  label2: z.string().optional().default("modified"),
  // context_lines 미정의
}));
```

**위치 2: `src/tools/diff.ts`**
```typescript
{
  name: "diff_strings",
  description: "Compare two strings and return unified diff.",
  inputSchema: {
    type: "object",
    properties: {
      text1: { type: "string", description: "First text" },
      text2: { type: "string", description: "Second text" },
      label1: { type: "string", default: "original" },
      label2: { type: "string", default: "modified" },
      // context_lines 정의 안 됨
    },
    required: ["text1", "text2"],
  },
}
```

**실제 핸들러 구현:**
```typescript
const { text1, text2, label1 = "original", label2 = "modified", context_lines = 3 } = args as {...};
// context_lines 파라미터가 사용되지만 스키마에 정의되지 않음!
```

### 2. 스키마 드리프트(Schema Drift)

현재 상태:
- **60개 도구** = **60개 JSON Schema 정의** + **60개 Zod 스키마 정의** = **120개 스키마**
- 수정 시 두 곳을 동시에 업데이트해야 함
- 한쪽만 수정하면 불일치 발생
- 예: `diff_strings`의 `context_lines` 불일치

**드리프트 사례 분석:**
```
도구 수정 시나리오:
1. diff_strings에 context_lines 파라미터 추가 필요
2. schemas.ts 업데이트: context_lines 추가
3. diff.ts 업데이트 잊음 → 런타임 에러 아님, 조용히 무시됨
4. 결과: JSON Schema는 context_lines 없이 전송 → LLM이 파라미터 사용 못함
```

### 3. 유지보수 부담

| 작업 | 현재 비용 | 원인 |
|------|---------|------|
| 파라미터 추가 | 3곳 수정 | schemas.ts + diff.ts + handler 로직 |
| 파라미터 제거 | 3곳 수정 | 동일 |
| 설명 수정 | 2곳 수정 | schemas.ts와 diff.ts의 description |
| 타입 변경 | 2곳 수정 | Zod 타입과 JSON type |
| 테스트 수정 | 최소 2곳 | schemas 테스트 + 도구별 테스트 |

---

## 제안 해결책

### 1단계: Zod을 단일 소스로 통합

**변경 전 구조:**
```
handler 구현 ← 참조하지 않음
  ↓
schemas.ts (Zod)
  ↓
diff.ts (JSON Schema)
  ↓
MCP → LLM
```

**변경 후 구조:**
```
handler 구현
  ↓
스키마 정의 (도구 모듈 내부)
  ↓
Zod 스키마 (단일 소스)
  ↓
자동 변환 (zod-to-json-schema)
  ↓
MCP → LLM
```

### 2단계: 라이브러리 설치

```bash
npm install zod-to-json-schema
npm install --save-dev @types/zod-to-json-schema
```

### 3단계: 파일 구조 변경

**새로운 패턴: 도구별 스키마 모듈**

각 도구 모듈(`tools/*.ts`)에서 스키마를 내부 정의:

```typescript
// src/tools/diff.ts

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ===== Schemas (단일 소스) =====
export const diffFilesSchema = z.object({
  file1: z.string().describe("First file path"),
  file2: z.string().describe("Second file path"),
  context_lines: z.number().int().min(1).default(3).describe("Number of context lines"),
});

export const diffStringsSchema = z.object({
  text1: z.string().describe("First text"),
  text2: z.string().describe("Second text"),
  label1: z.string().default("original").describe("Label for first text"),
  label2: z.string().default("modified").describe("Label for second text"),
  context_lines: z.number().int().min(0).default(3).describe("Context lines for diff"),
});

// ===== Tool Definitions (자동 생성) =====
export const definitions = [
  {
    name: "diff_files",
    description: "Compare two files and return unified diff.",
    inputSchema: zodToJsonSchema(diffFilesSchema),
  },
  {
    name: "diff_strings",
    description: "Compare two strings and return unified diff.",
    inputSchema: zodToJsonSchema(diffStringsSchema),
  },
];

// ===== Handler =====
export async function handler(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "diff_files": {
      const validated = diffFilesSchema.parse(args);
      // validated.file1, validated.file2, validated.context_lines
      ...
    }
    case "diff_strings": {
      const validated = diffStringsSchema.parse(args);
      // validated.text1, validated.text2, validated.context_lines
      ...
    }
  }
}
```

---

## 마이그레이션 전략

### Phase 1: 인프라 구축 (1일)

#### 1a. 라이브러리 설치
```bash
npm install zod-to-json-schema
```

#### 1b. 변환 유틸리티 작성
```typescript
// src/utils/schema-converter.ts

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Zod 스키마를 JSON Schema로 변환하고,
 * 필수 필드 배열을 자동 생성합니다.
 */
export function createToolDefinition(
  name: string,
  description: string,
  schema: z.ZodType,
  metadata?: { version?: string; category?: string }
) {
  const jsonSchema = zodToJsonSchema(schema);

  // required 배열 자동 생성
  const required: string[] = [];
  if (jsonSchema.properties) {
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      if (prop.type && !("default" in prop)) {
        required.push(key);
      }
    }
  }

  return {
    name,
    description,
    inputSchema: {
      ...jsonSchema,
      required,
    },
    metadata,
  };
}
```

#### 1c. 기존 schemas.ts 보관
```bash
mv src/schemas.ts src/schemas.ts.backup
```

### Phase 2: 도구별 스키마 이관 (3-5일)

**우선순위 순서:**
1. 간단한 도구부터 (filesystem, web, memory)
2. 중간 복잡도 (productivity, github, shell)
3. 복잡한 도구 (llm, analysis)

**도구별 이관 체크리스트:**
- [ ] 도구 모듈에서 Zod 스키마 정의
- [ ] `zodToJsonSchema` 변환 적용
- [ ] 핸들러 코드에서 스키마 검증 사용
- [ ] 기존 JSON Schema 제거
- [ ] 테스트 업데이트

**예시: 파일시스템 도구 이관**

Before:
```typescript
// src/schemas.ts
toolSchemas.set("fs_write_file", z.object({
  file_path: z.string(),
  content: z.string(),
}));

// src/tools/filesystem.ts
export const definitions = [
  {
    name: "fs_write_file",
    description: "Create or overwrite a file with specific content.",
    inputSchema: { /* 수동 JSON Schema */ }
  }
];
```

After:
```typescript
// src/tools/filesystem.ts
export const fsWriteFileSchema = z.object({
  file_path: z.string().describe("Path to write"),
  content: z.string().describe("Content to write"),
});

export const definitions = [
  createToolDefinition("fs_write_file", "Create or overwrite a file.", fsWriteFileSchema)
];
```

### Phase 3: 중앙 검증 시스템 업데이트 (1일)

#### 3a. 새로운 검증 시스템
```typescript
// src/validation.ts (schemas.ts 대체)

import * as filesystemTools from "./tools/filesystem.js";
import * as webTools from "./tools/web.js";
// ... 모든 도구 import

const schemaMap = new Map<string, z.ZodType>();

// 도구 모듈에서 내부 스키마 내보내기 활용
const modules = [filesystemTools, webTools, ...];
for (const mod of modules) {
  if (mod.allSchemas) {
    for (const [name, schema] of Object.entries(mod.allSchemas)) {
      schemaMap.set(name, schema);
    }
  }
}

export { schemaMap };
```

#### 3b. 기존 middleware.ts 통합
```typescript
// src/middleware.ts (변경 최소)

import { schemaMap } from "./validation.js";

export function validateArgs(name: string, args: Record<string, unknown> | undefined): ValidationResult {
  const schema = schemaMap.get(name);
  // ... 기존 로직 동일
}
```

### Phase 4: 기존 schemas.ts 삭제 (1일)

- [ ] 모든 도구 마이그레이션 완료 확인
- [ ] `src/schemas.ts` 삭제
- [ ] `src/schemas.ts.backup` 삭제
- [ ] 테스트 실행 및 통과
- [ ] PR 리뷰 및 머지

---

## 예상 효과

### 1. 유지보수 부담 감소

| 작업 | 변경 전 | 변경 후 | 감소율 |
|------|---------|---------|---------|
| 파라미터 추가 | 3곳 수정 | 1곳 수정 | 67% |
| 파라미터 제거 | 3곳 수정 | 1곳 수정 | 67% |
| 설명 수정 | 2곳 수정 | 1곳 수정 | 50% |
| 타입 변경 | 2곳 수정 | 1곳 수정 | 50% |
| **평균 감소** | **2.5곳** | **1곳** | **50%** |

### 2. 스키마 드리프트 제거

- JSON Schema와 Zod이 동일 소스에서 파생 → 자동 동기화
- 컴파일 타임에 타입 안전성 보장
- 스키마 불일치 불가능

### 3. 코드 가독성 개선

```typescript
// 변경 전: 정의를 떨어진 곳에서 찾아야 함
export const definitions = [
  { name: "diff_files", inputSchema: { /* 복잡한 JSON */ } }
];
// schemas.ts 파일도 확인해야 함

// 변경 후: 한 곳에서 모든 정보 확인
export const diffFilesSchema = z.object({
  file1: z.string().describe("..."),
  file2: z.string().describe("..."),
  context_lines: z.number().default(3).describe("..."),
});

export const definitions = [
  createToolDefinition("diff_files", "...", diffFilesSchema)
];
```

### 4. 타입 추론 개선

```typescript
// 변경 전
const { file1, file2, context_lines = 3 } = args as {
  file1: string;
  file2: string;
  context_lines?: number;
};

// 변경 후
const validated = diffFilesSchema.parse(args);
// validated.file1: string (자동 추론)
// validated.file2: string
// validated.context_lines: number (기본값 이미 적용됨)
```

---

## 파일 구조 변경 예시

### 마이그레이션 전후 비교

```
변경 전:
src/
  ├── schemas.ts (120곳에서 참조)
  └── tools/
      ├── diff.ts (inputSchema 수동 정의)
      └── filesystem.ts (inputSchema 수동 정의)

변경 후:
src/
  ├── utils/
  │   └── schema-converter.ts (createToolDefinition)
  ├── validation.ts (schemaMap 생성)
  └── tools/
      ├── diff.ts (스키마 내부 정의, 자동 JSON Schema)
      └── filesystem.ts (스키마 내부 정의, 자동 JSON Schema)
```

---

## 위험 요소 및 완화 방법

### 1. zod-to-json-schema 호환성

**위험**: 생성된 JSON Schema가 MCP 표준을 완전히 준수하지 않을 수 있음

**완화**:
- Phase 2 마이그레이션 중 각 도구별로 생성된 스키마 검증
- 예기치 않은 필드 발견 시 `createToolDefinition` 유틸 수정
- 회귀 테스트: 이전 JSON Schema와 생성된 스키마 비교

### 2. 기존 도구 호환성 깨짐

**위험**: 이미 배포된 MCP 클라이언트가 스키마 변경에 반응할 수 있음

**완화**:
- JSON Schema 구조 변경 없음 (생성만 자동화)
- 파라미터 이름/기본값 유지
- 마이그레이션 후에도 동일한 JSON Schema 검증

### 3. 마이그레이션 중 도구 불안정

**위험**: 부분 마이그레이션 상태에서 시스템 불안정

**완화**:
- Phase별 격리: 각 Phase에서 하나의 모듈만 변경
- 브랜치별 개발: `feature/schema-consolidation` 브랜치
- CI/CD에서 모든 도구 테스트 실행
- 완료 후 일괄 머지

---

## 구현 일정

| Phase | 작업 | 예상 소요시간 | 담당자 |
|-------|------|-------------|--------|
| 1 | 라이브러리 설치 및 유틸 작성 | 1일 | AI |
| 2 | 도구별 이관 (일괄 병렬) | 3-5일 | AI (자동화) |
| 3 | 검증 시스템 통합 | 1일 | AI |
| 4 | 테스트 및 정리 | 1일 | AI |
| | **총 소요시간** | **6-8일** | |

---

## 롤백 계획

이관 중 문제 발생 시:

1. **파일 백업**: `schemas.ts.backup` 보관
2. **즉시 롤백**: `mv src/schemas.ts.backup src/schemas.ts`
3. **영향도 분석**: 어느 Phase에서 문제 발생했는지 파악
4. **근본 원인 분석**: zod-to-json-schema 설정 검토
5. **재시작**: 다른 접근 방식 검토 (예: 부분 통합)

---

## 성공 기준

- [ ] 모든 도구에서 Zod 스키마 정의
- [ ] `zodToJsonSchema`로 자동 생성된 JSON Schema 사용
- [ ] 기존 schemas.ts 완전 제거
- [ ] 모든 도구 테스트 통과
- [ ] 스키마 불일치 오류 0건
- [ ] 코드 리뷰 승인

---

## 향후 개선

1. **타입 안전성 강화**: 핸들러에서 파싱된 데이터 타입 활용
2. **런타임 검증**: 타입 캐스팅 제거, 전체 `safeParse` 사용
3. **문서 자동화**: 스키마에서 API 문서 자동 생성
4. **버전 관리**: 스키마 변경 이력 추적
