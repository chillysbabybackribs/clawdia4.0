const CLAUDE_CODE_READ_ONLY_COMMANDS = new Set(['/claude-code', '/claude']);
const CLAUDE_CODE_EDIT_COMMANDS = new Set(['/claude-code-edit', '/claude-edit']);

export function buildClaudeCodeDelegationPrompt(task: string, mode: 'read_only' | 'edit' = 'read_only'): string {
  const trimmed = task.trim();
  if (!trimmed) return '';

  if (mode === 'edit') {
    return [
      'Use Claude Code for this repository task.',
      'Mode: write-enabled',
      '',
      `Task: ${trimmed}`,
      '',
      'Execution requirements:',
      '- Use Claude Code in non-interactive print mode.',
      '- Run it with unrestricted permissions for this testing path.',
      '- Edit files only when the task explicitly requires changes.',
      '- Do NOT start dev servers, Vite, Electron, nodemon, watchers, or long-running processes unless the user explicitly asks for them.',
      '- Do not interrupt the user with approval requests unless the Claude invocation itself fails.',
      '- Verify any claimed code changes or results after Claude finishes.',
    ].join('\n');
  }

  return [
    'Use Claude Code for this repository task.',
    'Mode: read-only',
    '',
    `Task: ${trimmed}`,
    '',
    'Execution requirements:',
    '- Use Claude Code in non-interactive print mode.',
    '- Run it with unrestricted permissions for this testing path.',
    '- READ-ONLY ONLY: do not edit files, do not apply patches, and do not make commits.',
    '- Do NOT start dev servers, Vite, Electron, nodemon, test watchers, background jobs, or any long-running processes.',
    '- Keep the task to analysis, explanation, review, grep/read, or narrow code inspection.',
    '- Do not interrupt the user with approval requests unless the Claude invocation itself fails.',
    '- Verify and summarize findings after Claude finishes.',
  ].join('\n');
}

export function parseClaudeCodeSlashCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;

  const [command, ...rest] = trimmed.split(/\s+/);
  const lower = command.toLowerCase();
  if (CLAUDE_CODE_READ_ONLY_COMMANDS.has(lower)) {
    return buildClaudeCodeDelegationPrompt(rest.join(' ').trim(), 'read_only');
  }
  if (CLAUDE_CODE_EDIT_COMMANDS.has(lower)) {
    return buildClaudeCodeDelegationPrompt(rest.join(' ').trim(), 'edit');
  }

  return null;
}
