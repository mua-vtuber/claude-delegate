# 도구 이름 체계 개선 계획 (v4.0)

## 개요

claude-delegate MCP 서버의 도구 이름 체계가 **일관성 있는가?** , **미래 호환성이 있는가?** , **다중 MCP 서버 환경에서 혼동되지 않는가?** 에 대해 검토합니다.

**결론**: 현재 이름 체계를 **유지하되**, 향후 실제 이름 충돌이 보고될 때만 변경할 것을 권장합니다.

---

## 현재 상태

### 도구 이름 패턴

```
현재 형식: {category}_{function}

예시:
- fs_write_file          (파일시스템)
- ollama_chat            (LLM - Ollama)
- gemini_ask             (LLM - Gemini)
- code_review            (생산성)
- shell_execute          (셸)
- memory_add_node        (지식 그래프)
```

### MCP 네임스페이싱

MCP 클라이언트가 도구를 호출할 때 사용되는 **완전한 이름**:

```
mcp__claude-delegate__{tool_name}

예시:
- mcp__claude-delegate__fs_write_file
- mcp__claude-delegate__ollama_chat
- mcp__claude-delegate__gemini_ask
```

---

## 현재 이름 체계 평가

### 장점

#### 1. 명확성 (Clarity)

```typescript
// 도구 이름만 보고도 용도가 명확함

fs_write_file       // 파일 쓰기
fs_read_file        // 파일 읽기
fs_list_directory   // 디렉토리 목록
fs_search_files     // 파일 검색

ollama_chat         // Ollama와 채팅
ollama_analyze_file // 파일 분석
ollama_agent        // 에이전트 실행

gemini_ask          // Gemini에 질문
gemini_analyze_codebase  // 코드베이스 분석

shell_execute       // 셸 명령 실행
```

#### 2. 카테고리별 그룹화

LLM이 도구를 선택할 때 관련 도구들이 함께 노출됨:

```
사용자: "파일을 읽고 코드 검토해줘"

LLM이 보는 도구 목록:
- fs_read_file
- fs_write_file
- fs_list_directory
- code_review
- ollama_analyze_file
- ...

→ fs_로 시작하는 도구들이 자동으로 그룹화되어 선택 용이
```

#### 3. MCP 네임스페이싱 보호

MCP 표준에서 제공하는 네임스페이싱이 이름 충돌을 기술적으로 방지:

```
다른 MCP 서버의 "chat" 도구와 충돌 방지:
- mcp__other-server__chat          ≠
- mcp__claude-delegate__ollama_chat
```

#### 4. 버전 안정성

도구 이름이 변경되지 않아서 기존 클라이언트/스크립트와의 호환성 유지:

```typescript
// 기존 코드가 계속 작동
ollama_chat(prompt)     // v3.0 이후에도 동일
gemini_ask(prompt)      // v3.0 이후에도 동일
```

### 단점

#### 1. 의미적 혼동 가능성 (의료도 낮음)

여러 MCP 서버 사용 시 LLM이 어떤 서버의 도구인지 혼동할 수 있음:

```
시나리오: Ollama 도구 + 다른 로컬 도구 MCP 사용

사용자: "코드를 분석해줘"

LLM에게 보이는 도구들:
- claude-delegate: ollama_analyze_file
- other-server: analyze_code
- another-server: analyze_python

→ "분석" 관련 도구가 3개인데, 어떤 것을 선택할지 혼동 가능
→ 하지만 현실적으로는 프롬프트 컨텍스트에서 구분됨
```

#### 2. 도구 이름이 길 수 있음

```
긴 이름:
- gemini_analyze_codebase       (24자)
- memory_add_relation            (18자)
- generate_unit_test             (17자)
- ollama_analyze_files           (19자)

UI에서 도구 이름 표시 시 공간 많이 차지
```

---

## 고려한 대안 방식

### 방안 A: 명시적 서버 접두사 추가

**형식**: `{server}_{category}_{function}`

```typescript
// delegate_로 시작하여 명시적으로 식별

delegate_fs_write_file
delegate_ollama_chat
delegate_shell_execute

// 장점:
// - 어느 MCP 서버의 도구인지 명확
// - 다중 MCP 환경에서 혼동 감소

// 단점:
// - Breaking change (기존 클라이언트 호환성 깨짐)
// - 이름이 더 길어짐 (delegate_ 접두사 추가)
// - 이미 MCP 네임스페이싱이 있어서 중복
// - 이점 부족 (이미 mcp__claude-delegate__로 구분됨)
```

### 방안 B: 축약된 접두사

**형식**: `cd_{category}_{function}`

