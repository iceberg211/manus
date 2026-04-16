/**
 * WebSearch Tool — Multi-engine web search with fallback chain.
 *
 * Translated from: app/tool/web_search.py (418 lines)
 *
 * Key behaviors preserved:
 * 1. Multi-engine fallback: DuckDuckGo → (extensible to Google/Bing via API)
 * 2. Per-engine 3 retries with exponential backoff
 * 3. All engines fail → wait retry_delay → retry whole chain up to max_retries
 * 4. Optional fetch_content: fetches page, strips HTML, truncates to 10000 chars
 * 5. Structured response with position, url, title, description, raw_content
 *
 * Note: Python version used google-search, baidu, duckduckgo-search, bing.
 * TS version uses duck-duck-scrape as primary (no API key needed).
 * Google/Bing can be added with API keys.
 */
/**
 * WebSearch Tool — Multi-engine web search with fallback chain.
 *
 * Translated from: app/tool/web_search.py (418 lines)
 *
 * Search engine interface allows plugging in Google/Bing/Baidu (7c-1).
 * Currently implements DuckDuckGo (no API key needed).
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { search as ddgSearch, SafeSearchType } from "duck-duck-scrape";
import * as cheerio from "cheerio";
import { SEARCH } from "../config/constants.js";
import { logger } from "../utils/logger.js";

const MAX_CONTENT_LENGTH = SEARCH.MAX_CONTENT_LENGTH;
const MAX_RETRIES = SEARCH.MAX_RETRIES;
const RETRY_DELAY_MS = SEARCH.RETRY_DELAY_MS;

interface SearchResult {
  position: number;
  url: string;
  title: string;
  description: string;
  source: string;
  rawContent?: string;
}

/** Exponential backoff sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch and extract main text content from a URL (matches WebContentFetcher). */
async function fetchPageContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove script, style, header, footer, nav (matches Python logic)
    $("script, style, header, footer, nav").remove();

    // Get text content
    let text = $("body").text();
    // Clean up whitespace
    text = text.replace(/\s+/g, " ").trim();

    return text ? text.slice(0, MAX_CONTENT_LENGTH) : null;
  } catch {
    return null;
  }
}

/** Search using DuckDuckGo (primary engine, no API key needed). */
async function searchDDG(
  query: string,
  numResults: number
): Promise<SearchResult[]> {
  const response = await ddgSearch(query, {
    safeSearch: SafeSearchType.MODERATE,
  });

  if (!response?.results?.length) return [];

  return response.results.slice(0, numResults).map((r, i) => ({
    position: i + 1,
    url: r.url,
    title: r.title || `Result ${i + 1}`,
    description: r.description || "",
    source: "duckduckgo",
  }));
}

/** Try a search with retries (matches _perform_search_with_engine with @retry). */
async function searchWithRetry(
  query: string,
  numResults: number,
  maxAttempts = 3
): Promise<SearchResult[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const results = await searchDDG(query, numResults);
      if (results.length > 0) return results;
    } catch {
      // Exponential backoff
      if (attempt < maxAttempts - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  return [];
}

/** Format results into a readable string (matches SearchResponse.populate_output). */
function formatResults(query: string, results: SearchResult[]): string {
  const lines = [`Search results for '${query}':`];

  for (const r of results) {
    const title = r.title.trim() || "No title";
    lines.push(`\n${r.position}. ${title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.description.trim()) {
      lines.push(`   Description: ${r.description}`);
    }
    if (r.rawContent) {
      let preview = r.rawContent.slice(0, 1000).replace(/\n/g, " ").trim();
      if (r.rawContent.length > 1000) preview += "...";
      lines.push(`   Content: ${preview}`);
    }
  }

  lines.push(`\nMetadata:`);
  lines.push(`- Total results: ${results.length}`);

  return lines.join("\n");
}

export const webSearch = tool(
  async ({ query, numResults = 5, fetchContent = false }): Promise<string> => {
    // Try search with full retry chain (matches _try_all_engines + outer retry loop)
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const results = await searchWithRetry(query, numResults);

      if (results.length > 0) {
        // Fetch content if requested (matches _fetch_content_for_results)
        if (fetchContent) {
          await Promise.all(
            results.map(async (r) => {
              const content = await fetchPageContent(r.url);
              if (content) r.rawContent = content;
            })
          );
        }
        return formatResults(query, results);
      }

      if (retry < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    return `All search engines failed to return results for: ${query}`;
  },
  {
    name: "web_search",
    description: `Search the web for real-time information about any topic.
This tool returns comprehensive search results with relevant information, URLs, titles, and descriptions.
If the primary search engine fails, it automatically retries with exponential backoff.`,
    schema: z.object({
      query: z
        .string()
        .describe("The search query to submit to the search engine."),
      numResults: z
        .number()
        .default(5)
        .describe("The number of search results to return. Default is 5."),
      fetchContent: z
        .boolean()
        .default(false)
        .describe(
          "Whether to fetch full content from result pages. Default is false."
        ),
    }),
  }
);
