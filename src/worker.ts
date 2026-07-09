import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI?: any;
  PUU_SEARCH?: any;
  CF_AIG_TOKEN?: string;
}

const VERSION = "0.5.0-gpt-debug-low-tpm";

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

function text(data: string, status = 200) {
  return new Response(data, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function cleanQuestion(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 500);
}

function limitText(value: unknown, max = 900): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

async function getSmallRagContext(env: Env, question: string): Promise<string> {
  if (!env.PUU_SEARCH) return "";

  try {
    const result = await env.PUU_SEARCH.search(question, {
      topK: 2,
    });

    const matches = Array.isArray(result?.matches) ? result.matches : [];

    const chunks = matches
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
      .filter(Boolean);

    return chunks.join("\n\n");
  } catch (error) {
    console.error("RAG_SEARCH_ERROR", error);
    return "";
  }
}

async function askOpenAI(env: Env, question: string, context: string): Promise<string> {
  const token = env.CF_AIG_TOKEN;

  if (!token) {
    throw new Error("Missing CF_AIG_TOKEN");
  }

  const model = "gpt-4.1-mini";

  const input = [
    {
      role: "system",
      content:
        SYSTEM_PROMPT +
        "\n\nVastaa tiiviisti suomeksi. Älä keksi tietoja. Jos tieto puuttuu, sano se selvästi.",
    },
    {
      role: "user",
      content:
        `Kysymys:\n${question}\n\n` +
        `Mahdollinen hakukonteksti:\n${context || "Ei hakukontekstia."}`,
    },
  ];

  console.log("GPT_MODEL", model);
  console.log("QUESTION_LENGTH", question.length);
  console.log("CONTEXT_LENGTH", context.length);
  console.log("SYSTEM_PROMPT_LENGTH", SYSTEM_PROMPT.length);

  const response = await fetch("https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_NAME/openai/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: 500,
    }),
  });

  const raw = await response.text();

  console.log("OPENAI_STATUS", response.status);
  console.log("OPENAI_RAW", raw.slice(0, 2000));

  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${raw.slice(0, 1000)}`);
  }

  const data: any = JSON.parse(raw);

  const answer =
    data?.output_text ||
    data?.output?.[0]?.content?.[0]?.text ||
    "";

  if (!answer) {
    throw new Error("OpenAI returned empty answer");
  }

  return answer.trim();
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
          cfAigToken: !!env.CF_AIG_TOKEN,
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
              error: "Kysymys puuttuu.",
            },
            400,
          );
        }

        const context = await getSmallRagContext(env, question);
        const answer = await askOpenAI(env, question, context);

        return json({
          ok: true,
          answer,
          version: VERSION,
        });
      } catch (error: any) {
        console.error("ASK_FATAL_ERROR", error?.message || error);
        console.error("ASK_FATAL_STACK", error?.stack || "");

        return json(
          {
            ok: false,
            answer:
              "AI-palvelu ei saanut muodostettua vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.",
            version: VERSION,
          },
          200,
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
