import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";

const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }) => {
    console.log(`[internet_search] query="${query}" topic=${topic} maxResults=${maxResults}`);

    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
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
          "Search topic category. Only 'general', 'news', or 'finance' are accepted by Tavily. Use 'general' for tech/AI/people queries.",
        ),
      includeRawContent: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include raw content"),
    }),
  },
);

const webResearchSubagent = {
  name: "research-agent",
  description:
    "Use for any question that needs current web information (people, events, news, definitions, recent facts). Returns a synthesized summary with cited sources.",
  systemPrompt: `You are a thorough web researcher.

# Workflow (MANDATORY)

1. Break the research question into 1-3 concrete search queries
2. Call internet_search for each query (in parallel when possible)
3. Read the returned results carefully
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
- If internet_search returns an error or no results, say so explicitly in your final answer instead of making things up`,
  tools: [internetSearch],
};

export default webResearchSubagent;