```typescript
// cd_로 시작 (claude-delegate 약자)

cd_fs_write_file
cd_ollama_chat
cd_shell_execute

// 장점:
// - 짧음 (2-3자만 추가)
// - 명시적 식별 가능

// 단점:
// - 의미가 불명확함 (cd = claude-delegate?)
// - Breaking change
// - 대문자 관례 깨짐 (snake_case만 사용)
// - LLM 입장에서 "cd"가 뭔지 모를 수 있음
```

### 방안 C: 설명적 이름 재구성

**형식**: `{action}_{target}_{detail}` (더 의미론적)

```typescript
// 더 설명적인 이름으로 변경

read_local_file              // fs_read_file → 더 명확
write_local_file             // fs_write_file
analyze_with_ollama          // ollama_analyze_file → 어느 LLM인지 명확
ask_gemini                   // gemini_ask
execute_shell_command        // shell_execute → 더 명확
review_code                  // code_review

// 장점:
// - 설명적이고 의미 명확

// 단점:
// - Breaking change
// - 이름이 더 길어짐
// - 기존 30개 이상의 클라이언트/통합이 깨짐
// - 이점이 명확하지 않음 (현재 이름도 충분히 명확)
```

### 방안 D: 선택적 Alias (별칭)

**형식**: 주 이름 + 선택적 별칭 지원

```typescript
// 기존 이름 유지하면서 별칭 추가

{
  name: "fs_write_file",
  aliases: ["write_local_file", "write_file"],
  ...
}

{
  name: "ollama_chat",
  aliases: ["ask_ollama", "chat_ollama"],
  ...
}

// 장점:
// - Breaking change 없음
// - 새로운 이름 선택지 제공
// - 유연성

// 단점:
// - MCP 표준에서 aliases 지원하지 않음
// - 구현 복잡도 증가
// - LLM이 여러 이름으로 같은 도구를 볼 때 혼동 가능
```

---

## 분석: 현재 이름 체계의 문제가 실제인가?

### 실제 충돌 시나리오 분석

#### 시나리오 1: 다중 MCP 서버 + 모호한 이름

```
활성 MCP 서버:
1. claude-delegate (이 프로젝트)
   - ollama_chat
   - gemini_ask

2. my-other-tools (가상의 다른 MCP)
   - chat (추상적)
   - ask  (추상적)

도구 목록:
- mcp__claude-delegate__ollama_chat  ✓ 명확 (Ollama 이용)
- mcp__claude-delegate__gemini_ask   ✓ 명확 (Gemini 이용)
- mcp__my-other-tools__chat          ✗ 불명확 (어떤 채팅?)
- mcp__my-other-tools__ask           ✗ 불명확 (뭐에 물어봄?)

결론: 충돌 문제 없음. 오히려 claude-delegate가 더 명확함.
```

#### 시나리오 2: 이름 길이 문제

```
현재 최장 도구 이름:
- gemini_analyze_codebase       (24자)
- ollama_analyze_files          (19자)

UI/CLI에서 표시:
┌─────────────────────────┐
│ 사용 가능한 도구:        │
│ • fs_write_file         │
│ • fs_read_file          │
│ • fs_list_directory     │
│ • ollama_analyze_file   │
│ • gemini_ask            │
│ ...                     │
└─────────────────────────┘

→ 전혀 문제 없음. 현대 UI는 충분히 긴 이름 표시 가능.
```

#### 시나리오 3: LLM 선택 혼동

```
사용자: "파일을 분석해줘"

LLM이 선택 가능:
1. ollama_analyze_file   (Ollama 모델로 분석)
2. gemini_analyze_codebase (Gemini로 분석)
3. code_review           (코드 리뷰)

LLM 입장:
- 도구 이름이 명확하게 다름
- 설명문도 명확하게 다름
- 혼동 가능성 거의 없음

→ 실제 문제 아님
```

---

## 결론: 현재 이름 체계 유지

### 근거

#### 1. Breaking Change의 비용이 큼

```
변경 시 영향:
- 30개 이상의 클라이언트 스크립트 수정 필요
- 문서 업데이트 필요
- 사용자 교육 필요
- 마이너 버전이 아닌 메이저 버전 업그레이드
- 채택 지연 가능
```

#### 2. 현재 이름이 충분히 명확함

```
카테고리별 의도가 명확:
- fs_* : 파일 시스템 조작
- ollama_* : Ollama LLM 사용
- gemini_* : Gemini LLM 사용
- shell_* : 셸 명령
- code_* : 코드 관련
- memory_* : 지식 그래프
```

#### 3. MCP 네임스페이싱이 이미 보호함

```
mcp__claude-delegate__{tool_name} 형식이 이미:
- 서버 식별
- 이름 충돌 방지
- 명확성 제공

추가 접두사 불필요
```

