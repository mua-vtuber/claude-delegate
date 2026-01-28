# Claude Delegate MCP Server (v3.2.0)

A powerful **Model Context Protocol (MCP)** server that bridges your local environment with **Ollama** (Local LLM) and **Google Gemini** (Cloud LLM). 

This server transforms your AI assistant into a **Full-Stack Developer** capable of file manipulation, web research, database inspection, and workflow automation.

## 🚀 Key Features

- **Hybrid Intelligence**: Automatically routes simple tasks to **Ollama** (Free/Fast) and complex architectural tasks to **Gemini** (1M Token Context).
- **File System Control**: Read, write, list, and search files directly.
- **Web Research**: Fetch and read documentation or articles from URLs.
- **Memory Management**: Persist project context, rules, and preferences across sessions.
- **Dev Productivity**: Auto-generate unit tests, commit messages, and docstrings.
- **GitHub Integration**: Create PRs and manage issues directly from chat.
- **Database Tools**: Inspect SQLite databases.

---

## 🛠️ Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/) (Running locally)
- [Google Gemini CLI](https://github.com/google/gemini-cli) (Installed globally or locally)
- [GitHub CLI](https://cli.github.com/) (Optional, for GitHub tools)

### Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd claude-delegate

# 2. Install dependencies
npm install

# 3. Build the project
npm run build
```

### Configuration
Ensure your environment variables are set if necessary (e.g., `OLLAMA_HOST` if not localhost).
The server relies on the standard `gemini` command or `google-gemini-cli` node module.

---

## 📚 Available Tools

### 1. File System Operations
- **`fs_write_file`**: Create or overwrite files.
- **`fs_read_file`**: Read file contents.
- **`fs_list_directory`**: Explore folder structures.
- **`fs_search_files`**: Search code using regex.

### 2. Research & Memory
- **`fetch_url`**: Scrape text content from a URL (great for reading docs).
- **`manage_memory`**: Save facts/rules to `.ai_context.md`.
- **`read_memory`**: Recall project context.

### 3. Developer Productivity
- **`code_review`**: Comprehensive code analysis (Report in Korean).
- **`git_commit_helper`**: Generate semantic commit messages from `git diff`.
- **`generate_unit_test`**: Create `.test.ts` files using 32B model logic.
- **`add_docstrings`**: Auto-document functions/classes.
- **`todo_manager`**: Manage `TODO.md` (list, add, complete tasks).

### 4. Database & GitHub
- **`sqlite_query`**: Run read-only queries on SQLite `.db` files.
- **`gh_create_pr`**: Open a Pull Request.
- **`gh_list_issues`**: View repository issues.

### 5. LLM Interactions
- **`smart_ask`**: Auto-routes query to Ollama or Gemini based on complexity.
- **`gemini_analyze_codebase`**: Analyzes huge codebases using 1M token window.
- **`ollama_chat`**: Direct chat with local models.

### 6. Code Analysis Tools (v3.2.0)
- **`check_types`**: TypeScript/Python type checking with structured output.
- **`run_linter`**: Run ESLint/Ruff with severity classification.
- **`analyze_dependencies`**: Dependency analysis with vulnerability detection.
- **`find_unused_exports`**: Find unused exports with confidence scoring.

---

## 📊 Output Formats (v3.2.0)

All code analysis tools now support **structured output** with the following formats:

| Format | Description | Use Case |
|--------|-------------|----------|
| `json` | Pure JSON, machine-readable | CI/CD integration, automation |
| `markdown` | Human-readable with tables | Code review, documentation |
| `summary` | Brief statistics only | Quick health checks |
| `legacy` | Original raw CLI output | Backward compatibility |

**Example: Structured Output**
```json
{
  "metadata": {
    "tool": "check_types",
    "version": "3.2.0",
    "timestamp": "2026-01-28T10:00:00.000Z"
  },
  "summary": {
    "total_issues": 5,
    "by_severity": { "critical": 0, "high": 5, "medium": 0, "low": 0, "info": 0 },
    "trend": { "previous_total": 7, "change": -2, "direction": "improved" }
  },
  "issues": [...]
}
```

**Trend Analysis**: Repeated analysis on the same path shows improvement/degradation trends.

---

## 💡 Usage Examples

**Code Review & Refactoring**
> "Analyze the entire codebase and provide a security-focused code review."
> *(Triggers `code_review`)*

**Feature Implementation**
> "Read `src/index.ts`, add a new logging feature, and write the updated code."
> *(Triggers `fs_read_file` -> `fs_write_file`)*

**Research & Learning**
> "Fetch https://example.com/docs/api and explain how to use the authentication endpoint."
> *(Triggers `fetch_url`)*

**Workflow Automation**
> "I finished the login feature. Generate a commit message and create a PR."
> *(Triggers `git_commit_helper` -> `gh_create_pr`)*

**Context Management**
> "Remember that we use Tabs instead of Spaces for this project."
> *(Triggers `manage_memory`)*

---

## 🔧 Troubleshooting

- **Ollama Error**: Ensure Ollama is running (`ollama serve`).
- **Gemini Auth**: Run `gemini auth login` in your terminal first.
- **Build Errors**: Make sure to run `npm run build` after any code changes.

---

## License
MIT
