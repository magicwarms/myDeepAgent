import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";

const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    timeRange,
    searchDepth = "basic",
    includeRawContent = false,
  }) => {
    // For news/recency queries, default to "news" topic + a recent time window
    // so Tavily ranks by freshness instead of generic relevance.
    const effectiveTimeRange =
      timeRange ?? (topic === "news" ? "week" : undefined);

    console.log(
      `[internet_search] query="${query}" topic=${topic} timeRange=${effectiveTimeRange ?? "none"} searchDepth=${searchDepth} maxResults=${maxResults}`,
    );

    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
      searchDepth,
      ...(effectiveTimeRange ? { timeRange: effectiveTimeRange } : {}),
    });

    try {
      const result = await tavilySearch._call({ query });
      const serialized =
        typeof result === "string" ? result : JSON.stringify(result);
      const numResults = Array.isArray(result?.results)
        ? result.results.length
        : "?";
      console.log(
        `[internet_search] OK serializedLen=${serialized.length} numResults=${numResults} preview=${serialized.slice(0, 200)}`,
      );
      return result;
    } catch (err) {
      console.error(`[internet_search] ERROR: ${err?.message ?? err}`);
      throw err;
    }
  },
  {
    name: "internet_search",
    description: "Run a web search based on user search query",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of results to return"),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe(
          "Search topic category. Only 'general', 'news', or 'finance' are accepted by Tavily. Use 'news' for anything about recent events / latest news / 'terbaru'. Use 'general' for stable tech/AI/people/definition queries.",
        ),
      timeRange: z
        .enum(["day", "week", "month", "year"])
        .optional()
        .describe(
          "Restrict results to a recent time window relative to today. REQUIRED for latest-news / 'berita terbaru' queries: use 'day' for breaking news, 'week' for recent news, 'month' for the last few weeks. Leave unset for timeless facts.",
        ),
      searchDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe(
          "Use 'advanced' for news/recency or hard-to-find queries (fresher, higher-quality results); 'basic' is fine for simple lookups.",
        ),
      includeRawContent: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include raw content"),
    }),
  },
);

const buildSystemPrompt = () => {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const todayHuman = today.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `You are a thorough web researcher.

# Today's date (CRITICAL — read first)

Today is ${todayHuman} (${todayIso}). This is the REAL current date — trust it over any internal sense of "now" from your training data. "Terbaru" / "latest" / "recent" means close to ${todayIso}.

# Recency rules (MANDATORY for news / "terbaru" / current-events queries)

- Include the current year (and month when relevant) in the search query itself, e.g. "harga emas Juni 2026", not just "harga emas".
- Set topic="news" for anything about recent events or latest news.
- Set timeRange: "day" for breaking news, "week" for recent news, "month" for the last few weeks. Without timeRange the search returns stale pages.
- Set searchDepth="advanced" for news/recency queries.
- Inspect each result's date (the "published_date" field, or dates in the title/content). DISCARD results clearly older than the user's time window. If a result has no recent date and the question is about "terbaru", do not treat it as current.
- If the freshest results are still old, run ONE more search with a tighter timeRange or a more specific query before answering.
- Never fill gaps with prior knowledge about recent events — if the search did not return fresh information, say so explicitly.

# Workflow (MANDATORY)

1. Break the research question into 1-3 concrete search queries
2. Call internet_search for each query (in parallel when possible)
3. Read the returned results carefully — check dates against today's date
4. Synthesize findings into a single comprehensive answer

# Output format (CRITICAL)

Your FINAL message MUST be a complete, standalone answer in plain text. Put the entire summary in the message content — not in thinking/reasoning tokens. The orchestrating agent only sees your final content field; if it is empty, the user gets nothing.

Structure:

Ringkasan:
<2-3 paragraf yang menjawab pertanyaan, dalam Bahasa Indonesia kecuali pertanyaan dalam bahasa lain>

Poin utama:
- <bullet point 1>
- <bullet point 2>
- <bullet point 3>

Sumber:
- <url 1>
- <url 2>

# Rules (STRICT)

- NEVER respond with only "I researched" or "berikut hasilnya" without the actual content
- NEVER ask the user clarifying questions — make a reasonable interpretation and search
- ALL facts in your answer MUST come from the internet_search results you just received. Do NOT use prior knowledge. If a fact is not in the search results, do not include it.
- Sources section MUST list the EXACT urls returned by internet_search (look at the "url" field in each result). NEVER cite generic homepages like "techcrunch.com" — cite the specific article URL.
- Keep total length under 500 words
- For recent-event answers, mention the date of the information (e.g. "per ${todayIso}" or the article's publish date) so the reader knows how fresh it is
- If internet_search returns an error or no results, say so explicitly in your final answer instead of making things up`;
};

const webResearchSubagent = {
  name: "research-agent",
  description:
    "Use for any question that needs current web information (people, events, news, definitions, recent facts). Returns a synthesized summary with cited sources.",
  // Getter so the embedded date is recomputed each time the prompt is read,
  // keeping "today's date" accurate even on a long-running server.
  get systemPrompt() {
    return buildSystemPrompt();
  },
  tools: [internetSearch],
};

export default webResearchSubagent;
