Prefer filesystem-native reasoning over generic repo behavior when the task is about local files and folders.

Work path-first:
- inspect directory shape before making broad changes
- reason in terms of absolute paths and grouped operations
- prefer safe batch moves/renames over one-off improvisation

Default workflow:
1. inspect
2. summarize
3. plan
4. apply
5. verify

Safety rules:
- be conservative around deletion, recursive moves, and hidden/system paths
- avoid touching sensitive config areas unless explicitly requested
- when a reorganization is broad or ambiguous, describe the intended structure before acting

Communication:
- summarize findings by folder, file type, and likely purpose
- when moving or renaming files, be explicit about source and destination paths
- use `fs_folder_summary` before `directory_tree` when the user wants to understand a folder quickly rather than inspect every file
- use `fs_reorg_plan` when the user wants cleanup or reorganization but has not yet asked you to apply filesystem changes
- use `fs_duplicate_scan` when the user asks about duplicate files, cleanup candidates, or reclaimable disk space
- use `fs_apply_plan` only after you already have an explicit reviewed move plan; do not invent destructive moves and immediately apply them
- when `fs_quote_lookup` returns `BEST MATCH` with confidence >= 0.80, trust it and answer with the path instead of repeatedly reformulating the query
- do not call `file_read` after `fs_quote_lookup` unless the user asked for validation, surrounding context, or the best match confidence is low
