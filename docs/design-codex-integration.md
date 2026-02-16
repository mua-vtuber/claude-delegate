# OpenAI Codex CLI 통합 설계문서

**버전:** 1.0
**날짜:** 2026-02-16
**상태:** Draft

---

## 1. 개요

OpenAI Codex CLI(`@openai/codex`)를 claude-delegate MCP 서버의 세 번째 LLM 프로바이더로 통합한다.
기존 Gemini CLI, Ollama와 동일한 아키텍처 패턴을 따르며, 하드코딩 없이 환경변수로 설정한다.

### 1.1 목표

- Codex CLI를 서브프로세스로 호출하여 **병렬 의견 수집** (Gemini + Codex 동시 리뷰) 지원
- 기존 MCP 도구 구조(`definitions`, `allSchemas`, `handler`) 100% 준수
- 모든 프로바이더에 대해 **설치 여부 런타임 감지** 통일 (Gemini 기존 버그 수정 포함)
- 하드코딩 없는 환경변수 기반 설정

### 1.2 기존 프로바이더 현황

| 항목 | Ollama | Gemini CLI | Codex CLI (신규) |
|---|---|---|---|
| 호출 방식 | HTTP API (`fetch`) | `spawn("gemini")` | `spawn("codex")` |
| 출력 형식 | JSON API | `-o json` → regex 파싱 | `--json` (JSONL) / `--output-schema` |
| 파일 참조 | 프롬프트에 내용 삽입 | `@filepath` 네이티브 | `--cd <dir>` + 에이전트 자체 읽기 |
| 폴백 | 없음 (기본 로컬) | Ollama로 폴백 | Ollama로 폴백 |
| 설치 감지 | HTTP 연결 테스트 | Windows만 경로 탐색 | `which`/`where` 기반 (신규) |
| 인증 | 불필요 (로컬) | `gemini auth login` | `CODEX_API_KEY` 환경변수 |

---

## 2. 아키텍처

### 2.1 파일 구조 변경

```
src/
├── config.ts                  # [수정] CODEX_* 환경변수 추가
├── types.ts                   # [수정] Codex 관련 타입 추가
├── helpers/
│   ├── gemini.ts              # [수정] isGeminiCliAvailable() 비-Windows 실제 검증 추가
│   ├── codex.ts               # [신규] Codex CLI 헬퍼 (gemini.ts 패턴 미러)
│   └── routing.ts             # [수정] 3-way 프로바이더 라우팅
├── tools/
│   ├── llm.ts                 # [수정] codex_ask, compare_three_models 추가
│   ├── productivity.ts        # [수정] cross_review에 Codex 프로바이더 옵션 추가
│   └── health.ts              # [수정] Codex 헬스체크 추가
├── validation.ts              # 변경 불필요 (자동 수집)
├── server.ts                  # 변경 불필요 (자동 수집)
└── index.ts                   # [수정] 스타트업 시 Codex 설치 체크 로그
```

### 2.2 의존성 흐름

```
config.ts (환경변수)
    ↓
helpers/codex.ts (CLI 호출 래퍼)
    ↓
tools/llm.ts ←→ helpers/routing.ts (3-way 라우팅)
    ↓
tools/productivity.ts (cross_review, compare)
tools/health.ts (헬스체크)
```

---

## 3. 설정 (config.ts)

### 3.1 신규 환경변수

```typescript
// ===== Codex CLI Configuration =====
export const CODEX_TIMEOUT = parseInt(process.env.CODEX_TIMEOUT || "120000", 10);
export const CODEX_MODEL = process.env.CODEX_MODEL || "";  // 빈 문자열 = Codex 기본값 사용
export const CODEX_FALLBACK_TO_OLLAMA = process.env.CODEX_FALLBACK !== "false"; // default: true
```

### 3.2 설계 원칙

- `CODEX_MODEL`: 빈 문자열이면 Codex CLI의 기본 모델을 사용. 사용자가 `gpt-5.2-codex` 등 지정 가능
- `CODEX_API_KEY`는 config.ts에서 관리하지 않음 — Codex CLI가 자체적으로 `process.env.CODEX_API_KEY`를 읽으므로, 환경변수만 통과시키면 됨
- `CODEX_TIMEOUT`: Gemini와 동일한 기본값 120초

