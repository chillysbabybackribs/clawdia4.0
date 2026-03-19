/**
 * Browser Tool Executors — Stubs for now. Will be backed by Playwright later.
 * Returns placeholder messages so the tool loop works without a browser.
 */

export async function executeBrowserSearch(input: Record<string, any>): Promise<string> {
  return `[browser_search] Search not yet connected. Query: "${input.query}". Wire Playwright or a search API to enable.`;
}

export async function executeBrowserNavigate(input: Record<string, any>): Promise<string> {
  return `[browser_navigate] Browser not yet connected. URL: ${input.url}. Wire Playwright to enable.`;
}

export async function executeBrowserReadPage(_input: Record<string, any>): Promise<string> {
  return `[browser_read_page] Browser not yet connected.`;
}

export async function executeBrowserClick(input: Record<string, any>): Promise<string> {
  return `[browser_click] Browser not yet connected. Target: ${input.target}`;
}

export async function executeBrowserType(input: Record<string, any>): Promise<string> {
  return `[browser_type] Browser not yet connected. Text: ${input.text}`;
}

export async function executeBrowserExtract(input: Record<string, any>): Promise<string> {
  return `[browser_extract] Browser not yet connected. Instruction: ${input.instruction}`;
}

export async function executeBrowserScreenshot(_input: Record<string, any>): Promise<string> {
  return `[browser_screenshot] Browser not yet connected.`;
}