#### 4. 향후 확장성 있음

```
현재 명명 규칙으로:
- 새로운 카테고리 추가 가능 (예: db_*, api_*, etc_*)
- 도구 추가/제거 용이
- 명확한 구조 유지
```

---

## 권장 가이드라인

### 1. 새로운 도구 추가 시 규칙

```typescript
// ✓ Good: 카테고리_기능
new_category_action
fs_write_file          // 파일시스템_쓰기
ollama_chat            // ollama_채팅
gemini_ask             // gemini_질문
shell_execute          // 셸_실행

// ✗ Bad: 모호한 이름
analyze               // 어떻게 분석?
execute               // 뭘 실행?
do_something          // 뭐 하는 거?
```

### 2. 명명 규칙 문서화

**새로운 파일**: `docs/design/naming-conventions.md`

```markdown
# 도구 이름 지정 규칙

## 포맷
{category}_{action}_{target}?

## 카테고리 목록
- fs_*              : 파일시스템 (fs_read_file, fs_write_file)
- shell_*           : 셸 명령 (shell_execute)
- ollama_*          : Ollama LLM (ollama_chat, ollama_analyze_file)
- gemini_*          : Gemini LLM (gemini_ask)
- code_*            : 코드 관련 (code_review)
- memory_*          : 지식 그래프 (memory_add_node)
- analyze_*         : 분석 (analyze_dependencies)
- process_*         : 프로세스 관리 (process_list)

## 명명 예시
- fs_write_file         ✓ (카테고리_동사_명사)
- ollama_analyze_file   ✓ (카테고리_동사_명사)
- code_review           ✓ (카테고리_동사)

- file_write            ✗ (카테고리 없음)
- fs_write              ✗ (너무 약자만 사용)
- write_local_file      ✗ (카테고리 뒤에 올 것)
```

### 3. 기존 도구 이름 안정화

```typescript
// 현재 이름 모두 유지
// 제거/변경 계획 없음
// v4.0, v5.0에서도 호환성 보장

const stableTool = {
  name: "fs_write_file",
  description: "Write content to a file",
  stable: true,           // 이름 변경 계획 없음
  minimumVersion: "3.0"
};
```

---

## 재검토 시점

언제 이 결정을 다시 평가할 것인가?

### 1. 실제 이름 충돌 발생

```
시나리오:
- 다른 MCP 서버가 동일한 이름 사용
- LLM이 혼동하는 보고
- 사용자가 명시적 식별 요청

→ 그 시점에 이름 체계 재검토
```

### 2. 표준 변화

```
MCP 표준에서:
- Tool aliases 지원 추가
- 더 나은 네임스페이싱 메커니즘 제공
- 명명 가이드라인 발표

→ 그 시점에 재검토
```

### 3. 생태계 성숙

```
Claude Delegate 채택이 증가하여:
- 50+ 통합 사례 발생
- 커뮤니티 피드백 축적
- 실제 문제점 파악

→ v5.0+ 때 재검토
```

---

## 향후 개선 아이디어 (선택사항)

현재 이름을 유지하면서 추가로 개선할 수 있는 사항:

### 1. 도구 설명 강화

```typescript
{
  name: "ollama_chat",
  description: "Chat with Ollama LLM (local model)",
  category: "llm",
  provider: "ollama",
  longDescription: "..."
}
```

### 2. 도구 탐색 메타데이터

```typescript
{
  name: "fs_write_file",
  tags: ["filesystem", "write", "local"],
  capabilities: ["create", "overwrite"],
  relatedTools: ["fs_read_file", "fs_list_directory"]
}
```

### 3. 도구 그룹 정의

```typescript
const toolGroups = {
  filesystem: ["fs_write_file", "fs_read_file", "fs_list_directory"],
  llm: ["ollama_chat", "gemini_ask", "smart_ask"],
  code_analysis: ["code_review", "generate_unit_test", "check_types"]
};
```

---

## 결정 기록

**결정일**: 2026-02-01
**결정**: 현재 이름 체계 유지
**근거**:
1. Breaking change 비용이 큼 (30+ 통합)
2. 현재 이름이 충분히 명확함
3. MCP 네임스페이싱이 이미 보호함
4. 실제 충돌 보고 없음

**재검토 시점**: 다음 메이저 버전 (v5.0) 또는 실제 충돌 발생 시

---

## 참고 자료

- [MCP Tool Naming Guide](https://modelcontextprotocol.io/docs/tools)
- [POSIX Command Naming Conventions](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/intro.html)
- [Google API Design Guide](https://cloud.google.com/apis/design)