---

## 4. 헬퍼 모듈 (helpers/codex.ts)

### 4.1 구조 (gemini.ts 미러)

```typescript
// src/helpers/codex.ts
// ============================================
// Codex CLI Helpers
// ============================================

import { spawn } from "child_process";
import { CODEX_TIMEOUT, CODEX_FALLBACK_TO_OLLAMA, CODEX_MODEL, OLLAMA_MODEL_POWERFUL } from "../config.js";
import { ollamaChat } from "./ollama.js";

// --- 설치 감지 ---

export async function findCodexCliPath(): Promise<string | null>;
export async function isCodexCliAvailable(): Promise<{
  available: boolean;
  path?: string;
  version?: string;
  message?: string;
}>;

// --- 출력 파싱 ---

export function parseCodexJsonlOutput(jsonlText: string): string;

// --- CLI 실행 ---

export async function runCodexCLI(prompt: string, options?: CodexRunOptions): Promise<string>;
export async function runCodexWithFallback(prompt: string, timeout?: number): Promise<{
  response: string;
  source: "codex" | "ollama";
}>;
```

### 4.2 설치 감지 — 기존 Gemini 버그 수정 포함

**문제점:** 현재 `isGeminiCliAvailable()`이 비-Windows 환경에서 실제 실행 확인 없이 `{ available: true }`를 반환함.

**해결:** 모든 CLI 프로바이더에 대해 통일된 감지 패턴을 적용:

```typescript
// helpers/codex.ts
import { execFilePromise } from "../config.js";

export async function findCodexCliPath(): Promise<string | null> {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Method 1: where.exe
    try {
      const { stdout } = await execFilePromise(
        "C:\\Windows\\System32\\where.exe", ["codex"], { timeout: 5000 }
      );
      const firstPath = stdout.trim().split(/\r?\n/)[0].trim();
      if (firstPath) return firstPath;
    } catch { /* not found */ }

    // Method 2: npm global root
    try {
      const { stdout } = await execFilePromise("npm", ["root", "-g"], { timeout: 5000, shell: true });
      const npmRoot = stdout.trim();
      if (npmRoot) {
        const { existsSync } = await import("fs");
        const { join } = await import("path");
        // @openai/codex의 실제 bin 경로 탐색
        const binPath = join(npmRoot, "@openai", "codex", "bin", "codex.js");
        if (existsSync(binPath)) return binPath;
      }
    } catch { /* npm not available */ }

    return null;
  }

  // 비-Windows: which로 실제 존재 확인
  try {
    const { stdout } = await execFilePromise("which", ["codex"], { timeout: 5000 });
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

export async function isCodexCliAvailable(): Promise<{
  available: boolean;
  path?: string;
  version?: string;
  message?: string;
}> {
  const codexPath = await findCodexCliPath();
  if (!codexPath) {
    return {
      available: false,
      message: "Codex CLI not found. Install with: npm install -g @openai/codex",
    };
  }

  // 버전 확인으로 실제 작동 검증
  try {
    const { stdout } = await execFilePromise("codex", ["--version"], { timeout: 5000 });
    return { available: true, path: codexPath, version: stdout.trim() };
  } catch {
    return { available: true, path: codexPath }; // 경로는 있지만 버전 확인 실패
  }
}
```

**Gemini도 동일하게 수정** (`helpers/gemini.ts`):

```typescript
// isGeminiCliAvailable()의 비-Windows 분기를 실제 검증으로 교체:
if (!isWindows) {
  try {
    await execFilePromise("which", ["gemini"], { timeout: 5000 });
    return { available: true, path: "gemini (via PATH)" };
  } catch {
    return {
      available: false,
      message: "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
    };
  }
}
```

### 4.3 출력 파싱

