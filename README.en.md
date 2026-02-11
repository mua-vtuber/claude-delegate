English | [한국어](README.md)

# claude-delegate - Hybrid LLM MCP Server

A **local LLM (Ollama)** + **cloud LLM (Gemini CLI)** integration MCP server for Claude Code.

Provides **68 tools** for file manipulation, code analysis, web research, database inspection, and workflow automation.

## Key Features

- **Hybrid Routing**: Automatic distribution between Ollama (free) / Gemini (1M token context) based on task complexity and purpose
- **Auto Setup**: GPU/VRAM detection → optimal model calculation → automatic installation → permission configuration in one step
- **VRAM-Aware**: Only uses models that fit 100% in VRAM without CPU offload
- **Token Savings**: Server-side processing for file analysis/translation saves 99.5% of Claude tokens
- **Gemini Fallback**: Automatically switches to Ollama on Gemini failures

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [Ollama](https://ollama.com/) running locally
- [Google Gemini CLI](https://github.com/google/gemini-cli) (optional)
- [GitHub CLI](https://cli.github.com/) (optional, for GitHub tools)

> **WSL Users**: If you run Claude Code in WSL, **Gemini CLI must also be installed inside WSL** (`npm install -g @google/gemini-cli` in WSL terminal). Gemini CLI is spawned as a child process, so it must share the same filesystem and encoding (UTF-8) as the MCP server. A Windows-only installation will cause path resolution failures with `@file` references and potential encoding issues.
>
> Ollama does **not** need to be in WSL — it communicates via HTTP (`localhost:11434`), so the Windows desktop version works fine from WSL.

### Install and Build

```bash
git clone https://github.com/mua-vtuber/claude-delegate.git
cd claude-delegate
npm install
npm run build
```

### Register MCP Server in Claude Code

Add to `claude_desktop_config.json` or `.claude.json`:

```json
{
  "mcpServers": {
    "claude-delegate": {
      "command": "node",
      "args": ["<path>/claude-delegate/dist/index.js"]
    }
  }
}
```

Or register via Claude Code CLI:

```bash
claude mcp add claude-delegate node /absolute/path/to/claude-delegate/dist/index.js
```

### Automatic Setup (Recommended)

After registering the MCP server, ask Claude to run the `delegate_setup` tool once:

> "Run the delegate_setup tool"

This command automatically performs:

1. GPU/VRAM detection (nvidia-smi)
2. Model-by-model VRAM compatibility calculation
3. Automatic download of compatible models
4. **External CLI dependency detection and auto-installation**
   - **Gemini CLI**: Auto-runs `npm install -g @google/gemini-cli` if not installed
   - **GitHub CLI**: Auto-runs `winget install GitHub.cli` if not installed
   - Provides authentication guidance after installation
5. Add tool permissions to `.claude/settings.json`
6. Add tool usage guide to `CLAUDE.md`
7. Save profile cache to `.mcp-profile.json`

> **Note**: Gemini CLI and GitHub CLI are optional.
> Setup continues even if installation fails; only tools requiring those CLIs will be unavailable.
> Initial authentication is required after installation:
> - Gemini CLI: Authenticate via browser on first run
> - GitHub CLI: Run `gh auth login`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server address |
| `OLLAMA_MODEL_LIGHT` | `qwen2.5-coder:7b-instruct` | Model for lightweight tasks |
| `OLLAMA_MODEL_FAST` | `qwen2.5-coder:14b-instruct` | Model for general tasks |
| `OLLAMA_MODEL_POWERFUL` | `qwen2.5-coder:32b-instruct-q4_K_M` | Model for advanced tasks |
| `MCP_REVIEW_DIR` | `.ai_reviews` | Review save path |
| `GEMINI_TIMEOUT` | `120000` | Gemini timeout (ms) |
| `SHELL_TIMEOUT` | `30000` | Shell command timeout (ms) |
| `GEMINI_FALLBACK` | `true` | Fallback to Ollama on Gemini failure |

---

## Tool List (68 tools)

### Tool Categories

| Category | Count | Description |
|----------|-------|-------------|
| **Ollama / Gemini LLM** | 12 | Chat, file analysis, agent, embeddings, model comparison |
| **LLM Utilities** | 9 | Translation, summarization, code explanation, templates |
| **File System** | 4 | Read, write, list, search |
| **Productivity** | 10 | Code review, adversarial review, discussions, commit messages, tests, docstrings, TODO |
| **Code Analysis** | 4 | Type checking, linting, dependency analysis, unused exports |
| **Knowledge Graph** | 5 | Node/relation management, queries, save/load |
| **Shell / Environment** | 4 | Execute commands, environment variables, .env parsing |
| **Process Management** | 4 | List, kill, background execution, status |
| **GitHub** | 3 | Create PR, list/get issues |
| **Memory** | 2 | Project memory management |
| **Diff / Patch** | 2 | File/string comparison |
| **System Setup** | 2 | GPU profiling, auto setup |
| **Thinking** | 1 | Sequential reasoning steps |
| **Web** | 1 | URL content fetching |
| **Database** | 1 | SQLite queries |
| **Health** | 1 | Service health check |
| **RAG** | 3 | Vector indexing, search, RAG Q&A |

### Ollama / Gemini LLM (12)

| Tool | Description |
|------|-------------|
| `ollama_chat` | Chat with Ollama (automatic model selection) |
| `ollama_analyze_file` | Analyze file (server-side read, saves tokens) |
| `ollama_analyze_files` | Analyze multiple files |
| `ollama_agent` | Tool-calling agent (autonomous file read/write/search/execute) |
| `ollama_list_models` | List installed models |
| `ollama_embeddings` | Generate text embeddings |
| `ollama_pull` | Download model |
| `ollama_show` | Show model details |
| `gemini_ask` | Query Gemini CLI (fallback to Ollama on failure) |
| `gemini_analyze_codebase` | Codebase analysis (1M context, fallback support) |
| `smart_ask` | Complexity-based automatic routing |
| `compare_models` | Compare Ollama vs Gemini responses |

### LLM Utilities (9)

| Tool | Description |
|------|-------------|
| `translate_text` | Translate text |
| `translate_file` | Translate file (server-side, 99.5% token savings) |
| `summarize_text` | Summarize text |
| `explain_code` | Explain code |
| `extract_keywords` | Extract keywords |
| `improve_text` | Improve text quality |
| `prompt_template` | Manage prompt templates |
| `response_cache` | LLM response cache |
| `token_count` | Estimate token count |

### File System (4)

| Tool | Description |
|------|-------------|
| `fs_write_file` | Create/overwrite file |
| `fs_read_file` | Read file |
| `fs_list_directory` | List directory |
| `fs_search_files` | Search file content (regex) |

### Productivity (10)

| Tool | Description |
|------|-------------|
| `code_review` | Start Claude+Gemini collaborative code review session |
| `code_review_discuss` | Continue or end code review discussion |
| `code_discussion` | Start a solution-focused discussion with Gemini |
| `code_discussion_continue` | Continue or end a solution discussion |
| `cross_review` | Adversarial parallel review: both AIs review against same rules |
| `validate_changes` | Post-modification validator: Gemini checks changes against rules |
| `git_commit_helper` | Generate commit message from git diff |
| `generate_unit_test` | Auto-generate unit tests |
| `add_docstrings` | Auto-add docstrings |
| `todo_manager` | Manage TODO.md (add/complete/list) |

### Code Analysis (4)

| Tool | Description |
|------|-------------|
| `check_types` | TypeScript/Python type checking (structured output) |
| `run_linter` | Run ESLint/Ruff linter (severity classification) |
| `analyze_dependencies` | Dependency analysis (vulnerability detection) |
| `find_unused_exports` | Detect unused exports |

### Knowledge Graph (5)

| Tool | Description |
|------|-------------|
| `memory_add_node` | Add node |
| `memory_add_relation` | Add relation |
| `memory_query_graph` | Query graph |
| `memory_save_graph` | Save to JSON |
| `memory_load_graph` | Load from JSON |

### Shell / Environment (4)

| Tool | Description |
|------|-------------|
| `shell_execute` | Execute shell command (allowed commands only) |
| `env_get` | Get environment variable |
| `env_set` | Set environment variable (session-scoped) |
| `dotenv_parse` | Parse .env file |

### Process Management (4)

| Tool | Description |
|------|-------------|
| `process_list` | List processes |
| `process_kill` | Kill process by PID |
| `background_run` | Run command in background |
| `background_status` | Check background process status |

### GitHub (3)

| Tool | Description |
|------|-------------|
| `gh_create_pr` | Create pull request |
| `gh_list_issues` | List issues |
| `gh_get_issue` | Get issue details |

### Memory (2)

| Tool | Description |
|------|-------------|
| `manage_memory` | Save facts/rules to project memory |
| `read_memory` | Read project memory |

### Diff / Patch (2)

| Tool | Description |
|------|-------------|
| `diff_files` | Compare two files (unified diff) |
| `diff_strings` | Compare two strings |

### System Setup (2)

| Tool | Description |
|------|-------------|
| `delegate_system_profile` | Detect GPU/VRAM and calculate optimal model settings |
| `delegate_setup` | Hardware detection → model installation → permission setup automation |

### RAG (3)

| Tool | Description |
|------|-------------|
| `rag_index` | Index directories/files into vector store for RAG search |
| `rag_search` | Search vector index for relevant code chunks |
| `rag_ask` | RAG-powered Q&A: search relevant code, then answer via Ollama |

### Other (4)

| Tool | Description |
|------|-------------|
| `fetch_url` | Extract text from URL |
| `sqlite_query` | Execute SQLite query |
| `think_step` | Record sequential reasoning steps |
| `health_check` | Check Ollama/Gemini service status |

---

## Smart Routing

### Purpose-Based Model Selection

Each tool knows its purpose and automatically selects the optimal model:

| Purpose | Model | Examples |
|---------|-------|----------|
| Translation | 7B (Light) | `translate_file`, `translate_text` |
| Code Review | Gemini CLI (Ollama fallback) | `code_review`, `cross_review`, `validate_changes` |
| Agent | 14B (Fast) | `ollama_agent` |
| Analysis/General | Complexity-based auto | `smart_ask`, `ollama_chat` |

### VRAM-Aware Downgrade

If a profile exists, models that don't fit in VRAM are automatically downgraded:

```
Request: 32B → VRAM insufficient → Auto-switch to 14B
Request: 14B → VRAM insufficient → Auto-switch to 7B
```

### Automatic num_ctx Optimization

After running `delegate_setup`, all Ollama API calls automatically apply VRAM-based optimal context size. No additional configuration needed.

---

## VRAM Calculation Example (16GB GPU)

| Model | Model Size | Buffer | Free VRAM | Compatible | num_ctx |
|-------|------------|--------|-----------|------------|---------|
| 7B | 4,813 MB | 2,048 MB | 9,515 MB | ✓ | 32,768 |
| 14B | 9,728 MB | 2,048 MB | 4,600 MB | ✓ | 4,600 |
| 32B | 18,432 MB | 2,048 MB | -4,104 MB | ✗ | Excluded |

- Models where model size + KV cache + 2GB buffer > total VRAM are completely excluded
- CPU offload is not used (to prevent speed degradation)

---

## Structured Output (Code Analysis)

Code analysis tools support structured output:

| Format | Purpose |
|--------|---------|
| `json` | CI/CD integration, automation |
| `markdown` | Code review, documentation |
| `summary` | Quick status check |
| `legacy` | Original CLI output |

Tracks improvement/degradation trends for repeated analysis.

---

## Gemini Fallback

When Gemini CLI fails (token limit exceeded, auth errors, etc.), it automatically switches to Ollama 32B. Response shows `[Fallback: Ollama]` indicator.

```
Cost Priority: Ollama (free) → Gemini (subscription) → Claude (API billing)
```

---

## Security

### Path Validation
- Whitelist-based path traversal protection
- Prevents access outside project directory
- Blocks system file modifications

### Command Allowlist
- Shell execution limited to safe commands
- Prevents arbitrary command injection
- Validated against security checklist

### SSRF Protection
- URL scheme validation (http/https only)
- Localhost-only for Ollama host
- Prevents external code execution

### Secret Filtering
- Automatic redaction of API keys
- Environment variable sanitization
- Safe logging practices

---

## Project Structure

```
claude-delegate/
├── src/
│   ├── index.ts          # Entry point (stdio transport, profile loading)
│   ├── server.ts         # MCP server setup and dispatch map
│   ├── config.ts         # Environment variables and constants
│   ├── types.ts          # TypeScript type definitions
│   ├── state.ts          # Runtime state (profile cache, review sessions)
│   ├── security.ts       # Path/command validation
│   ├── middleware.ts      # Request logging and validation
│   ├── validation.ts      # Input validation
│   ├── logger.ts          # Logging utility
│   ├── helpers/
│   │   ├── ollama.ts      # Ollama API, tool calling, agent
│   │   ├── gemini.ts      # Gemini CLI wrapper, fallback
│   │   ├── routing.ts     # Model selection (purpose/complexity/VRAM)
│   │   ├── profiler.ts    # GPU detection, VRAM calculation, profiling
│   │   ├── filesystem.ts  # File system helpers
│   │   ├── vectorstore.ts # Vector store (for RAG)
│   │   ├── analysis.ts    # Code analysis helpers
│   │   ├── diff.ts        # Diff generation helpers
│   │   └── response-validator.ts # Response validation
│   ├── utils/
│   │   └── schema-converter.ts   # Zod to JSON Schema converter
│   ├── tools/             # 17 tool modules (64 tools)
│   └── __tests__/         # Tests
├── .mcp-profile.json      # System profile cache (created by delegate_setup)
├── .ai_reviews/           # Analysis result storage
├── .ai_context.md         # Project memory
└── package.json
```

---

## Scripts

```bash
npm run build      # Build TypeScript
npm run start      # Run server
npm run dev        # Build in watch mode
npm test           # Run tests
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Ollama connection failure | Verify `ollama serve` is running |
| Gemini auth error | Run `gemini auth login` |
| Tools not being used | Run `delegate_setup` (auto-adds settings.json permissions) |
| Build error | Re-run `npm run build` |
| 32B model slow | Run `delegate_setup` (auto-excludes if VRAM insufficient) |

---

## License

MIT
