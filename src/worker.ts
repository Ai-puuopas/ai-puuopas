import { SYSTEM_PROMPT } from "./prompt.js";

export interface Env {
  ASSETS?: Fetcher;
  PUU_SEARCH?: any;
  AI?: any;
  DB?: any;
  tyoskentelu?: any;
  CF_AIG_TOKEN?: string;
  r2jukipuu?: any;
  kuvat?: any;
}

const VERSION = "0.4.9.3-clean-build";
const GPT_MODEL = "gpt-5.5";

const AI_GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/c929d499c01584b02d13721d801e78ff/default/openai/chat/completions";

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

function normalize(value: unknown): string {
  return String(value || "").toLowerCase().trim();
}

function isPlantQuestion(question: string): boolean {
  const q = normalize(question);

  const words = [
    "puu", "puun", "puut", "puunkaato", "kaato", "kaataa",
    "arboristi", "kaatokiipeily", "kiipeilykaato",
    "oksa", "latvus", "runko", "juuri", "juurenniska",
    "vesiverso", "juurivesa",
    "kasvi", "pensas", "pensasaita", "tuija", "kuusiaita",
    "omenapuu", "koivu", "mänty", "kuusi", "tammi",
    "vaahtera", "pihlaja", "raita", "kastanja",
    "leikkaus", "hoitoleikkaus", "hoito",
    "laho", "lahovika", "kääpä", "käävät", "sieni",
    "repeämä", "kallistunut", "vinossa",
    "sähkölinja", "puutarha", "piha", "pihapuu",
    "istutus", "multa", "lannoitus",
  ];

  return words.some((word) => q.includes(word));
}

function shouldAskService(question: string): boolean {
  const q = normalize(question);

  const serviceWords = [
    "puunkaato", "kaato", "kaataa", "kaadetaan",
    "kaatokiipeily", "kiipeilykaato",
    "vaarallinen", "talon lähellä", "rakennuksen lähellä",
    "sähkölinja", "iso oksa", "suuri oksa",
    "hoitoleikkaus", "kunnon arviointi", "puun kunto",
    "kääpä", "käävät", "laho", "lahovika",
    "repeämä", "kallistunut", "vinossa",
    "hinta", "mitä maksaa", "paljon maksaa", "tarjous",
  ];

  const avoidWords = [
    "juurenniska",
    "vesiverso",
    "istutus",
    "multa",
    "lannoitus",
  ];

  return (
    serviceWords.some((word) => q.includes(word)) &&
    !avoidWords.some((word) => q.includes(word))
  );
}

function addServiceQuestion(answer: string, question: string): string {
  if (!shouldAskService(question)) return answer;
  if (answer.includes("Voisiko JuKiPuu auttaa")) return answer;

  return (
    answer +
    "\n\nVoisiko JuKiPuu auttaa tilanteen arvioinnissa paikan päällä?"
  );
}

async function readQuestion(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { question?: unknown };
    return String(body.question || "").trim();
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return String(formData.get("question") || "").trim();
  }

  return "";
}

function extractChunks(result: any): any[] {
  const chunks =
    result?.chunks ||
    result?.result?.chunks ||
    result?.data ||
    result?.result?.data ||
    [];

  return Array.isArray(chunks) ? chunks : [];
}

async function getAiSearchContext(env: Env, question: string): Promise<string> {
  if (!env.PUU_SEARCH) return "";

  try {
    const result = await env.PUU_SEARCH.search({
      query: question,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: 6,
          match_threshold: 0.35,
          context_expansion: 1,
        },
      },
    });

    const chunks = extractChunks(result);

    return chunks
      .map((chunk: any, index: number) => {
        const text = chunk.text || chunk.content || chunk.markdown || "";
        const source =
          chunk.source || chunk.filename || chunk.url || chunk.title || "AI Search";

        return `Lähde ${index + 1}: ${source}\n${text}`;
      })
      .filter((item: string) => item.trim().length > 0)
      .join("\n\n---\n\n");
  } catch (err) {
    console.error("AI Search error:", err);
    return "";
  }
}

async function askGpt(
  env: Env,
  question: string,
  context: string,
): Promise<string> {
  if (!env.CF_AIG_TOKEN) {
    throw new Error("CF_AIG_TOKEN puuttuu.");
  }

  const response = await fetch(AI_GATEWAY_URL, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GPT_MODEL,
      messages: [
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            "\n\nKäytä AI Search -taustatietoa apuna. Älä keksi tietoja. Vastaa aina suomeksi.",
        },
        {
          role: "user",
          content:
            `Käyttäjän kysymys:\n${question}\n\n` +
            `AI Search -taustatieto:\n${context || "Ei lisätaustaa."}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 700,
    }),
  });

  const text = await response.text();

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return (
    data?.choices?.[0]?.message?.content ||
    "GPT vastasi, mutta vastausta ei voitu purkaa."
  );
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
          d1: !!env.DB,
          workflow: !!env.tyoskentelu,
          cfAigToken: !!env.CF_AIG_TOKEN,
        },
      });
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      const started = Date.now();

      try {
        const question = await readQuestion(request);

        if (!question) {
          return json(
            {
              ok: false,
              error: "Kysymys puuttuu tai on tyhjä.",
            },
            400,
          );
        }

        if (!isPlantQuestion(question)) {
          return json({
            ok: true,
            app: "AI-puuopas",
            version: VERSION,
            question,
            answer:
              "🌳 Olen JuKiPuun AI-puuopas. Vastaan vain kasvikuntaan, puihin, pensaisiin, kasvien hoitoon, puunkaatoon ja arboristin työhön liittyviin kysymyksiin.",
            durationMs: Date.now() - started,
          });
        }

        const context = await getAiSearchContext(env, question);

        let answer: string;

        try {
          answer = await askGpt(env, question, context);
        } catch (err) {
          console.error("GPT Gateway error:", err);
          answer =
            "Löysin JuKiPuun aineistoa, mutta vastauksen muodostaminen GPT:n kautta epäonnistui juuri nyt. Kokeile hetken päästä uudelleen.";
        }

        return json({
          ok: true,
          app: "AI-puuopas",
          version: VERSION,
          model: GPT_MODEL,
          question,
          answer: addServiceQuestion(answer, question),
          usedAiSearch: context.length > 0,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        console.error("Ask endpoint error:", err);

        return json(
          {
            ok: false,
            app: "AI-puuopas",
            version: VERSION,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - started,
          },
          500,
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", {
      status: 404,
      headers: corsHeaders,
    });
  },
};
