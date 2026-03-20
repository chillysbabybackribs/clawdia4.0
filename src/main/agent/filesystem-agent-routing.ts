export function isFilesystemQuoteLookupTask(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;

  return /(?:find|locate|identify|show)\b.*\b(?:file|source|document|pdf)\b/i.test(trimmed)
    && /(?:contains?|has|includes?|mentions?|says?|talks about|quote|phrase|sentence|line|string|something like)/i.test(trimmed);
}
