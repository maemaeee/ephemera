import { CheerioCrawler, type CheerioRoot, Configuration } from "crawlee";
import type { SearchQuery, Book, SearchResponse } from "@ephemera/shared";
import { getErrorMessage } from "@ephemera/shared";
import { logger } from "../utils/logger.js";
import { searchCacheManager } from "./search-cache.js";
import { appConfigService } from "./app-config.js";

interface InternalScrapeResult extends SearchResponse {
  isBlockedPage: boolean;
}

// Fallback domains for Libgen
const LIBGEN_FALLBACK_TLDS = [".co.in", ".li", ".is", ".rs", ".la", ".st", ".vg", ".gl"];

// Configure Crawlee to use in-memory storage globally
Configuration.getGlobalConfig().set("persistStorage", false);

// Extract 32-character hexadecimal MD5 hash from a URL or string
function extractMd5(str: string | undefined): string | null {
  if (!str) return null;
  const match = str.match(/(?:md5=|\/md5\/|\/main\/|book\.php\?md5=)([a-f0-9]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

// Convert size string (e.g. "435 KB", "2.5 MB", "1.2 GB") to bytes (integer)
function parseSize(sizeStr: string | undefined): number | undefined {
  if (!sizeStr) return undefined;
  const match = sizeStr.match(/([\d.]+)\s*([KMG]?B)/i);
  if (!match) return undefined;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "GB") return Math.round(val * 1024 * 1024 * 1024);
  if (unit === "MB") return Math.round(val * 1024 * 1024);
  if (unit === "KB") return Math.round(val * 1024);
  if (unit === "B") return Math.round(val);
  return undefined;
}

export class LibgenScraper {
  /**
   * Scrape a Libgen search URL and extract books
   */
  async scrapeUrl(url: string): Promise<InternalScrapeResult> {
    const crawlId = Math.random().toString(36).substring(7);
    logger.info(`[${crawlId}] [Libgen] Crawler starting for: ${url}`);

    let result: InternalScrapeResult | null = null;

    const crawler = new CheerioCrawler({
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 20,
      maxConcurrency: 1,
      useSessionPool: false,
      additionalMimeTypes: ["application/json"],
      preNavigationHooks: [
        async ({ request }) => {
          logger.info(`[${crawlId}] [Libgen] Sending HTTP request...`);
          request.headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            Connection: "keep-alive",
            "Upgrade-Insecure-Requests": "1",
          };
        },
      ],
      requestHandler: async ({ $, _request, _log }) => {
        logger.info(`[${crawlId}] [Libgen] HTTP response received, parsing HTML...`);

        // Check for anti-bot / challenge
        const pageText = $.text().toLowerCase();
        const isChallenge =
          pageText.includes("ddos-guard") ||
          pageText.includes("checking your browser") ||
          pageText.includes("attention required") ||
          pageText.includes("just a moment");

        if (isChallenge) {
          logger.warn(`[${crawlId}] [Libgen] Bot challenge detected`);
          result = {
            results: [],
            pagination: {
              page: 1,
              per_page: 50,
              has_next: false,
              has_previous: false,
              estimated_total_results: null,
            },
            isBlockedPage: true,
          };
          return;
        }

        const parseStart = Date.now();
        const books = LibgenScraper.parseBooks($);
        const pagination = LibgenScraper.parsePagination($, books.length);
        const parseDuration = Date.now() - parseStart;

        logger.info(
          `[${crawlId}] [Libgen] Parsed ${books.length} books in ${parseDuration}ms`,
        );

        result = {
          results: books,
          pagination,
          isBlockedPage: false,
        };
      },
      failedRequestHandler: async ({ request }, error) => {
        logger.warn(`[${crawlId}] [Libgen] Request ${request.url} failed:`, error.message);
        result = {
          results: [],
          pagination: {
            page: 1,
            per_page: 50,
            has_next: false,
            has_previous: false,
            estimated_total_results: null,
          },
          isBlockedPage: true,
        };
      },
    });

    try {
      const uniqueUrl = `${url}${url.includes("?") ? "&" : "?"}_crawl=${Date.now()}`;
      await crawler.run([uniqueUrl]);
    } catch (error: unknown) {
      logger.warn(`[${crawlId}] [Libgen] Crawler error:`, getErrorMessage(error));
    }

    return (
      result || {
        results: [],
        pagination: {
          page: 1,
          per_page: 50,
          has_next: false,
          has_previous: false,
          estimated_total_results: null,
        },
        isBlockedPage: false,
      }
    );
  }

  /**
   * Parse book results from Libgen HTML
   */
  public static parseBooks($: CheerioRoot): Book[] {
    const books: Book[] = [];
    const seenMd5s = new Set<string>();

    // Strategy 1: Modern Libgen Table (#tablelibgen or table.table-striped)
    const modernTable = $("#tablelibgen, table.table-striped, table.table").first();
    if (modernTable.length > 0) {
      // Discover column indexes from <th> headers
      const colMap: Record<string, number> = {};
      modernTable.find("thead th, tr:first-child th").each((idx, el) => {
        const text = $(el).text().trim().toLowerCase();
        if (text.includes("title")) colMap["title"] = idx;
        else if (text.includes("author")) colMap["author"] = idx;
        else if (text.includes("publisher")) colMap["publisher"] = idx;
        else if (text.includes("year")) colMap["year"] = idx;
        else if (text.includes("lang")) colMap["lang"] = idx;
        else if (text.includes("size")) colMap["size"] = idx;
        else if (text.includes("ext")) colMap["ext"] = idx;
      });

      const rows = modernTable.find("tbody tr, tr").toArray();
      for (const rowEl of rows) {
        const row = $(rowEl);
        if (row.find("th").length > 0) continue; // Skip header row

        const cells = row.find("td");
        if (cells.length < 4) continue;

        // Find MD5 from links in the row
        let md5: string | null = null;
        row.find("a").each((_, a) => {
          if (md5) return;
          const href = $(a).attr("href");
          md5 = extractMd5(href);
        });

        if (!md5 || seenMd5s.has(md5)) continue;

        // Title
        const titleIdx = colMap["title"] ?? 0;
        const titleCell = cells.eq(titleIdx);
        const titleLink = titleCell.find("a").first();
        const title = (titleLink.length > 0 ? titleLink.text() : titleCell.text()).trim();
        if (!title) continue;

        // Authors
        const authorIdx = colMap["author"] ?? 1;
        const authorText = cells.eq(authorIdx).text().trim();
        const authors = authorText
          ? authorText
              .split(/[,;&]/)
              .map((a) => a.trim())
              .filter(Boolean)
          : undefined;

        // Publisher
        const pubIdx = colMap["publisher"] ?? 2;
        const publisher = cells.eq(pubIdx).text().trim() || undefined;

        // Year
        const yearIdx = colMap["year"] ?? 3;
        const yearMatch = cells.eq(yearIdx).text().match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : undefined;

        // Language
        const langIdx = colMap["lang"] ?? 4;
        const language = cells.eq(langIdx).text().trim() || undefined;

        // Size
        const sizeIdx = colMap["size"] ?? 6;
        const size = parseSize(cells.eq(sizeIdx).text().trim());

        // Format
        const extIdx = colMap["ext"] ?? 7;
        const formatText = cells.eq(extIdx).text().trim().toUpperCase();
        const format = formatText || undefined;

        // Cover URL if available
        const img = row.find("img").first();
        const coverUrl = img.attr("src");

        seenMd5s.add(md5);
        books.push({
          md5,
          title,
          authors: authors && authors.length > 0 ? authors : undefined,
          publisher,
          language,
          format,
          size,
          year,
          coverUrl: coverUrl ? coverUrl : undefined,
          source: "libgen",
        });
      }
    }

    // Strategy 2: Classic Libgen Table (table.c) if no books found yet
    if (books.length === 0) {
      const classicRows = $("table.c tr").toArray();
      for (const rowEl of classicRows) {
        const row = $(rowEl);
        const cells = row.find("td");
        if (cells.length < 9) continue;

        // In classic Libgen: td[2] is Title, td[1] is Author, td[3] is Publisher, td[4] is Year, td[6] is Language, td[7] is Size, td[8] is Extension
        let md5: string | null = null;
        row.find("a").each((_, a) => {
          if (md5) return;
          const href = $(a).attr("href");
          md5 = extractMd5(href);
        });

        if (!md5 || seenMd5s.has(md5)) continue;

        const titleLink = cells.eq(2).find("a").first();
        const title = (titleLink.length > 0 ? titleLink.text() : cells.eq(2).text()).trim();
        if (!title) continue;

        const authorText = cells.eq(1).text().trim();
        const authors = authorText
          ? authorText
              .split(/[,;&]/)
              .map((a) => a.trim())
              .filter(Boolean)
          : undefined;

        const publisher = cells.eq(3).text().trim() || undefined;
        const yearMatch = cells.eq(4).text().match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : undefined;
        const language = cells.eq(6).text().trim() || undefined;
        const size = parseSize(cells.eq(7).text().trim());
        const format = cells.eq(8).text().trim().toUpperCase() || undefined;

        seenMd5s.add(md5);
        books.push({
          md5,
          title,
          authors: authors && authors.length > 0 ? authors : undefined,
          publisher,
          language,
          format,
          size,
          year,
          source: "libgen",
        });
      }
    }

    return books;
  }

  /**
   * Parse pagination information
   */
  public static parsePagination(
    $: CheerioRoot,
    resultsCount: number,
  ): {
    page: number;
    per_page: number;
    has_next: boolean;
    has_previous: boolean;
    estimated_total_results: number | null;
  } {
    // Check for page links
    const pageLinks = $('a[href*="page="]').toArray();
    let hasNext = false;
    let hasPrevious = false;

    if (pageLinks.length > 0) {
      hasNext = resultsCount >= 25;
    } else {
      // If we got full page of results (25+), assume next page exists
      hasNext = resultsCount >= 25;
    }

    return {
      page: 1,
      per_page: 50,
      has_next: hasNext,
      has_previous: hasPrevious,
      estimated_total_results: resultsCount > 0 ? resultsCount : null,
    };
  }

  /**
   * Build a Libgen search URL
   */
  buildSearchUrl(query: SearchQuery, baseUrl: string): string {
    const cleanBaseUrl = baseUrl.replace(/\/+(?:search\.php|index\.php)?\/?$/i, "");
    const params = new URLSearchParams();

    const searchPhrase =
      query.q ||
      [query.title, query.author].filter(Boolean).join(" ").trim() ||
      "";

    // Set both 'q' and 'req' for maximum mirror compatibility
    params.set("q", searchPhrase);
    params.set("req", searchPhrase);

    if (query.page && query.page > 1) {
      params.set("page", query.page.toString());
    }

    if (query.ext && query.ext.length > 0) {
      params.set("ext", query.ext[0]);
      params.set("extensions", query.ext[0]);
    }

    if (query.lang && query.lang.length > 0) {
      params.set("lang", query.lang[0]);
      params.set("languages", query.lang[0]);
    }

    if (query.sort) {
      params.set("sort", query.sort);
    }

    return `${cleanBaseUrl}/search.php?${params.toString()}`;
  }

  /**
   * Search Libgen
   */
  async search(query: SearchQuery, customBaseUrl?: string): Promise<SearchResponse> {
    const searchId = Math.random().toString(36).substring(7);

    // Cache check
    const cacheStart = Date.now();
    const cached = await searchCacheManager.get(query);
    if (cached) {
      logger.info(
        `[${searchId}] [Libgen] Cache hit! (${Date.now() - cacheStart}ms) - returning ${cached.results.length} results`,
      );
      return cached;
    }

    // Determine base URL
    let baseUrl = customBaseUrl;
    if (!baseUrl) {
      const config = await appConfigService.getConfig();
      baseUrl = config.searcherBaseUrl || config.quickBaseUrl || "https://libgen.co.in";
    }

    const url = this.buildSearchUrl(query, baseUrl);
    logger.info(`[${searchId}] [Libgen] Search URL: ${url}`);

    const result = await this.scrapeUrl(url);

    // Save result to cache if we found books
    if (result.results.length > 0) {
      await searchCacheManager.set(query, result);
    }

    return result;
  }
}

export const libgenScraper = new LibgenScraper();