Codex CLI의 출력 구조:
- **기본 모드**: stdout = 최종 메시지만, stderr = 진행 로그 → 필터링 불필요
- **`--json` 모드**: JSONL 스트림 → `item.completed` 이벤트에서 최종 텍스트 추출

```typescript
/**
 * JSONL 스트림에서 최종 에이전트 메시지를 추출한다.
 * Codex는 각 줄이 독립 JSON 객체인 JSONL 형식을 사용한다.
 */
export function parseCodexJsonlOutput(jsonlText: string): string {
  const lines = jsonlText.trim().split("\n");
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // item.completed 이벤트 중 agent_message 타입에서 텍스트 추출
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        messages.push(event.item.text);
      }
    } catch {
      // 파싱 실패한 줄은 무시 (진행 로그 등)
    }
  }

  return messages.join("\n\n") || jsonlText; // 파싱 실패 시 원본 반환
}
```

### 4.4 CLI 실행

```typescript
interface CodexRunOptions {
  timeout?: number;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  useJson?: boolean;
}

export async function runCodexCLI(
  prompt: string,
  options: CodexRunOptions = {}
): Promise<string> {
  const {
    timeout = CODEX_TIMEOUT,
    cwd,
    outputSchema,
    useJson = false,
  } = options;

  // 기본 인자: --full-auto (승인 불필요) + --ephemeral (세션 저장 안함)
  const args: string[] = ["exec", "--full-auto", "--ephemeral"];

  // 모델 지정 (환경변수에서, 빈 문자열이면 생략)
  if (CODEX_MODEL) {
    args.push("--model", CODEX_MODEL);
  }

  // JSON 출력 모드
  if (useJson) {
    args.push("--json");
  }

  // 구조화된 출력 스키마
  if (outputSchema) {
    args.push("--output-schema", JSON.stringify(outputSchema));
  }

  // 작업 디렉토리
  if (cwd) {
    args.push("--cd", cwd);
  }

  // Git 체크 스킵 (MCP 서버에서 호출 시 필요할 수 있음)
  args.push("--skip-git-repo-check");

  // 프롬프트
  args.push(prompt);

  // 프로세스 스폰
  const isWindows = process.platform === "win32";
  let command: string;
  let spawnArgs: string[];

  if (isWindows) {
    const codexPath = await findCodexCliPath();
    if (!codexPath) {
      throw new Error("Codex CLI not found. Install with: npm install -g @openai/codex");
    }
    command = "node";
    spawnArgs = [codexPath, ...args];
  } else {
    command = "codex";
    spawnArgs = args;
  }

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(isWindows && { windowsHide: true }),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Codex CLI timeout"));
    }, timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);

      if (useJson) {
        // JSONL 모드: item.completed에서 최종 메시지 추출
        const parsed = parseCodexJsonlOutput(stdout);
        if (parsed) { resolvePromise(parsed); return; }
      }

      // 기본 모드: stdout이 곧 최종 메시지
      const output = stdout.trim();
      if (output) resolvePromise(output);
      else if (code === 0) resolvePromise("(empty response)");
      else reject(new Error(`Codex CLI error (code ${code}): ${stderr || "unknown error"}`));
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Codex CLI spawn error: ${err.message}`));
    });
  });
}
```

### 4.5 폴백

```typescript
export async function runCodexWithFallback(
  prompt: string,
  timeout?: number
): Promise<{ response: string; source: "codex" | "ollama" }> {
  try {
    const response = await runCodexCLI(prompt, { timeout });
    return { response, source: "codex" };
  } catch (err: unknown) {
    if (!CODEX_FALLBACK_TO_OLLAMA) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Codex failed (${message}), falling back to Ollama...`);
    const { text } = await ollamaChat(OLLAMA_MODEL_POWERFUL, prompt);
    return { response: text, source: "ollama" };
  }
}
```

---

## 5. 라우팅 확장 (helpers/routing.ts)

### 5.1 프로바이더 타입 확장

```typescript
// types.ts에 추가
export type LLMProvider = "ollama" | "gemini" | "codex" | "auto";
```

### 5.2 smart_ask 3-way 라우팅

기존 `smart_ask`의 `force_model` 옵션에 `"codex"` 추가:

```typescript
// tools/llm.ts — smartAskSchema 수정
export const smartAskSchema = z.object({
  prompt: z.string(),
  force_model: z.enum(["ollama", "gemini", "codex", MODEL_AUTO]).optional().default(MODEL_AUTO),
});
```

라우팅 로직:
- `force_model="codex"` → Codex 직접 호출 (폴백: Ollama)
- `force_model="gemini"` → Gemini 직접 호출 (폴백: Ollama)
- `force_model="auto"` + `complexity="high"` → Gemini 우선 (기존 동작 유지)
- `force_model="auto"` + 기타 → Ollama (기존 동작 유지)

### 5.3 utility.ts routeToLLM 확장

```typescript
async function routeToLLM(
  model: string | undefined,
  text: string,
  prompt: string,
  geminiThreshold: number = 2000
): Promise<string> {
  if (model === "codex") {
    return (await runCodexCLI(prompt)).trim();
  }
  const useGemini = model === "gemini" || (model === MODEL_AUTO && text.length > geminiThreshold);
  if (useGemini) {
    return (await runGeminiCLI([prompt])).trim();
  }
  return (await ollamaChat(OLLAMA_MODELS.fast, prompt)).text.trim();
}
```

---

## 6. 신규 MCP 도구

### 6.1 `codex_ask` (tools/llm.ts에 추가)

Gemini의 `gemini_ask`와 대칭되는 도구.

```typescript
export const codexAskSchema = z.object({
  prompt: z.string(),
});

// definitions 배열에 추가:
createToolDefinition(
  "codex_ask",
  "Ask OpenAI Codex CLI. Uses codex exec for non-interactive queries.",
  codexAskSchema
)
```

핸들러:
```typescript
case "codex_ask": {
  const { prompt } = codexAskSchema.parse(args);
  const { response, source } = await runCodexWithFallback(prompt);
  const prefix = source === "ollama" ? "[Fallback: Ollama]\n\n" : "";
  return { content: [{ type: "text", text: prefix + response }] };
}
```

### 6.2 `codex_analyze_codebase` (tools/llm.ts에 추가)

Gemini의 `gemini_analyze_codebase`와 대칭. Codex는 `@filepath`를 지원하지 않으므로, `--cd` + 프롬프트에 경로 나열 방식 사용.

```typescript
export const codexAnalyzeCodebaseSchema = z.object({
  paths: z.array(z.string()),
  question: z.string().optional(),
});

// 핸들러:
case "codex_analyze_codebase": {
  const { paths, question = "Analyze this codebase" } = codexAnalyzeCodebaseSchema.parse(args);
  const fileList = paths.map(p => resolve(p)).join(", ");
  const prompt = `Analyze the following files: ${fileList}\n\n${question}`;
  const { response, source } = await runCodexWithFallback(prompt, 300000);

  const sourceNote = source === "ollama" ? " (Ollama fallback)" : "";
  const reviewPath = await saveReviewToFile(
    `# Codex Analysis${sourceNote}\n\n**Question:** ${question}\n**Files:** ${paths.join(", ")}\n\n---\n\n${response}`,
    "codex_analysis"
  );
  return {
    content: [{
      type: "text",
      text: `Analysis saved to: ${reviewPath}${source === "ollama" ? " (used Ollama fallback)" : ""}\n\nUse Read tool to view the full analysis.`,
    }],
  };
}
```

### 6.3 `compare_models` 확장 → 3-way 비교

기존 `compare_models`를 Ollama + Gemini + Codex 3-way로 확장:

```typescript
export const compareModelsSchema = z.object({
  prompt: z.string().describe("Prompt to send to all models"),
  providers: z.array(z.enum(["ollama", "gemini", "codex"]))
    .optional()
    .default(["ollama", "gemini"])
    .describe("Which providers to compare (default: ollama + gemini)"),
});
```

핸들러:
```typescript
case "compare_models": {
  const { prompt, providers } = compareModelsSchema.parse(args);

  const tasks: Record<string, Promise<string>> = {};

  if (providers.includes("ollama")) {
    tasks.ollama = ollamaChat(selectOllamaModel(prompt).model, prompt)
      .then(r => r.text)
      .catch(e => `Ollama Error: ${(e as Error).message}`);
  }
  if (providers.includes("gemini")) {
    tasks.gemini = runGeminiCLI([prompt])
      .catch(e => `Gemini Error: ${(e as Error).message}`);
  }
  if (providers.includes("codex")) {
    tasks.codex = runCodexCLI(prompt)
      .catch(e => `Codex Error: ${(e as Error).message}`);
  }

  const results = await Promise.all(
    Object.entries(tasks).map(async ([name, promise]) => ({
      name,
      response: await promise,
    }))
  );

  const comparison = results
    .map(r => `## ${r.name.charAt(0).toUpperCase() + r.name.slice(1)} Response:\n${r.response}`)
    .join("\n\n---\n\n");

  return { content: [{ type: "text", text: comparison }] };
}
```

**하위 호환성:** `providers` 파라미터의 기본값이 `["ollama", "gemini"]`이므로, 기존 호출은 동작이 변하지 않음.

---

## 7. 병렬 의견 수집 (cross_review 확장)

### 7.1 cross_review에 reviewer 옵션 추가

```typescript
export const crossReviewSchema = z.object({
  file_paths: z.array(z.string()).optional(),
  dir_path: z.string().optional(),
  rules: z.array(z.string()).min(1),
  focus: z.string().optional().default("general"),
  reviewers: z.array(z.enum(["gemini", "codex"]))
    .optional()
    .default(["gemini"])
    .describe("Which external AIs to use for review (default: gemini only)"),
});
```

### 7.2 병렬 리뷰 실행

```typescript
// cross_review 핸들러 내부
const reviewTasks: Record<string, Promise<{ response: string; source: string }>> = {};

