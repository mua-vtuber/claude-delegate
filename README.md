[English](README.en.md) | 한국어

# Claude Delegate MCP Server (v3.2.0)

Claude Code를 위한 **로컬 LLM(Ollama)** + **클라우드 LLM(Gemini CLI)** 통합 MCP 서버입니다.

파일 조작, 코드 분석, 웹 리서치, 데이터베이스 검사, 워크플로우 자동화 등 **68개 도구**를 제공합니다.

## 핵심 기능

- **하이브리드 라우팅**: 작업 복잡도와 목적에 따라 Ollama(무료) / Gemini(1M 토큰 컨텍스트) 자동 분배
- **자동 셋업**: GPU/VRAM 감지 → 최적 모델 계산 → 자동 설치 → 권한 설정까지 한 번에
- **VRAM 인식**: CPU 오프로드 없이 VRAM에 100% 적재 가능한 모델만 사용
- **토큰 절약**: 파일 분석/번역 시 서버 사이드 처리로 Claude 토큰 99.5% 절감
- **Gemini 폴백**: Gemini 실패 시 자동으로 Ollama로 전환

---

## 설치

### 사전 요구사항

- [Node.js](https://nodejs.org/) v18 이상
- [Ollama](https://ollama.com/) 로컬 실행 중
- [Google Gemini CLI](https://github.com/google/gemini-cli) (선택)
- [GitHub CLI](https://cli.github.com/) (선택, GitHub 도구 사용 시)

> **WSL 사용자 주의**: Claude Code를 WSL에서 실행하는 경우, **Gemini CLI도 반드시 WSL 내부에 설치**해야 합니다 (WSL 터미널에서 `npm install -g @google/gemini-cli`). Gemini CLI는 자식 프로세스로 실행되므로 MCP 서버와 같은 파일시스템 및 인코딩(UTF-8)을 공유해야 합니다. Windows에만 설치하면 `@file` 경로 해석 실패 및 인코딩 깨짐이 발생합니다.
>
> Ollama는 WSL에 설치할 필요가 **없습니다** — HTTP 통신(`localhost:11434`)이므로 Windows 데스크탑 버전으로 충분합니다.

### 설치 및 빌드

```bash
git clone https://github.com/mua-vtuber/claude-delegate.git
cd claude-delegate
npm install
npm run build
```

### Claude Code에 MCP 서버 등록

`claude_desktop_config.json` 또는 `.claude.json`에 추가:

```json
{
  "mcpServers": {
    "claude-delegate": {
      "command": "node",
      "args": ["<경로>/claude-delegate/dist/index.js"]
    }
  }
}
```

또는 Claude Code CLI로 등록:

```bash
claude mcp add claude-delegate node /absolute/path/to/claude-delegate/dist/index.js
```

### 자동 설정 (권장)

MCP 서버 등록 후 Claude에게 `delegate_setup` 도구를 한 번 실행하도록 요청하세요:

> "delegate_setup 도구를 실행해줘"

이 명령은 다음을 자동으로 수행합니다:

1. GPU/VRAM 감지 (nvidia-smi)
2. 모델별 VRAM 적합성 계산
3. 적합한 모델 자동 다운로드
4. **외부 CLI 의존성 확인 및 자동 설치**
   - **Gemini CLI**: 미설치 시 `npm install -g @google/gemini-cli` 자동 실행
   - **GitHub CLI**: 미설치 시 `winget install GitHub.cli` 자동 실행
   - 설치 후 인증이 필요한 경우 안내 메시지 제공
5. `.claude/settings.json`에 도구 사용 권한 추가
6. `CLAUDE.md`에 도구 사용 가이드 추가
7. `.mcp-profile.json`에 프로파일 캐시 저장

> **참고**: Gemini CLI와 GitHub CLI는 선택 사항입니다.
> 설치에 실패하더라도 셋업은 계속 진행되며, 해당 CLI가 필요한 도구만 비활성화됩니다.
> 설치 후 최초 인증이 필요합니다:
> - Gemini CLI: 첫 실행 시 브라우저에서 Google 계정 인증
> - GitHub CLI: `gh auth login` 실행

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama 서버 주소 |
| `OLLAMA_MODEL_LIGHT` | `qwen2.5-coder:7b-instruct` | 경량 작업용 모델 |
| `OLLAMA_MODEL_FAST` | `qwen2.5-coder:14b-instruct` | 일반 작업용 모델 |
| `OLLAMA_MODEL_POWERFUL` | `qwen2.5-coder:32b-instruct-q4_K_M` | 고급 작업용 모델 |
| `MCP_REVIEW_DIR` | `.ai_reviews` | 리뷰 저장 경로 |
| `GEMINI_TIMEOUT` | `120000` | Gemini 타임아웃 (ms) |
| `SHELL_TIMEOUT` | `30000` | 셸 명령 타임아웃 (ms) |
| `GEMINI_FALLBACK` | `true` | Gemini 실패 시 Ollama 폴백 |

---

## 도구 목록 (68개)

### Ollama / Gemini LLM (12)

| 도구 | 설명 |
|------|------|
| `ollama_chat` | Ollama와 채팅 (자동 모델 선택) |
| `ollama_analyze_file` | 파일 분석 (서버 사이드 읽기, 토큰 절약) |
| `ollama_analyze_files` | 다중 파일 분석 |
| `ollama_agent` | 도구 호출 에이전트 (파일 읽기/쓰기/검색/실행 자율 수행) |
| `ollama_list_models` | 설치된 모델 목록 |
| `ollama_embeddings` | 텍스트 임베딩 생성 |
| `ollama_pull` | 모델 다운로드 |
| `ollama_show` | 모델 상세 정보 |
| `gemini_ask` | Gemini CLI 질의 (실패 시 Ollama 폴백) |
| `gemini_analyze_codebase` | 코드베이스 분석 (1M 컨텍스트, 폴백 지원) |
| `smart_ask` | 복잡도 기반 자동 라우팅 |
| `compare_models` | Ollama vs Gemini 응답 비교 |

### LLM 유틸리티 (9)

| 도구 | 설명 |
|------|------|
| `translate_text` | 텍스트 번역 |
| `translate_file` | 파일 번역 (서버 사이드, 99.5% 토큰 절약) |
| `summarize_text` | 텍스트 요약 |
| `explain_code` | 코드 설명 |
| `extract_keywords` | 키워드 추출 |
| `improve_text` | 텍스트 품질 개선 |
| `prompt_template` | 프롬프트 템플릿 관리 |
| `response_cache` | LLM 응답 캐시 |
| `token_count` | 토큰 수 추정 |

### 파일 시스템 (4)

| 도구 | 설명 |
|------|------|
| `fs_write_file` | 파일 생성/덮어쓰기 |
| `fs_read_file` | 파일 읽기 |
| `fs_list_directory` | 디렉토리 목록 |
| `fs_search_files` | 파일 내용 검색 (정규식) |

### 개발 생산성 (10)

| 도구 | 설명 |
|------|------|
| `code_review` | Claude+Gemini 협업 코드 리뷰 세션 시작 |
| `code_review_discuss` | 코드 리뷰 토론 계속/종료 |
| `code_discussion` | Gemini와 솔루션 중심 토론 시작 |
| `code_discussion_continue` | 솔루션 토론 계속/종료 |
| `cross_review` | 적대적 병렬 리뷰: 양쪽 AI가 동일 규칙으로 독립 리뷰 |
| `validate_changes` | 수정 후 검증: Claude 수정 후 Gemini가 규칙 준수 여부 판정 |
| `git_commit_helper` | git diff 기반 커밋 메시지 생성 |
| `generate_unit_test` | 단위 테스트 자동 생성 |
| `add_docstrings` | 독스트링 자동 추가 |
| `todo_manager` | TODO.md 관리 (추가/완료/목록) |

### 코드 분석 (4)

| 도구 | 설명 |
|------|------|
| `check_types` | TypeScript/Python 타입 체크 (구조화된 출력) |
| `run_linter` | ESLint/Ruff 린터 실행 (심각도 분류) |
| `analyze_dependencies` | 의존성 분석 (취약점 감지) |
| `find_unused_exports` | 미사용 export 탐지 |

### 지식 그래프 (5)

| 도구 | 설명 |
|------|------|
| `memory_add_node` | 노드 추가 |
| `memory_add_relation` | 관계 추가 |
| `memory_query_graph` | 그래프 질의 |
| `memory_save_graph` | JSON으로 저장 |
| `memory_load_graph` | JSON에서 로드 |

### 셸 / 환경 (4)

| 도구 | 설명 |
|------|------|
| `shell_execute` | 셸 명령 실행 (허용된 명령만) |
| `env_get` | 환경 변수 조회 |
| `env_set` | 환경 변수 설정 (세션 한정) |
| `dotenv_parse` | .env 파일 파싱 |

### 프로세스 관리 (4)

| 도구 | 설명 |
|------|------|
| `process_list` | 프로세스 목록 |
| `process_kill` | PID로 프로세스 종료 |
| `background_run` | 백그라운드 명령 실행 |
| `background_status` | 백그라운드 프로세스 상태 |

### GitHub (3)

| 도구 | 설명 |
|------|------|
| `gh_create_pr` | Pull Request 생성 |
| `gh_list_issues` | 이슈 목록 |
| `gh_get_issue` | 이슈 상세 보기 |

### 메모리 (2)

| 도구 | 설명 |
|------|------|
| `manage_memory` | 프로젝트 메모리에 사실/규칙 저장 |
| `read_memory` | 프로젝트 메모리 읽기 |

### Diff / 패치 (2)

| 도구 | 설명 |
|------|------|
| `diff_files` | 두 파일 비교 (unified diff) |
| `diff_strings` | 두 문자열 비교 |

### 시스템 설정 (2)

| 도구 | 설명 |
|------|------|
| `delegate_system_profile` | GPU/VRAM 감지 및 최적 모델 설정 계산 |
| `delegate_setup` | 하드웨어 감지 → 모델 설치 → 권한 설정 자동화 |

### RAG (3)

| 도구 | 설명 |
|------|------|
| `rag_index` | 디렉토리/파일을 벡터 스토어에 인덱싱 |
| `rag_search` | 벡터 인덱스에서 관련 코드 청크 검색 |
| `rag_ask` | RAG 기반 질의응답 (컨텍스트 검색 후 Ollama 응답) |

### 기타 (4)

| 도구 | 설명 |
|------|------|
| `fetch_url` | URL에서 텍스트 추출 |
| `sqlite_query` | SQLite 쿼리 실행 |
| `think_step` | 순차적 추론 단계 기록 |
| `health_check` | Ollama/Gemini 서비스 상태 점검 |

---

## 스마트 라우팅

### 목적 기반 모델 선택

각 도구는 자신의 용도를 알고 있어 최적 모델을 자동으로 선택합니다:

| 용도 | 모델 | 예시 |
|------|------|------|
| 번역 | 7B (Light) | `translate_file`, `translate_text` |
| 코드 리뷰 | Gemini CLI (Ollama 폴백) | `code_review`, `cross_review`, `validate_changes` |
| 에이전트 | 14B (Fast) | `ollama_agent` |
| 분석/일반 | 복잡도 기반 자동 | `smart_ask`, `ollama_chat` |

### VRAM 인식 다운그레이드

프로파일이 존재하면 VRAM에 맞지 않는 모델을 자동으로 한 단계 낮춥니다:

```
요청: 32B → VRAM 부족 → 자동으로 14B 사용
요청: 14B → VRAM 부족 → 자동으로 7B 사용
```

### 자동 num_ctx 최적화

`delegate_setup` 실행 후 모든 Ollama API 호출에 VRAM 기반 최적 컨텍스트 크기가 자동 적용됩니다. 별도 설정이 필요 없습니다.

---

## VRAM 계산 예시 (16GB GPU)

| 모델 | 모델 크기 | 버퍼 | 여유 VRAM | 적합 | num_ctx |
|------|-----------|------|-----------|------|---------|
| 7B | 4,813 MB | 2,048 MB | 9,515 MB | O | 32,768 |
| 14B | 9,728 MB | 2,048 MB | 4,600 MB | O | 4,600 |
| 32B | 18,432 MB | 2,048 MB | -4,104 MB | X | 제외 |

- 모델 크기 + KV 캐시 + 2GB 버퍼 > 총 VRAM인 모델은 완전 제외됩니다
- CPU 오프로드는 사용하지 않습니다 (속도 저하 방지)

---

## 구조화된 출력 (코드 분석)

코드 분석 도구들은 구조화된 출력을 지원합니다:

| 형식 | 용도 |
|------|------|
| `json` | CI/CD 연동, 자동화 |
| `markdown` | 코드 리뷰, 문서화 |
| `summary` | 빠른 상태 확인 |
| `legacy` | 기존 CLI 원문 출력 |

반복 분석 시 개선/악화 추세도 추적합니다.

---

## Gemini 폴백

Gemini CLI가 실패하면 (토큰 초과, 인증 오류 등) 자동으로 Ollama 32B로 전환됩니다. 응답에 `[Fallback: Ollama]` 표시가 붙습니다.

```
비용 우선순위: Ollama(무료) → Gemini(구독) → Claude(API 과금)
```

---

## 프로젝트 구조

```
claude-delegate/
├── src/
│   ├── index.ts          # 진입점 (stdio 전송, 프로파일 로드)
│   ├── server.ts         # MCP 서버 설정 및 디스패치 맵
│   ├── config.ts         # 환경 변수 및 상수
│   ├── types.ts          # TypeScript 타입 정의
│   ├── state.ts          # 런타임 상태 (프로파일 캐시, 리뷰 세션)
│   ├── security.ts       # 경로/명령 검증
│   ├── middleware.ts      # 요청 로깅 및 유효성 검사
│   ├── validation.ts      # 입력 유효성 검사
│   ├── logger.ts          # 로깅 유틸리티
│   ├── helpers/
│   │   ├── ollama.ts      # Ollama API, 도구 호출, 에이전트
│   │   ├── gemini.ts      # Gemini CLI 래퍼, 폴백
│   │   ├── routing.ts     # 모델 선택 (목적/복잡도/VRAM)
│   │   ├── profiler.ts    # GPU 감지, VRAM 계산, 프로파일
│   │   ├── filesystem.ts  # 파일 시스템 헬퍼
│   │   ├── vectorstore.ts # 벡터 스토어 (RAG용)
│   │   ├── analysis.ts    # 코드 분석 헬퍼
│   │   ├── diff.ts        # diff 생성 헬퍼
│   │   └── response-validator.ts # 응답 유효성 검사
│   ├── utils/
│   │   └── schema-converter.ts   # Zod→JSON 스키마 변환
│   ├── tools/             # 17개 도구 모듈 (68개 도구)
│   └── __tests__/         # 테스트
├── .mcp-profile.json      # 시스템 프로파일 캐시 (delegate_setup 생성)
├── .ai_reviews/           # 분석 결과 저장소
├── .ai_context.md         # 프로젝트 메모리
└── package.json
```

---

## 스크립트

```bash
npm run build      # TypeScript 빌드
npm run start      # 서버 실행
npm run dev        # 감시 모드 빌드
npm test           # 테스트 실행
```

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| Ollama 연결 실패 | `ollama serve` 실행 확인 |
| Gemini 인증 오류 | `gemini auth login` 실행 |
| 도구가 사용되지 않음 | `delegate_setup` 실행 (settings.json 권한 자동 추가) |
| 빌드 오류 | `npm run build` 재실행 |
| 32B 모델 느림 | `delegate_setup` 실행 (VRAM 부족 시 자동 제외) |

---

## 라이선스

MIT
