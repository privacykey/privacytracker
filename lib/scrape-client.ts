/** The scrape route accepts at most 100 App Store URLs per request. */
const SCRAPE_BATCH_SIZE = 100;

export type ClientScrapeResult =
  | {
      status: "success";
      changesDetected: boolean;
      changeCount: number;
      versionChanged: boolean;
      currentVersion: string | null;
    }
  | { status: "error" | "rate_limited"; error: string };

export interface ScrapeSummary {
  attempted: number;
  failed: number;
  stopped: boolean;
  succeeded: number;
  total: number;
}

function responseError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error: unknown }).error;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return `Sync request failed (${status})`;
}

export async function requestScrape(
  urls: string[],
  signal?: AbortSignal
): Promise<ClientScrapeResult[]> {
  const response = await fetch("/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls, resync: true, summarizePolicies: false }),
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(responseError(body, response.status));
  }
  if (!(body && typeof body === "object" && "results" in body)) {
    throw new Error("Sync returned an invalid response");
  }
  const results = (body as { results: unknown }).results;
  if (
    !Array.isArray(results) ||
    results.length !== urls.length ||
    results.some(
      (result) =>
        !result ||
        typeof result !== "object" ||
        !["success", "error", "rate_limited"].includes(result.status) ||
        (result.status !== "success" && typeof result.error !== "string")
    )
  ) {
    throw new Error("Sync returned incomplete results");
  }
  return results as ClientScrapeResult[];
}

export async function requestSingleScrape(
  url: string,
  signal?: AbortSignal
): Promise<Extract<ClientScrapeResult, { status: "success" }>> {
  const [result] = await requestScrape([url], signal);
  if (result.status !== "success") {
    throw new Error(result.error);
  }
  return result;
}

/** Continue past individual app errors, but stop sending batches after a 429. */
export async function requestBulkScrape(
  urls: string[],
  signal?: AbortSignal,
  onProgress?: (attempted: number, total: number) => void
): Promise<ScrapeSummary> {
  const summary: ScrapeSummary = {
    succeeded: 0,
    failed: 0,
    attempted: 0,
    total: urls.length,
    stopped: false,
  };
  for (let start = 0; start < urls.length; start += SCRAPE_BATCH_SIZE) {
    const batch = urls.slice(start, start + SCRAPE_BATCH_SIZE);
    let results: ClientScrapeResult[];
    try {
      results = await requestScrape(batch, signal);
    } catch (error) {
      if (summary.attempted === 0 || (error as Error)?.name === "AbortError") {
        throw error;
      }
      summary.stopped = true;
      return summary;
    }
    summary.attempted += results.length;
    summary.succeeded += results.filter(
      (result) => result.status === "success"
    ).length;
    summary.failed += results.filter(
      (result) => result.status !== "success"
    ).length;
    onProgress?.(summary.attempted, summary.total);
    if (results.some((result) => result.status === "rate_limited")) {
      summary.stopped = true;
      break;
    }
  }
  return summary;
}