if (reviewers.includes("gemini")) {
  const geminiPrompt = buildCrossReviewPrompt(fileRefs, rules, focus, sourceFiles.length);
  reviewTasks.gemini = runGeminiWithFallback(geminiPrompt, CODE_REVIEW_TIMEOUT);
}

if (reviewers.includes("codex")) {
  // Codex는 @filepath를 지원하지 않으므로 파일 내용을 프롬프트에 포함하거나
  // --cd로 디렉토리를 지정하고 파일 경로만 나열
  const codexPrompt = buildCrossReviewPrompt(
    sourceFiles.map(f => f).join(", "),  // 경로만 나열 (@ 없이)
    rules,
    focus,
    sourceFiles.length
  );
  reviewTasks.codex = runCodexWithFallback(codexPrompt, CODE_REVIEW_TIMEOUT)
    .then(r => ({ response: r.response, source: r.source }));
}

const results = await Promise.allSettled(
  Object.entries(reviewTasks).map(async ([name, task]) => ({
    reviewer: name,
    ...(await task),
  }))
);
```

### 7.3 결과 병합

```typescript
// 각 리뷰어의 결과를 섹션별로 분리하여 반환
const sections = results
  .filter((r): r is PromiseFulfilledResult<...> => r.status === "fulfilled")
  .map(r => {
    const { reviewer, response, source } = r.value;
    return `## ${reviewer.toUpperCase()} Review (source: ${source})\n\n${response}`;
  });

