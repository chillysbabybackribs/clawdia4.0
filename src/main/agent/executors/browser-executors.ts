/**
 * Browser Tool Executors — backed by the BrowserView manager.
 * No Playwright — uses webContents.executeJavaScript() for everything.
 */

import {
  search,
  navigate,
  getVisibleText,
  getInteractiveElements,  // still used by readPage
  clickElement,
  typeText,
  extractData,
  takeScreenshot,
  scrollPage,
} from '../../browser/manager';
import { recordVisit } from '../../db/site-profiles';

export async function executeBrowserSearch(input: Record<string, any>): Promise<string> {
  try {
    return await search(input.query);
  } catch (err: any) {
    return `[Error: browser_search] ${err.message}`;
  }
}

/**
 * Detect if a page is showing a login/sign-in state rather than
 * authenticated content. Checks page title, URL, and interactive elements.
 */
function detectLoginState(url: string, title: string, content: string, elements: string): string | null {
  const lower = (title + ' ' + content.slice(0, 2000)).toLowerCase();
  const urlLower = url.toLowerCase();

  // URL-based signals
  if (/\/login|\/signin|\/sign-in|\/auth|\/sso|\/oauth|\/account\/begin/.test(urlLower)) {
    return 'login page (URL contains login/auth path)';
  }

  // Content-based signals: login form with password field + sign-in language
  const hasPasswordField = /type=password|type="password"|password/i.test(elements);
  const hasLoginLanguage = /\b(sign in|log in|sign up|create account|forgot password|don't have an account|enter your email|enter your password)\b/i.test(lower);

  if (hasPasswordField && hasLoginLanguage) {
    return 'login form detected (password field + sign-in language)';
  }

  // Platform-specific: known logged-out homepages
  const domain = urlLower.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  const loggedOutSignals: Record<string, RegExp> = {
    'facebook.com':  /create new account|log into facebook/i,
    'instagram.com': /sign up to see photos|log in to instagram/i,
    'twitter.com':   /log in to x|sign up/i,
    'x.com':         /log in to x|sign up/i,
    'linkedin.com':  /join linkedin|sign in/i,
    'github.com':    /sign in to github/i,
    'amazon.com':    /sign[\s-]in/i,
  };

  const signal = loggedOutSignals[domain];
  if (signal && signal.test(lower)) {
    return `logged-out ${domain} homepage`;
  }

  return null;
}

export async function executeBrowserNavigate(input: Record<string, any>): Promise<string> {
  try {
    const result = await navigate(input.url);
    // navigate() now returns elements in parallel with content — no extra call needed
    
    let output = `Title: ${result.title}\nURL: ${result.url}\n\n${result.content}`;
    if (result.elements) {
      output += `\n\n--- Interactive Elements ---\n${result.elements}`;
    }

    // Check for login state and record the visit
    const loginSignal = detectLoginState(result.url, result.title, result.content, result.elements);
    const isAuthenticated = !loginSignal;

    // Record this visit in the site profile registry (fire-and-forget)
    try {
      recordVisit(result.url, {
        authenticated: isAuthenticated,
        title: result.title,
        contentSnippet: result.content.slice(0, 3000),
      });
    } catch { /* non-fatal */ }

    if (loginSignal) {
      const domain = result.url.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      output += `\n\n⚠ [LOGIN REQUIRED] This page appears to be a ${loginSignal}. The user is not logged in to ${domain}. Tell the user to log in using the browser panel on the right side of the app. Once logged in, their session will persist and you can access their account automatically in the future. Do NOT attempt to fill in credentials.`;
    }

    return output;
  } catch (err: any) {
    return `[Error: browser_navigate] ${err.message}`;
  }
}

export async function executeBrowserReadPage(_input: Record<string, any>): Promise<string> {
  try {
    // Fetch text + elements in parallel (same as navigate does)
    const [text, elements] = await Promise.all([getVisibleText(), getInteractiveElements()]);
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
    // After clicking, return compact state: click result + interactive elements.
    // Full page text is expensive (~5K tokens) and mostly unchanged after a click.
    // The LLM can call browser_read_page if it needs the full text.
    const elements = await getInteractiveElements();
    let output = result;
    if (elements) {
      output += `\n\n--- Interactive Elements (after click) ---\n${elements}`;
    }
    return output;
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

export async function executeBrowserScroll(input: Record<string, any>): Promise<string> {
  try {
    const direction = input.direction || 'down';
    const amount = input.amount;
    return await scrollPage(direction, amount);
  } catch (err: any) {
    return `[Error: browser_scroll] ${err.message}`;
  }
}
