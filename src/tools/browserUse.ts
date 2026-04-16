/**
 * BrowserUse Tool — Browser automation with DOM element indexing.
 *
 * Translated from: app/tool/browser_use_tool.py (568 lines)
 *
 * P0-2: Rewritten to use npm `browser-use` (v0.6.0+) for DOM indexing.
 * This provides the same DomService as the Python version:
 * - Element indexing: every interactive element gets a numeric index
 * - get_dom_element_by_index(): retrieve element by its index
 * - clickable_elements_to_string(): formatted list of interactive elements
 * - _click_element_node() / _input_text_element_node(): operate by index
 *
 * Improvement T-1: extract_content returns page text only (no hidden LLM call).
 * The agent (think node) decides whether to further analyze the content.
 *
 * Key behaviors preserved from Python:
 * 1. 16 browser actions dispatched by `action` parameter
 * 2. Singleton browser session (lazy init on first call)
 * 3. Mutex lock — one browser operation at a time
 * 4. get_current_state() returns screenshot + URL + tabs + interactive elements
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DomService, DOMState, BrowserSession } from "browser-use";
import { BROWSER } from "../config/constants.js";

// Simple mutex
class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise((r) => { this.queue.push(r); });
  }
  release(): void {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.locked = false;
  }
}

/**
 * BrowserManager — Singleton managing browser-use session lifecycle.
 */
class BrowserManager {
  private session: BrowserSession | null = null;
  private mutex = new Mutex();
  private domState: DOMState | null = null;

  private async ensureSession(): Promise<BrowserSession> {
    if (!this.session) {
      this.session = new BrowserSession({
        profile: {
          headless: false,
          viewport: { width: BROWSER.VIEWPORT_WIDTH, height: BROWSER.VIEWPORT_HEIGHT },
        },
      });
      await this.session.start();
    }
    return this.session;
  }

  /** Get current page, throw if null. */
  private async getPage(): Promise<any> {
    const session = await this.ensureSession();
    const page = await session.get_current_page();
    if (!page) throw new Error("No active page in browser session");
    return page;
  }

  /** Refresh DOM state — get clickable elements with index numbers. */
  private async refreshDom(): Promise<DOMState> {
    const page = await this.getPage();
    const domService = new DomService(page);
    this.domState = await domService.get_clickable_elements(true);
    return this.domState;
  }

  /** Execute a browser action with mutex lock. */
  async execute(action: string, params: Record<string, any>): Promise<string> {
    await this.mutex.acquire();
    try {
      return await this._exec(action, params);
    } finally {
      this.mutex.release();
    }
  }