const combined = sections.join("\n\n---\n\n");
```

**하위 호환성:** `reviewers` 기본값이 `["gemini"]`이므로 기존 동작 유지.

---

## 8. 헬스체크 확장 (tools/health.ts)

### 8.1 체크 대상 추가

```typescript
export const healthCheckSchema = z.object({
  check: z.enum(["all", "ollama", "gemini", "codex"])
    .optional()
    .default("all"),
});

interface HealthCheckResult {
  server_version: string;
  ollama?: { /* 기존 */ };
  gemini?: { /* 기존 */ };
  codex?: {
    status: "ok" | "error";
    path?: string;
    version?: string;
    error?: string;
    api_key_set?: boolean;
  };
}
```

### 8.2 Codex 체크 구현

```typescript
async function checkCodex(): Promise<HealthCheckResult["codex"]> {
  try {
    const result = await isCodexCliAvailable();
    if (!result.available) {
      return { status: "error", error: result.message };
    }
    return {
      status: "ok",
      path: result.path,
      version: result.version,
      api_key_set: !!process.env.CODEX_API_KEY,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "error", error: msg };
  }
}
```

---

## 9. 스타트업 체크 (index.ts)

기존 Ollama 연결 체크 패턴을 따라 Codex 설치 상태도 출력:

```typescript
// Codex CLI 설치 확인
try {
  const codexCheck = await isCodexCliAvailable();
  if (codexCheck.available) {
    console.error(`[delegate] Codex CLI available: ${codexCheck.path}`);
  } else {
    console.error("[INFO] Codex CLI not installed. codex_ask/codex_analyze tools will be unavailable.");
    console.error("[INFO] Install with: npm install -g @openai/codex");
  }
} catch {
  console.error("[INFO] Codex CLI check failed. Codex tools may not work.");
}
```

---

## 10. 프로바이더 설치 감지 통일

### 10.1 현재 문제점

| 프로바이더 | 현재 감지 방식 | 문제 |
|---|---|---|
| Ollama | HTTP 연결 테스트 (`/api/tags`) | 정확함 |
| Gemini | Windows만 경로 탐색, 비-Windows는 `{ available: true }` 고정 | **비-Windows에서 미설치시에도 true 반환** |
| Codex | 없음 (신규) | — |

### 10.2 수정 방안

**`helpers/gemini.ts` — `isGeminiCliAvailable()`:**

```typescript
export async function isGeminiCliAvailable(): Promise<{
  available: boolean;
  path?: string;
  message?: string;
}> {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    const geminiPath = await findGeminiCliPath();
    if (geminiPath) return { available: true, path: geminiPath };
    return {
      available: false,
      message: "Gemini CLI not found on Windows. Install with: npm install -g @google/gemini-cli",
    };
  }

  // 비-Windows: which로 실제 존재 확인 (기존 버그 수정)
  try {
    const { stdout } = await execFilePromise("which", ["gemini"], { timeout: 5000 });
    const path = stdout.trim();
    if (path) return { available: true, path };
    return {
      available: false,
      message: "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
    };
  } catch {
    return {
      available: false,
      message: "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
    };
  }
}
```

---

## 11. 파일 참조 전략

Codex CLI는 Gemini의 `@filepath` 패턴을 지원하지 않는다. 대신:

### 11.1 접근 방식

| 시나리오 | Gemini | Codex |
|---|---|---|
| 코드 분석 | `@filepath` 프롬프트에 포함 | `--cd <project_root>` + 프롬프트에 "Read file X" 지시 |
| 코드 리뷰 | `@file1 @file2 ... review prompt` | 파일 내용을 프롬프트에 직접 삽입 (올라마 방식) |
| 멀티파일 분석 | `@file1 @file2 ... question` | 파일 내용 직접 삽입 + `encapsulateFileContent()` 재사용 |

### 11.2 구현 — buildCodexPromptWithFiles()

```typescript
/**
 * Codex용 파일 참조 프롬프트를 구성한다.
 * Gemini의 @filepath 대신 파일 내용을 직접 삽입하는 방식.
 * 기존 Ollama의 encapsulateFileContent()를 재사용한다.
 */
