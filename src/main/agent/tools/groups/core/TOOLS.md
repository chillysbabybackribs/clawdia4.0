# Tool Definitions — Core Group
# ═══════════════════════════════════
# These are the actual tool schemas sent to the Anthropic API.
# The `description` field is prompt engineering — it tells the model
# WHEN and HOW to use each tool.
#
# Design rule: Keep descriptions under 100 words each. Put behavioral
# rules in the group CONTEXT.md, not in individual tool descriptions.
# ═══════════════════════════════════


## shell_exec

name: shell_exec
description: |
  Execute a bash command in a persistent shell session. The shell retains
  cwd between calls. Returns stdout, stderr, and exit code. Use for:
  installing packages, running builds, launching apps, system queries,
  git operations, and any command-line task. Background GUI processes
  with & so the command returns. Set timeout for long-running commands.

input_schema:
  type: object
  properties:
    command:
      type: string
      description: The bash command to execute
    timeout:
      type: number
      description: Timeout in seconds (default 30, max 300)
  required: [command]


## file_read

name: file_read
description: |
  Read file contents. Returns the text content of the file. Use startLine
  and endLine for large files to read specific sections. Prefer grep via
  shell_exec when searching for specific patterns across many files.

input_schema:
  type: object
  properties:
    path:
      type: string
      description: Absolute path to the file
    startLine:
      type: number
      description: First line to read (1-indexed, inclusive)
    endLine:
      type: number
      description: Last line to read (1-indexed, inclusive)
  required: [path]


## file_write

name: file_write
description: |
  Create a new file or overwrite an existing file. Use for creating new
  files only. For modifying existing files, prefer file_edit which does
  targeted string replacement. Parent directories are created automatically.

input_schema:
  type: object
  properties:
    path:
      type: string
      description: Absolute path for the file
    content:
      type: string
      description: Complete file content
  required: [path, content]


## file_edit

name: file_edit
description: |
  Edit an existing file by replacing one exact string with another. The
  old_str must appear exactly once in the file. Read the file first to
  get the exact text to replace. Use for surgical changes to existing
  code — never for creating new files.

input_schema:
  type: object
  properties:
    path:
      type: string
      description: Absolute path to the file
    old_str:
      type: string
      description: Exact string to find (must appear once)
    new_str:
      type: string
      description: Replacement string (empty string to delete)
  required: [path, old_str, new_str]


## directory_tree

name: directory_tree
description: |
  List files and directories in a tree structure. Returns names, types,
  and nesting. Use depth to limit recursion for large directories.
  Ignores node_modules, .git, and hidden files by default.

input_schema:
  type: object
  properties:
    path:
      type: string
      description: Absolute path to the directory
    depth:
      type: number
      description: Maximum depth to recurse (default 3, max 10)
  required: [path]
