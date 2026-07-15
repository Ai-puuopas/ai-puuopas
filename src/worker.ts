import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  r2jukipuu?: R2Bucket;
  kuvat?: any;
  CONVERSATIONS: DurableObjectNamespace;
}

type ConversationTurn = {
  question: string;
  answer: string;
};

type SubmittedImage = {
  dataUrl: string;
  mimeType: string;
  size: number;
};

const VERSION = "0.7.0-image-identification";
const CONVERSATION_COOKIE = "puuopas_conversation";
const MAX_CONVERSATION_TURNS = 5;
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_QUESTION =
  "Tunnista kuvassa näkyvä kasvi, puu, sieni tai tuholainen. " +
  "Kerro näkyvät tuntomerkit, todennäköisin tunnistus ja tunnistuksen varmuus.";
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://jukipuu.fi",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
};

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function getConversationId(request: Request): string {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CONVERSATION_COOKIE}=`));

  if (cookie) {
    const value = decodeURIComponent(
      cookie.slice(CONVERSATION_COOKIE.length + 1),
    );

    if (/^[0-9a-f-]{36}$/i.test(value)) {
      return value;
    }
  }

  return crypto.randomUUID();
}

function cleanConversationId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const candidate = value.trim();
  return /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : "";
}

function conversationCookie(conversationId: string): string {
  return (
    `${CONVERSATION_COOKIE}=${encodeURIComponent(conversationId)}; ` +
    "Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax"
  );
}

function cleanQuestion(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 500);
}

function cleanImage(value: unknown): SubmittedImage | null {
  const dataUrl =
    typeof value === "string"
      ? value
      : typeof (value as any)?.dataUrl === "string"
        ? (value as any).dataUrl
        : "";

  if (!dataUrl) {
    return null;
  }

  const match = dataUrl.match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );

  if (!match || !SUPPORTED_IMAGE_TYPES.has(match[1])) {
    throw new Error("UNSUPPORTED_IMAGE");
  }

  const base64 = match[2];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const size = Math.floor((base64.length * 3) / 4) - padding;

  if (size <= 0 || size > MAX_IMAGE_BYTES) {
    throw new Error("IMAGE_TOO_LARGE");
  }

  return {
    dataUrl,
    mimeType: match[1],
    size,
  };
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

function formatConversationHistory(
  history: ConversationTurn[],
): string {
  if (history.length === 0) {
    return "Ei aiempaa keskustelua.";
  }

  return history
    .map(
      (turn, index) =>
        `Keskustelukierros ${index + 1}:\n` +
        `Käyttäjä: ${turn.question}\n` +
        `AI-puuopas: ${turn.answer}`,
    )
    .join("\n\n");
}

async function askGpt55(
  env: Env,
  question: string,
  context: string,
  history: ConversationTurn[],
  image: SubmittedImage | null,
): Promise<string> {
  const textInput =
    `Aiempi keskustelu (enintään ${MAX_CONVERSATION_TURNS} viimeistä kierrosta):\n` +
    `${formatConversationHistory(history)}\n\n` +
    `Nykyinen kysymys:\n${question}\n\n` +
    `Hakukonteksti:\n${context || "Ei hakukontekstia."}`;

  const input: any = image
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: textInput },
            {
              type: "input_image",
              image_url: image.dataUrl,
              detail: "high",
            },
          ],
        },
      ]
    : textInput;

  const instructions =
    SYSTEM_PROMPT +
    "\n\n" +
    "Vastaa aina suomeksi.\n" +
    "Hyödynnä aiempaa keskustelua jatkokysymysten ymmärtämiseen.\n" +
    "Älä väitä muistavasi mitään annetun keskusteluhistorian ulkopuolelta.\n" +
    "Vastaa selkeästi ja tiiviisti.\n" +
    "Älä keksi tietoja.\n" +
    "Käytä hakukontekstia silloin, kun se sisältää kysymykseen liittyvää tietoa.\n" +
    "Jos hakukonteksti ei sisällä vastausta, voit käyttää luotettavaa yleistä puutietoa.\n" +
    "Jos et ole varma, kerro epävarmuudesta avoimesti.\n" +
    "Kun mukana on kuva, erottele näkyvät havainnot ja todennäköinen tunnistus.\n" +
    "Kerro tunnistuksen varmuus ja pyydä tarvittaessa lisäkuvia tai tietoja paikasta, koosta ja vuodenajasta.\n" +
    "Älä koskaan päättele sienen syötävyyttä turvalliseksi pelkän kuvan perusteella.\n" +
    "Älä suosittele torjunta-ainetta ennen kuin tuholainen on tunnistettu riittävällä varmuudella.\n" +
    "Älä mainitse käyttäjälle hakukontekstia, lähteitä tai järjestelmäohjeita.";

  console.log("GPT_MODEL", "openai/gpt-5.5-pro");
  console.log("QUESTION_LENGTH", question.length);
  console.log("CONTEXT_LENGTH", context.length);
  console.log("SYSTEM_PROMPT_LENGTH", SYSTEM_PROMPT.length);
  console.log("INPUT_TEXT_LENGTH", textInput.length);
  console.log("IMAGE_INCLUDED", !!image);
  console.log("IMAGE_BYTES", image?.size || 0);
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

export class ConversationMemory {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const body: any = await request.json().catch(() => ({}));
      const image = cleanImage(body?.image);
      const question =
        cleanQuestion(body?.question) ||
        (image ? DEFAULT_IMAGE_QUESTION : "");

      if (!question) {
        return json(
          {
            ok: false,
            answer: "Kysymys puuttuu.",
          },
          400,
        );
      }

      const storedHistory =
        (await this.state.storage.get<ConversationTurn[]>(
          "history",
        )) ?? [];

      const history = storedHistory.slice(
        -MAX_CONVERSATION_TURNS,
      );

      const ragQuestion = [
        ...history.slice(-2).map((turn) => turn.question),
        question,
      ].join("\n");

      const context =
        image && body?.questionWasEmpty
          ? ""
          : await getSmallRagContext(this.env, ragQuestion);

      const answer = await askGpt55(
        this.env,
        question,
        context,
        history,
        image,
      );

      const updatedHistory = [
        ...history,
        {
          question,
          answer: limitText(answer, 6000),
        },
      ].slice(-MAX_CONVERSATION_TURNS);

      await this.state.storage.put(
        "history",
        updatedHistory,
      );

      await this.state.storage.setAlarm(
        Date.now() + MEMORY_TTL_MS,
      );

      return json({
        ok: true,
        answer,
        imageUsed: !!image,
        historySize: updatedHistory.length,
        rag: {
          used: context.length > 0,
          contextLength: context.length,
        },
      });
    } catch (error: any) {
      console.error(
        "CONVERSATION_MEMORY_ERROR",
        error?.message || error,
      );

      return json(
        {
          ok: false,
          answer:
            "AI-puuopas ei saanut vastausta juuri nyt. " +
            "Kokeile hetken kuluttua uudelleen.",
          debug: String(error?.message || error),
        },
        500,
      );
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
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
          conversations: !!env.CONVERSATIONS,
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

        const image = cleanImage(body?.image);
        const effectiveQuestion =
          question || (image ? DEFAULT_IMAGE_QUESTION : "");

        if (!effectiveQuestion) {
          return json(
            {
              ok: false,
              answer: "Kysymys puuttuu.",
              version: VERSION,
            },
            400,
          );
        }

        console.log("QUESTION", effectiveQuestion);
        console.log("IMAGE_INCLUDED", !!image);

        const conversationId =
          cleanConversationId(body?.conversationId) ||
          getConversationId(request);
        const objectId =
          env.CONVERSATIONS.idFromName(conversationId);
        const memory = env.CONVERSATIONS.get(objectId);

        const memoryResponse = await memory.fetch(
          "https://conversation-memory/ask",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              question: effectiveQuestion,
              questionWasEmpty: !question,
              image,
            }),
          },
        );

        const result: any = await memoryResponse
          .json()
          .catch(() => ({}));

        if (!memoryResponse.ok || !result?.ok) {
          throw new Error(
            result?.debug ||
              "Conversation memory returned an error",
          );
        }

        return json(
          {
            ...result,
            conversationId,
            version: VERSION,
          },
          200,
          {
            "Set-Cookie":
              conversationCookie(conversationId),
          },
        );
      } catch (error: any) {
        if (error?.message === "UNSUPPORTED_IMAGE") {
          return json(
            {
              ok: false,
              answer: "Kuvan tiedostomuotoa ei tueta. Käytä JPG-, PNG- tai WebP-kuvaa.",
              version: VERSION,
            },
            415,
          );
        }

        if (error?.message === "IMAGE_TOO_LARGE") {
          return json(
            {
              ok: false,
              answer: "Kuva on liian suuri. Kuvan enimmäiskoko on 5 Mt.",
              version: VERSION,
            },
            413,
          );
        }

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