export function buildCodexPromptWithFiles(
  files: { path: string; content: string }[],
  question: string
): string {
  const encapsulated = files
    .map(f => encapsulateFileContent(f.content, f.path))
    .join("\n\n");

  return `${question}\n\n${encapsulated}`;
}
```

---

## 12. 에러 처리 및 보안

### 12.1 에러 처리 전략

```
codex exec 실패
  ├─ CODEX_FALLBACK_TO_OLLAMA=true  → Ollama로 폴백
  ├─ CODEX_FALLBACK_TO_OLLAMA=false → 에러 반환
  └─ 타임아웃 → "Codex CLI timeout" 에러
```

### 12.2 보안 고려사항

1. **API 키 노출 방지**: `CODEX_API_KEY`는 `SENSITIVE_ENV_DENYLIST`에 이미 `KEY` 패턴으로 매칭됨
2. **프롬프트 인젝션 방어**: Ollama와 동일하게 `encapsulateFileContent()` + `DEFENSE_SYSTEM_PROMPT` 적용
3. **`--full-auto` 사용**: Codex의 샌드박스 내에서만 실행됨 (workspace-write 정책)
4. **`--ephemeral`**: 세션 로그를 디스크에 남기지 않음

---

## 13. 테스트 계획

### 13.1 단위 테스트

```
src/__tests__/codex.test.ts (신규)
├── parseCodexJsonlOutput — JSONL 파싱 정확성
├── findCodexCliPath — 경로 탐색 로직
├── runCodexCLI — spawn 호출 + 타임아웃 + 에러 처리 (mock)
└── runCodexWithFallback — 폴백 로직 (mock)
```

### 13.2 통합 테스트

```
src/__tests__/codex-integration.test.ts (신규, 선택적)
├── 실제 Codex CLI 호출 (설치되어 있을 때만)
├── health_check check="codex" 동작 검증
└── compare_models providers=["codex","gemini"] 동작 검증
```

### 13.3 기존 테스트 영향

- `compare_models` 스키마 변경으로 인해 기존 테스트가 있다면 `providers` 기본값 호환성 확인 필요
- `cross_review` 스키마 변경도 동일

---

## 14. 구현 순서

```
Phase 1: 기반 인프라
  1. config.ts — CODEX_* 환경변수 추가
  2. types.ts — LLMProvider 타입 추가
  3. helpers/codex.ts — 전체 구현
  4. helpers/gemini.ts — isGeminiCliAvailable() 비-Windows 버그 수정

