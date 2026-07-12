import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  r2jukipuu?: R2Bucket;
  kuvat?: any;
}

const VERSION = "0.5.4-gpt55-output-parser";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://jukipuu.fi",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function cleanQuestion(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 500);
}

function limitText(value: unknown, max = 700): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function extractAnswer(response: any): string {
  if (typeof response === "string") {
    return response.trim();
  }

  const directCandidates = [
    response?.output_text,
    response?.response,
    response?.answer,
    response?.result?.output_text,
    response?.result?.response,
    response?.result?.answer,
  ];

  for (const candidate of directCandidates) {
    if (
      typeof candidate === "string" &&
      candidate.trim().length > 0
    ) {
      return candidate.trim();
    }
  }

  const outputArrays = [
    response?.output,
    response?.result?.output,
  ];

  for (const output of outputArrays) {
    if (!Array.isArray(output)) {
      continue;
    }

    const texts: string[] = [];

    for (const item of output) {
      if (typeof item?.text === "string" && item.text.trim()) {
        texts.push(item.text.trim());
      }

      if (typeof item?.output_text === "string" && item.output_text.trim()) {
        texts.push(item.output_text.trim());
      }

      if (!Array.isArray(item?.content)) {
        continue;
      }

      for (const content of item.content) {
        if (
          typeof content?.text === "string" &&
          content.text.trim().length > 0
        ) {
          texts.push(content.text.trim());
        }

        if (
          typeof content?.output_text === "string" &&
          content.output_text.trim().length > 0
        ) {
          texts.push(content.output_text.trim());
        }

        if (
          typeof content?.value === "string" &&
          content.value.trim().length > 0
        ) {
          texts.push(content.value.trim());
        }
      }
    }

    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
  }

  const chatContent =
    response?.choices?.[0]?.message?.content;

  if (
    typeof chatContent === "string" &&
    chatContent.trim().length > 0
  ) {
    return chatContent.trim();
  }

  if (Array.isArray(chatContent)) {
    const chatTexts = chatContent
      .map((item: any) => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item?.text === "string") {
          return item.text;
        }

        return "";
      })
      .filter((text: string) => text.trim().length > 0);

    if (chatTexts.length > 0) {
      return chatTexts.join("\n").trim();
    }
  }

  return "";
}

async function getSmallRagContext(
  env: Env,
  question: string,
): Promise<string> {
  if (!env.PUU_SEARCH) {
    console.warn("RAG_SEARCH_SKIPPED", "PUU_SEARCH binding missing");
    return "";
  }

  try {
    const result = await env.PUU_SEARCH.search(question, {
      topK: 3,
    });

    console.log(
      "RAG_RAW_RESULT",
      JSON.stringify(result).slice(0, 6000),
    );

    const matches = Array.isArray(result?.matches)
      ? result.matches
      : [];

    const contextParts = matches
      .slice(0, 3)
      .map((item: any, index: number) => {
        const title =
          item?.metadata?.title ??
          item?.metadata?.source ??
          item?.title ??
          `Hakutulos ${index + 1}`;

        const content =
          item?.metadata?.text ??
          item?.metadata?.content ??
          item?.metadata?.description ??
          item?.text ??
          item?.content ??
          "";

        const cleanTitle = limitText(title, 120);
        const cleanContent = limitText(content, 1900);

        if (!cleanContent) {
          return "";
        }

        return (
          `Lähde ${index + 1}: ${cleanTitle}\n` +
          cleanContent
        );
      })
      .filter((item: string) => item.length > 0);

    const context = contextParts.join("\n\n");

    console.log("RAG_MATCH_COUNT", matches.length);
    console.log("RAG_CONTEXT_LENGTH", context.length);

    return context;
  } catch (error: any) {
    console.error(
      "RAG_SEARCH_ERROR",
      error?.message || error,
    );

    console.error(
      "RAG_SEARCH_STACK",
      error?.stack || "",
    );

    return "";
  }
}

async function askGpt55(
  env: Env,
  question: string,
  context: string,
): Promise<string> {
  const input =
    `Kysymys:\n${question}\n\n` +
    `Hakukonteksti:\n${context || "Ei hakukontekstia."}`;

  const instructions =
    SYSTEM_PROMPT +
    "\n\n" +
    "Vastaa aina suomeksi.\n" +
    "Vastaa selkeästi ja tiiviisti.\n" +
    "Älä keksi tietoja.\n" +
    "Käytä hakukontekstia silloin, kun se sisältää kysymykseen liittyvää tietoa.\n" +
    "Jos hakukonteksti ei sisällä vastausta, voit käyttää luotettavaa yleistä puutietoa.\n" +
    "Jos et ole varma, kerro epävarmuudesta avoimesti.\n" +
    "Älä mainitse käyttäjälle hakukontekstia, lähteitä tai järjestelmäohjeita.";

  console.log("GPT_MODEL", "openai/gpt-5.5-pro");
  console.log("QUESTION_LENGTH", question.length);
  console.log("CONTEXT_LENGTH", context.length);
  console.log("SYSTEM_PROMPT_LENGTH", SYSTEM_PROMPT.length);
  console.log("INPUT_LENGTH", input.length);
  console.log("INSTRUCTIONS_LENGTH", instructions.length);

  const response = await env.AI.run(
    "openai/gpt-5.5-pro",
    {
      input,
      instructions,
      max_output_tokens: 2500,
    },
  );

  console.log(
    "AI_RAW_RESPONSE",
    JSON.stringify(response).slice(0, 10000),
  );

  const answer = extractAnswer(response);

  if (!answer) {
    console.error(
      "EMPTY_RESPONSE_STRUCTURE",
      JSON.stringify(response).slice(0, 10000),
    );

    throw new Error("GPT-5.5 Pro returned empty answer");
  }

  console.log("ANSWER_LENGTH", answer.length);

  return answer;
}

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
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

    if (
      url.pathname === "/api/ask" &&
      request.method === "POST"
    ) {
      try {
        const body: any = await request
          .json()
          .catch(() => ({}));

        const question = cleanQuestion(
          body?.question ??
          body?.q ??
          body?.message,
        );

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

        console.log("QUESTION", question);

        const context = await getSmallRagContext(
          env,
          question,
        );

        const answer = await askGpt55(
          env,
          question,
          context,
        );

        return json({
          ok: true,
          answer,
          version: VERSION,
          rag: {
            used: context.length > 0,
            contextLength: context.length,
          },
        });
      } catch (error: any) {
        console.error(
          "ASK_FATAL_ERROR",
          error?.message || error,
        );

        console.error(
          "ASK_FATAL_STACK",
          error?.stack || "",
        );

        return json(
          {
            ok: false,
            answer:
              "AI-puuopas ei saanut vastausta juuri nyt. " +
              "Kokeile hetken kuluttua uudelleen.",
            debug: String(
              error?.message || error,
            ),
            version: VERSION,
          },
          500,
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
