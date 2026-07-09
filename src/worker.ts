import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  r2jukipuu?: R2Bucket;
  kuvat?: any;
}

const VERSION = "0.5.1-workers-ai-gpt55";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://jukipuu.fi",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function cleanQuestion(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 500);
}

function limitText(value: unknown, max = 700): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function extractAnswer(response: any): string {
  if (typeof response === "string") return response.trim();

  return (
    response?.response ||
    response?.answer ||
    response?.output_text ||
    response?.result?.response ||
    response?.result?.answer ||
    response?.result?.output_text ||
    response?.output?.[0]?.content?.[0]?.text ||
    response?.choices?.[0]?.message?.content ||
    ""
  ).trim();
}

async function getSmallRagContext(env: Env, question: string): Promise<string> {
  if (!env.PUU_SEARCH) return "";

  try {
    const result = await env.PUU_SEARCH.search(question, {
      topK: 2,
    });

    const matches = Array.isArray(result?.matches) ? result.matches : [];

    return matches
      .slice(0, 2)
      .map((item: any, index: number) => {
        const title =
          item?.metadata?.title ||
          item?.metadata?.source ||
          `Hakutulos ${index + 1}`;

        const content =
          item?.metadata?.text ||
          item?.metadata?.content ||
          item?.text ||
          "";

        return `Lähde ${index + 1}: ${limitText(title, 120)}\n${limitText(content, 700)}`;
      })
      .filter(Boolean)
      .join("\n\n");
  } catch (error) {
    console.error("RAG_SEARCH_ERROR", error);
    return "";
  }
}

async function askGpt55(env: Env, question: string, context: string): Promise<string> {
  const userPrompt =
    `Kysymys:\n${question}\n\n` +
    `Hakukonteksti:\n${context || "Ei hakukontekstia."}`;

  console.log("GPT_MODEL", "openai/gpt-5.5-pro");
  console.log("QUESTION_LENGTH", question.length);
  console.log("CONTEXT_LENGTH", context.length);
  console.log("SYSTEM_PROMPT_LENGTH", SYSTEM_PROMPT.length);

  const response = await env.AI.run("openai/gpt-5.5-pro", {
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\n\nVastaa aina suomeksi. Vastaa tiiviisti. Älä keksi tietoja.",
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    max_tokens: 500,
  });

  console.log("AI_RAW_RESPONSE", JSON.stringify(response).slice(0, 2000));

  const answer = extractAnswer(response);

  if (!answer) {
    throw new Error("Workers AI returned empty answer");
  }

  return answer;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "AI-puuopas",
        version: VERSION,
        bindings: {
          assets: !!env.ASSETS,
          workersAI: !!env.AI,
          aiSearch: !!env.PUU_SEARCH,
          r2: !!env.r2jukipuu,
          images: !!env.kuvat,
        },
      });
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      try {
        const body: any = await request.json().catch(() => ({}));
        const question = cleanQuestion(body?.question || body?.q || body?.message);

        if (!question) {
          return json(
            {
              ok: false,
              answer: "Kysymys puuttuu.",
              version: VERSION,
            },
            400,
          );
        }

        const context = await getSmallRagContext(env, question);
try {
  const answer = await askGpt55(env, question, context);

  return json({
    ok: true,
    answer,
    version: VERSION,
  });
} catch (err: any) {
  console.error("ASK_FATAL_ERROR", error?.message || error);
  console.error("ASK_FATAL_STACK", error?.stack || "");

  return json(
    {
      ok: false,
      answer:
        "AI-palvelu ei saanut muodostettua vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.",
      debug: String(error?.message || error),
      version: VERSION,
    },
    500
  );
}
    }

    return env.ASSETS.fetch(request);
  },
};