Phase 2: MCP 도구 통합
  5. tools/llm.ts — codex_ask, codex_analyze_codebase 추가
  6. tools/llm.ts — compare_models providers 파라미터 추가
  7. tools/llm.ts — smart_ask에 "codex" 옵션 추가

Phase 3: 생산성 도구 확장
  8. tools/productivity.ts — cross_review reviewers 옵션 추가
  9. tools/utility.ts — routeToLLM에 codex 분기 추가

Phase 4: 인프라 도구
  10. tools/health.ts — codex 헬스체크 추가
  11. index.ts — 스타트업 Codex 체크
  12. tools/setup.ts — checkAndInstallCodexCli() 추가

Phase 5: 테스트 & 문서
  13. __tests__/codex.test.ts 작성
  14. README.md 업데이트
```

---

## 15. 환경변수 전체 목록 (최종)

| 변수명 | 기본값 | 설명 |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API 주소 |
| `OLLAMA_MODEL_LIGHT` | `qwen2.5-coder:7b-instruct` | 7B 모델 |
| `OLLAMA_MODEL_FAST` | `qwen2.5-coder:14b-instruct` | 14B 모델 |
| `OLLAMA_MODEL_POWERFUL` | `qwen2.5-coder:32b-instruct-q4_K_M` | 32B 모델 |
| `GEMINI_TIMEOUT` | `120000` | Gemini CLI 타임아웃 (ms) |
| `GEMINI_FALLBACK` | `true` | Gemini 실패 시 Ollama 폴백 |
| `CODEX_TIMEOUT` | `120000` | Codex CLI 타임아웃 (ms) |
| `CODEX_MODEL` | `""` (Codex 기본값) | Codex 모델 지정 |
| `CODEX_FALLBACK` | `true` | Codex 실패 시 Ollama 폴백 |
| `CODEX_API_KEY` | — | OpenAI API 키 (Codex CLI가 직접 사용) |
| `SHELL_TIMEOUT` | `30000` | 셸 명령 타임아웃 (ms) |
| `MCP_REVIEW_DIR` | `.ai_reviews` | 리뷰 결과 저장 디렉토리 |
| `LOG_LEVEL` | `info` | 로그 레벨 |
