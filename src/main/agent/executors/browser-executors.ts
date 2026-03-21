/**
 * Browser Tool Executors — backed by the BrowserView manager.
 * Uses BrowserView/webContents plus the Electron debugger and native input helpers.
 */

import {
  search,
  navigate,
  getVisibleText,
  getInteractiveElements,  // still used by readPage
  getCurrentUrl,
  clickElement,
  typeText,
  extractData,
  extractListings,
  extractProductDetails,
  extractReviewsSummary,
  takeScreenshot,
  scrollPage,
  focusField,
  detectForm,
  fillField,
  runHarness,
  registerHarness,
  getHarnessContextForUrl,
  evaluateScript,
  getDomSnapshot,
  getPageState,
  watchNetwork,
  waitForBrowser,
  executeBrowserBatch as runBrowserBatch,
  compareProducts,
  type BrowserTarget,
} from '../../browser/manager';
import { recordVisit, getSiteProfile, extractDomain } from '../../db/site-profiles';

function getBrowserTarget(input: Record<string, any>): BrowserTarget | undefined {
  const runId = typeof input.__runId === 'string' ? input.__runId : undefined;
  const tabId = typeof input.tabId === 'string' ? input.tabId : undefined;
  const frameId = typeof input.frame_id === 'string' ? input.frame_id : undefined;
  if (!runId && !tabId && !frameId) return undefined;
  return { runId, tabId, frameId };
}

export async function executeBrowserSearch(input: Record<string, any>): Promise<string> {
  try {
    return await search(input.query, getBrowserTarget(input));
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
    const result = await navigate(input.url, getBrowserTarget(input));
    // navigate() now returns elements in parallel with content — no extra call needed
    
    let output = `Title: ${result.title}\nURL: ${result.url}\n\n${result.content}`;
    if (result.elements) {
      output += `\n\n--- Interactive Elements ---\n${result.elements}`;
    }

    // Skip login heuristic if the site is already known-authenticated in the profile DB.
    // This prevents false positives on pages that have login language but are actually
    // inside an authenticated session (e.g., account settings pages).
    const domain = extractDomain(result.url);
    const knownProfile = getSiteProfile(domain);
    const skipHeuristic = knownProfile?.authStatus === 'authenticated';

    const loginSignal = skipHeuristic
      ? null
      : detectLoginState(result.url, result.title, result.content, result.elements);
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
      output += `\n\n⚠ [LOGIN REQUIRED] This page appears to be a ${loginSignal}. The user is not logged in to ${domain}. Tell the user to log in using the browser panel on the right side of the app. Once logged in, their session will persist and you can access their account automatically in the future. Do NOT attempt to fill in credentials.`;
    }

    const harnessContext = getHarnessContextForUrl(result.url);
    if (harnessContext) {
      output += `\n\n${harnessContext}`;
    }

    return output;
  } catch (err: any) {
    return `[Error: browser_navigate] ${err.message}`;
  }
}

export async function executeBrowserReadPage(_input: Record<string, any>): Promise<string> {
  try {
    // Fetch text + elements in parallel (same as navigate does)
    const target = getBrowserTarget(_input);
    const [text, elements] = await Promise.all([getVisibleText(target), getInteractiveElements(target)]);
    let output = text;
    if (elements) {
      output += `\n\n--- Interactive Elements ---\n${elements}`;
    }
    const harnessContext = getHarnessContextForUrl(getCurrentUrl(target));
    if (harnessContext) {
      output += `\n\n${harnessContext}`;
    }
    return output;
  } catch (err: any) {
    return `[Error: browser_read_page] ${err.message}`;
  }
}

export async function executeBrowserClick(input: Record<string, any>): Promise<string> {
  try {
    const target = getBrowserTarget(input);
    const result = await clickElement(input.target, target);
    // After clicking, return compact state: click result + interactive elements.
    // Full page text is expensive (~5K tokens) and mostly unchanged after a click.
    // The LLM can call browser_read_page if it needs the full text.
    const elements = await getInteractiveElements(target);
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
    const target = getBrowserTarget(input);
    if (input.selector) {
      return await fillField(input.selector, input.text, target);
    }
    return await typeText(input.text, input.selector, target);
  } catch (err: any) {
    return `[Error: browser_type] ${err.message}`;
  }
}

export async function executeBrowserExtract(input: Record<string, any>): Promise<string> {
  try {
    return await extractData(input.instruction, getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_extract] ${err.message}`;
  }
}

export async function executeBrowserExtractListings(input: Record<string, any>): Promise<string> {
  try {
    return JSON.stringify(await extractListings(getBrowserTarget(input)), null, 2);
  } catch (err: any) {
    return `[Error: browser_extract_listings] ${err.message}`;
  }
}

export async function executeBrowserExtractProductDetails(input: Record<string, any>): Promise<string> {
  try {
    return JSON.stringify(await extractProductDetails(getBrowserTarget(input)), null, 2);
  } catch (err: any) {
    return `[Error: browser_extract_product_details] ${err.message}`;
  }
}

export async function executeBrowserExtractReviewsSummary(input: Record<string, any>): Promise<string> {
  try {
    return JSON.stringify(await extractReviewsSummary(getBrowserTarget(input)), null, 2);
  } catch (err: any) {
    return `[Error: browser_extract_reviews_summary] ${err.message}`;
  }
}

// Special prefix the dispatcher detects to build an image tool_result block.
export const SCREENSHOT_PREFIX = '__SCREENSHOT__:';

export async function executeBrowserScreenshot(_input: Record<string, any>): Promise<string> {
  try {
    const { base64, width, height, sizeKb } = await takeScreenshot(getBrowserTarget(_input));
    return `${SCREENSHOT_PREFIX}${JSON.stringify({ base64, width, height, sizeKb })}`;
  } catch (err: any) {
    if (typeof err?.message === 'string') {
      const idx = err.message.indexOf(SCREENSHOT_PREFIX);
      if (idx >= 0) {
        return err.message.slice(idx);
      }
    }
    return `[Error: browser_screenshot] ${err.message}`;
  }
}

export async function executeBrowserScroll(input: Record<string, any>): Promise<string> {
  try {
    const direction = input.direction || 'down';
    const amount = input.amount;
    return await scrollPage(direction, amount, getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_scroll] ${err.message}`;
  }
}

