/**
 * Browser Tool Executors — backed by the BrowserView manager.
 * No Playwright — uses webContents.executeJavaScript() for everything.
 */

import {
  search,
  navigate,
  getVisibleText,
  getInteractiveElements,
  clickElement,
  typeText,
  extractData,
  takeScreenshot,
} from '../../browser/manager';

export async function executeBrowserSearch(input: Record<string, any>): Promise<string> {
  try {
    return await search(input.query);
  } catch (err: any) {
    return `[Error: browser_search] ${err.message}`;
  }
}

export async function executeBrowserNavigate(input: Record<string, any>): Promise<string> {
  try {
    const result = await navigate(input.url);
    const elements = await getInteractiveElements();
    
    let output = `Title: ${result.title}\nURL: ${result.url}\n\n${result.content}`;
    if (elements) {
      output += `\n\n--- Interactive Elements ---\n${elements}`;
    }
    return output;
  } catch (err: any) {
    return `[Error: browser_navigate] ${err.message}`;
  }
}

export async function executeBrowserReadPage(_input: Record<string, any>): Promise<string> {
  try {
    const text = await getVisibleText();
    const elements = await getInteractiveElements();
    let output = text;
    if (elements) {
      output += `\n\n--- Interactive Elements ---\n${elements}`;
    }
    return output;
  } catch (err: any) {
    return `[Error: browser_read_page] ${err.message}`;
  }
}

export async function executeBrowserClick(input: Record<string, any>): Promise<string> {
  try {
    const result = await clickElement(input.target);
    // After clicking, get updated page state
    const text = await getVisibleText();
    return `${result}\n\n--- Page after click ---\n${text.slice(0, 5000)}`;
  } catch (err: any) {
    return `[Error: browser_click] ${err.message}`;
  }
}

export async function executeBrowserType(input: Record<string, any>): Promise<string> {
  try {
    return await typeText(input.text, input.selector);
  } catch (err: any) {
    return `[Error: browser_type] ${err.message}`;
  }
}

export async function executeBrowserExtract(input: Record<string, any>): Promise<string> {
  try {
    return await extractData(input.instruction);
  } catch (err: any) {
    return `[Error: browser_extract] ${err.message}`;
  }
}

export async function executeBrowserScreenshot(_input: Record<string, any>): Promise<string> {
  try {
    return await takeScreenshot();
  } catch (err: any) {
    return `[Error: browser_screenshot] ${err.message}`;
  }
}
