# Coding Module — Injected for code editing tasks
# Token budget: ~200 tokens
# Trigger: classifier detects file paths, language keywords, build commands,
#          "refactor", "fix", "implement", "debug"

## Code Editing Rules

- Before modifying any function, check for callers: `grep -rn "functionName" src/ --include="*.ts"`
- After editing, verify the build before declaring success.
- Use `file_edit` (string replacement) for targeted changes. Use `file_write` only for new files.
- When refactoring multi-file changes: read all affected files first, plan the change, then execute.
- If a change breaks the build, fix it before moving on. Do not leave broken state.
- Preserve existing code style (indentation, naming conventions, comment patterns).