// ── Form-aware tools ──

export async function executeBrowserFocusField(input: Record<string, any>): Promise<string> {
  try {
    return await focusField(input.selector, getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_focus_field] ${err.message}`;
  }
}

export async function executeBrowserDetectForm(input: Record<string, any>): Promise<string> {
  try {
    return await detectForm(input.instruction || '', getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_detect_form] ${err.message}`;
  }
}

// ── Native-input form filling + Site harness tools ──

export async function executeBrowserFillField(input: Record<string, any>): Promise<string> {
  try {
    return await fillField(input.selector, input.text, getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_fill_field] ${err.message}`;
  }
}

export async function executeBrowserRunHarness(input: Record<string, any>): Promise<string> {
  try {
    const fieldValues = input.fields || {};
    return await runHarness(input.domain, input.action, fieldValues, input.submit === true, getBrowserTarget(input));
  } catch (err: any) {
    return `[Error: browser_run_harness] ${err.message}`;
  }
}

export async function executeBrowserRegisterHarness(input: Record<string, any>): Promise<string> {
  try {
    return await registerHarness(JSON.stringify(input.harness));
  } catch (err: any) {
    return `[Error: browser_register_harness] ${err.message}`;
  }
}

export async function executeBrowserEval(input: Record<string, any>): Promise<string> {
  try {
    const result = await evaluateScript(input.expression, {
      timeoutMs: input.timeout_ms,
      awaitPromise: input.await_promise,
      maxResultChars: input.max_result_chars,
    }, getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_eval] ${err.message}`;
  }
}

export async function executeBrowserDomSnapshot(input: Record<string, any>): Promise<string> {
  try {
    const result = await getDomSnapshot(getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_dom_snapshot] ${err.message}`;
  }
}

export async function executeBrowserPageState(input: Record<string, any>): Promise<string> {
  try {
    const result = await getPageState(getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_page_state] ${err.message}`;
  }
}

export async function executeBrowserNetworkWatch(input: Record<string, any>): Promise<string> {
  try {
    const action = input.action || 'read';
    const result = await watchNetwork(action, { limit: input.limit }, getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_network_watch] ${err.message}`;
  }
}

export async function executeBrowserWait(input: Record<string, any>): Promise<string> {
  try {
    const kind = input.kind || 'ready';
    const result = await waitForBrowser(kind, {
      selector: input.selector,
      text: input.text,
      url: input.url,
      match: input.match,
      timeoutMs: input.timeout_ms,
      settleMs: input.settle_ms,
    }, getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_wait] ${err.message}`;
  }
}

export async function executeBrowserBatch(input: Record<string, any>): Promise<string> {
  try {
    const result = await runBrowserBatch(Array.isArray(input.steps) ? input.steps : [], getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_batch] ${err.message}`;
  }
}

export async function executeBrowserCompareProducts(input: Record<string, any>): Promise<string> {
  try {
    const urls = Array.isArray(input.urls) ? input.urls.filter((entry: any) => typeof entry === 'string') : [];
    const result = await compareProducts(urls, getBrowserTarget(input));
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return `[Error: browser_compare_products] ${err.message}`;
  }
}

// ── Tab management tools (for agent swarm parallelism) ──
import { createTab, switchTab, closeTab, getTabList } from '../../browser/manager';

export async function executeBrowserTabNew(input: Record<string, any>): Promise<string> {
  try {
    const id = createTab(input.url);
    return `Tab created: ${id}${input.url ? ` — navigating to ${input.url}` : ''}`;
  } catch (err: any) {
    return `[Error: browser_tab_new] ${err.message}`;
  }
}

export async function executeBrowserTabSwitch(input: Record<string, any>): Promise<string> {
  try {
    switchTab(input.id);
    return `Switched to tab ${input.id}`;
  } catch (err: any) {
    return `[Error: browser_tab_switch] ${err.message}`;
  }
}

export async function executeBrowserTabClose(input: Record<string, any>): Promise<string> {
  try {
    closeTab(input.id);
    return `Closed tab ${input.id}`;
  } catch (err: any) {
    return `[Error: browser_tab_close] ${err.message}`;
  }
}

export async function executeBrowserTabList(_input: Record<string, any>): Promise<string> {
  try {
    const tabs = getTabList();
    if (!tabs.length) return 'No open tabs.';
    return tabs.map(t =>
      `[${t.isActive ? 'ACTIVE' : '      '}] id=${t.id}  ${t.title || 'Loading...'}  ${t.url}`
    ).join('\n');
  } catch (err: any) {
    return `[Error: browser_tab_list] ${err.message}`;
  }
}
