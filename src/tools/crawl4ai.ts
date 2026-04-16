/**
 * Crawl4AI Tool — Web crawling with JS rendering via Playwright.
 *
 * Translated from: app/tool/crawl4ai.py (269 lines)
 *
 * Rewritten (7a-6): Now uses Playwright for JS rendering.
 * Python used crawl4ai.AsyncWebCrawler (Chromium-based), which can handle
 * SPAs, dynamic content, iframes, and overlays.
 *
 * TS approach:
 * - JS rendering: Playwright `page.goto()` → `page.content()` → cheerio extract
 * - Static fast path: fetch + cheerio (for simple HTML pages, skips browser overhead)
 * - Batch URL support preserved
 * - Word count / link / image stats preserved
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as cheerio from "cheerio";
import { chromium, type Browser } from "playwright";
import { CRAWL } from "../config/constants.js";
import { logger } from "../utils/logger.js";

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Singleton browser for Playwright-based crawling
let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

/** Crawl a URL with full JS rendering via Playwright. */
async function crawlWithPlaywright(
  url: string,
  timeout: number,
  wordCountThreshold: number
): Promise<CrawlResult> {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    const page = await context.newPage();

    try {
      await page.goto(url, {
        timeout: timeout * 1000,
        waitUntil: "domcontentloaded",
      });

      // Wait a bit for dynamic content
      await page.waitForTimeout(1000);

      const html = await page.content();
      const title = await page.title();
      const $ = cheerio.load(html);

      // Remove non-content elements (matches Python's excluded_tags)
      $("script, style, nav, header, footer, iframe, noscript").remove();
      // Remove overlay elements (matches Python's remove_overlay_elements)
      $("[class*='overlay'], [class*='modal'], [class*='popup']").remove();

      const text = $("body").text().replace(/\s+/g, " ").trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const linksCount = $("a[href]").length;
      const imagesCount = $("img").length;

      return {
        success: true,
        url,
        title,
        markdown: text,
        wordCount,
        linksCount,
        imagesCount,
      };
    } finally {
      await context.close();
    }
  } catch (e: any) {
    return {
      success: false,
      url,
      error: e.name === "TimeoutError" ? `Timeout after ${timeout}s` : e.message,
    };
  }
}

/** Fast path: fetch + cheerio for static pages (no JS rendering). */
async function crawlStatic(url: string, timeout: number): Promise<CrawlResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { success: false, url, error: `HTTP ${response.status}` };
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer, iframe, noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return {
      success: true,
      url,
      title: $("title").text().trim(),
      markdown: text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      linksCount: $("a[href]").length,
      imagesCount: $("img").length,
    };
  } catch (e: any) {
    return { success: false, url, error: e.message };
  }
}

interface CrawlResult {
  success: boolean;
  url: string;
  title?: string;
  markdown?: string;
  wordCount?: number;
  linksCount?: number;
  imagesCount?: number;
  error?: string;
}

export const crawl4ai = tool(
  async ({
    urls,
    timeout = CRAWL.TIMEOUT_SEC,
    wordCountThreshold = CRAWL.WORD_COUNT_THRESHOLD,
    useJsRendering = true,
  }): Promise<string> => {
    const validUrls = urls.filter(isValidUrl);
    if (validUrls.length === 0) return "Error: No valid URLs provided";

    const crawlFn = useJsRendering ? crawlWithPlaywright : crawlStatic;

    const results = await Promise.all(
      validUrls.map((url) => crawlFn(url, timeout, wordCountThreshold))
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const lines = [
      `Crawl Results Summary:`,
      `Total: ${validUrls.length} | Success: ${successful.length} | Failed: ${failed.length}`,
      `Mode: ${useJsRendering ? "JS rendering (Playwright)" : "Static (fetch+cheerio)"}`,
      "",
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.url}`);

      if (r.success) {
        if (r.title) lines.push(`   Title: ${r.title}`);
        const content = r.markdown ?? "";
        if ((r.wordCount ?? 0) >= wordCountThreshold) {
          lines.push(`   Content: ${content.slice(0, 2000)}${content.length > 2000 ? "..." : ""}`);
          lines.push(`   Stats: ${r.wordCount} words, ${r.linksCount} links, ${r.imagesCount} images`);
        } else {
          lines.push(`   Content too short (${r.wordCount} words, threshold: ${wordCountThreshold})`);
        }
      } else {
        lines.push(`   Error: ${r.error}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  },
  {
    name: "crawl4ai",
    description: `Web crawler that extracts clean content from web pages.
Supports JavaScript rendering for SPAs and dynamic content (via Playwright).
Set useJsRendering=false for faster static-only crawling.
Supports batch URLs with per-URL timeout.`,
    schema: z.object({
      urls: z.array(z.string()).min(1).describe("List of URLs to crawl."),
      timeout: z.number().default(CRAWL.TIMEOUT_SEC).describe("Timeout per URL in seconds."),
      wordCountThreshold: z.number().default(CRAWL.WORD_COUNT_THRESHOLD).describe("Min word count for content blocks."),
      useJsRendering: z.boolean().default(true).describe("Use Playwright for JS rendering. Set false for static-only (faster)."),
    }),
  }
);

/** Cleanup crawler browser. Call on process exit. */
export async function cleanupCrawler(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