  private async _exec(action: string, params: Record<string, any>): Promise<string> {
    const session = await this.ensureSession();

    switch (action) {
      // ---- Navigation ----
      case "go_to_url": {
        if (!params.url) return "Error: URL is required for 'go_to_url' action";
        const page = await this.getPage();
        await page.goto(params.url);
        await page.waitForLoadState();
        await this.refreshDom();
        return `Navigated to ${params.url}`;
      }

      case "go_back": {
        const page = await this.getPage();
        await page.goBack();
        await this.refreshDom();
        return "Navigated back";
      }

      case "web_search": {
        if (!params.query) return "Error: Query is required for 'web_search' action";
        const page = await this.getPage();
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`;
        await page.goto(url);
        await page.waitForLoadState();
        await this.refreshDom();
        return `Searched for: ${params.query}`;
      }

      // ---- Element Interaction (via DOM index) ----
      case "click_element": {
        if (params.index === undefined) return "Error: Index is required for 'click_element' action";
        try {
          const element = await session.get_dom_element_by_index(params.index);
          const downloadPath = await session._click_element_node(element);
          await this.refreshDom();
          let msg = `Clicked element at index ${params.index}`;
          if (downloadPath) msg += ` — Downloaded file to ${downloadPath}`;
          return msg;
        } catch (e: any) {
          return `Error clicking element ${params.index}: ${e.message}`;
        }
      }

      case "input_text": {
        if (params.index === undefined || !params.text)
          return "Error: Index and text are required for 'input_text' action";
        try {
          const element = await session.get_dom_element_by_index(params.index);
          await session._input_text_element_node(element, params.text);
          await this.refreshDom();
          return `Input '${params.text}' into element at index ${params.index}`;
        } catch (e: any) {
          return `Error inputting text: ${e.message}`;
        }
      }

      case "send_keys": {
        if (!params.keys) return "Error: Keys are required for 'send_keys' action";
        const page = await this.getPage();
        await page.keyboard.press(params.keys);
        return `Sent keys: ${params.keys}`;
      }

      // ---- Scrolling ----
      case "scroll_down": {
        const amount = params.scrollAmount ?? BROWSER.VIEWPORT_HEIGHT;
        const page = await this.getPage();
        await page.evaluate(`window.scrollBy(0, ${amount})`);
        await this.refreshDom();
        return `Scrolled down by ${amount} pixels`;
      }

      case "scroll_up": {
        const amount = params.scrollAmount ?? BROWSER.VIEWPORT_HEIGHT;
        const page = await this.getPage();
        await page.evaluate(`window.scrollBy(0, -${amount})`);
        await this.refreshDom();
        return `Scrolled up by ${amount} pixels`;
      }

      case "scroll_to_text": {
        if (!params.text) return "Error: Text is required for 'scroll_to_text' action";
        try {
          const page = await this.getPage();
          const loc = page.getByText(params.text, { exact: false });
          await loc.scrollIntoViewIfNeeded();
          await this.refreshDom();
          return `Scrolled to text: '${params.text}'`;
        } catch (e: any) {
          return `Error scrolling to text: ${e.message}`;
        }
      }

      // ---- Dropdown ----
      case "get_dropdown_options": {
        if (params.index === undefined) return "Error: Index is required";
        try {
          const element = await session.get_dom_element_by_index(params.index);
          const page = await this.getPage();
          const options = await page.evaluate((xpath: string) => {
            const select = document.evaluate(xpath, document, null,
              XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLSelectElement;
            if (!select) return null;
            return Array.from(select.options).map(opt => ({ text: opt.text, value: opt.value, index: opt.index }));
          }, element.xpath);
          return `Dropdown options: ${JSON.stringify(options)}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "select_dropdown_option": {
        if (params.index === undefined || !params.text) return "Error: Index and text required";
        try {
          const element = await session.get_dom_element_by_index(params.index);
          const page = await this.getPage();
          await page.selectOption(element.xpath, { label: params.text });
          return `Selected '${params.text}' from dropdown at index ${params.index}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      // ---- Content Extraction ----
      // T-1: Returns page text only. No hidden LLM call.
      // The agent's think node decides whether to further analyze.
      case "extract_content": {
        if (!params.goal) return "Error: Goal is required for 'extract_content' action";
        try {
          const page = await this.getPage();
          const content = await page.evaluate(() => document.body.innerText);
          const truncated = content.slice(0, BROWSER.MAX_EXTRACT_LENGTH);
          return `Page content (goal: ${params.goal}):\n${truncated}${content.length > BROWSER.MAX_EXTRACT_LENGTH ? "\n... (truncated)" : ""}`;
        } catch (e: any) {
          return `Error extracting content: ${e.message}`;
        }
      }

      // ---- Tab Management ----
      case "switch_tab": {
        if (params.tabId === undefined) return "Error: Tab ID required";
        try {
          await session.switch_to_tab(params.tabId);
          await this.refreshDom();
          return `Switched to tab ${params.tabId}`;
        } catch (e: any) {
          return `Error switching tab: ${e.message}`;
        }
      }

      case "open_tab": {
        if (!params.url) return "Error: URL required for 'open_tab'";
        await session.create_new_tab(params.url);
        await this.refreshDom();
        return `Opened new tab with ${params.url}`;
      }

      case "close_tab": {
        const page = await this.getPage();
        await page.close();
        return "Closed current tab";
      }

      // ---- Utility ----
      case "wait": {
        const seconds = params.seconds ?? 3;
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return `Waited for ${seconds} seconds`;
      }

      default:
        return `Error: Unknown action: ${action}`;
    }
  }

  /** Get current browser state for context injection. */
  async getState(): Promise<{
    screenshot: string;
    url: string;
    title: string;
    interactiveElements: string;
    tabCount: number;
  } | null> {
    if (!this.session) return null;
    try {
      const page = await this.getPage();
      const screenshot = await page.screenshot({
        type: "jpeg",
        fullPage: true,
        quality: BROWSER.SCREENSHOT_QUALITY,
      });

      // Get interactive elements via DOM service
      const domState = this.domState ?? await this.refreshDom();
      const elements = domState.element_tree.clickable_elements_to_string();

      let tabCount = 1;
      try {
        const ctx = typeof page.context === "function" ? page.context() : null;
        const pages = ctx && typeof ctx.pages === "function" ? ctx.pages() : null;
        if (Array.isArray(pages) && pages.length > 0) tabCount = pages.length;
      } catch {
        // fall back to 1 if the underlying driver shape differs
      }

      return {
        screenshot: screenshot.toString("base64"),
        url: page.url(),
        title: await page.title(),
        interactiveElements: elements,
        tabCount,
      };
    } catch {
      return null;
    }
  }

  async cleanup(): Promise<void> {
    await this.mutex.acquire();
    try {
      if (this.session) {
        await this.session.stop().catch(() => {});
        this.session = null;
      }
      this.domState = null;
    } finally {
      this.mutex.release();
    }
  }
}

export const browserManager = new BrowserManager();

export const browserUse = tool(
  async ({
    action, url, index, text, scrollAmount, tabId, query, goal, keys, seconds,
  }): Promise<string> => {
    return browserManager.execute(action, {
      url,
      index: index === -1 ? undefined : index,
      text,
      scrollAmount: scrollAmount === -1 ? undefined : scrollAmount,
      tabId: tabId === -1 ? undefined : tabId,
      query,
      goal,
      keys,
      seconds: seconds === -1 ? undefined : seconds,
    });
  },
  {
    name: "browser_use",
    description: `Browser automation with indexed element interaction.
Elements on the page are automatically numbered — use the index to interact.
Key capabilities:
* Navigation: go_to_url, go_back, web_search
* Interaction: click_element(index), input_text(index, text), send_keys
* Scrolling: scroll_down, scroll_up, scroll_to_text
* Dropdowns: get_dropdown_options(index), select_dropdown_option(index, text)
* Content: extract_content(goal) — extracts page text for the given goal
* Tabs: switch_tab, open_tab, close_tab
* Utility: wait`,
    schema: z.object({
      action: z.enum([
        "go_to_url", "click_element", "input_text", "scroll_down", "scroll_up",
        "scroll_to_text", "send_keys", "get_dropdown_options", "select_dropdown_option",
        "go_back", "web_search", "wait", "extract_content", "switch_tab", "open_tab", "close_tab",
      ]).describe("The browser action to perform"),
      url: z.string().default("").describe("URL for go_to_url or open_tab"),
      index: z.number().default(-1).describe("Element index for click_element, input_text, dropdown actions"),
      text: z.string().default("").describe("Text for input_text, scroll_to_text, or select_dropdown_option"),
      scrollAmount: z.number().default(-1).describe("Pixels to scroll"),
      tabId: z.number().default(-1).describe("Tab ID for switch_tab"),
      query: z.string().default("").describe("Search query for web_search"),
      goal: z.string().default("").describe("Extraction goal for extract_content"),
      keys: z.string().default("").describe("Keys to send for send_keys"),
      seconds: z.number().default(-1).describe("Seconds to wait"),
    }),
  }
);
