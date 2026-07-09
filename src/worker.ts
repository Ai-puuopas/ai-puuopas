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

const VERSION = "0.4.9.2-gpt-gateway-rag-buildfix";

const AI_GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/c929d499c01584b02d13721d801e78ff/default/openai/chat/completions";

const GPT_MODEL = "gpt-5.5";

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

function normalize(text: unknown): string {
  return String(text || "").toLowerCase().trim();
}

function isPlantQuestion(question: string): boolean {
  const q = normalize(question);

  const allowedWords = [
    "puu", "puut", "puun", "puita",
    "puunkaato", "puunkaadon", "puunkaatoa", "puunkaadosta",
    "kaato", "kaataa", "kaadetaan",
    "arboristi", "arboristin",
    "kaatokiipeily", "kiipeilykaato",
    "oksa", "oksat", "oksan", "oksia",
    "latvus", "latvuksen",
    "runko", "rungon",
    "juuri", "juuret", "juuristo", "juurenniska",
    "vesiverso", "vesiversot",
    "juurivesa", "juurivesat",
    "kasvi", "kasvit", "kasvin", "kasvikunta",
    "pensas", "pensaat", "pensasaita", "pensasaitaa",
    "tuija", "tuijat",
    "kuusiaita", "aita",
    "kukka", "kukat",
    "nurmikko", "köynnös",
    "omenapuu", "omenapuun",
    "koivu", "koivun",
    "mänty", "männyn",
    "kuusi", "kuusen",
    "tammi", "tammen",
    "vaahtera", "vaahteran",
    "pihlaja", "pihlajan",
    "raita", "raidan",
    "kastanja", "hevoskastanja", "hevoskastanjan",
    "leikkaus", "leikata", "hoitoleikkaus",
    "hoito", "hoitaa",
    "lahovika", "laho", "lahonnut",
    "kääpä", "käävät", "sieni", "tauti",
    "repeämä", "repeytynyt",
    "kallistunut", "vinossa",
    "sähkölinja", "sähkölinjat",
    "puutarha", "piha", "pihapuu", "pihapuun",
    "istutus", "istuttaa", "multa", "lannoitus",
  ];

  return allowedWords.some((word) => q.includes(word));
}

function shouldAskJuKiPuuService(question: string): boolean {
  const q = normalize(question);

  const serviceIntentWords = [
    "puunkaato", "puunkaadon", "puunkaatoa",
    "kaato", "kaataa", "kaadetaan",
    "kaatokiipeily", "kiipeilykaato",
    "vaarallinen", "vaarallisen",
    "rakennuksen lähellä", "talon lähellä",
    "sähkölinja", "sähkölinjat",
    "suuri oksa", "iso oksa",
    "hoitoleikkaus", "hoitoleikkausta",
    "pienentää", "pienennys",
    "kunnon arviointi", "puun kunto",
    "kääpä", "käävät",
    "lahovika", "laho", "lahonnut",
    "repeämä", "repeytynyt",
    "kallistunut", "vinossa",
    "mitä maksaa", "hinta", "paljon maksaa", "tarjous",
  ];

  return serviceIntentWords.some((word) => q.includes(word));
}

function shouldAvoidJuKiPuuService(question: string): boolean {
  const q = normalize(question);

  const avoidWords = [
    "juurenniska",
    "vesiverso", "vesiversot",
    "istutus", "istuttaa",
    "multa",
    "lannoitus",
  ];

  return avoidWords.some((word) => q.includes(word));
}

function addServiceQuestionIfNeeded(answer: string, question: string): string {
  let finalAnswer = String(answer || "");

  const askService =
    shouldAskJuKiPuuService(question) &&
    !shouldAvoidJuKiPuuService(question);

  if (askService && !finalAnswer.includes("Voisiko JuKiPuu auttaa")) {
    finalAnswer +=
      "\n\nVoisiko JuKiPuu auttaa tilanteen arvioinnissa paikan päällä?";
  }

  return finalAnswer;
}

async function readQuestion(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { question?: unknown };
    return String(body?.question || "").trim();
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

function extractSearchChunks(searchResults: any): any[] {
  const chunks =
    searchResults?.chunks ||
    searchResults?.result?.chunks ||
    searchResults?.data ||
    searchResults?.result?.data ||
    [];

  return Array.isArray(chunks) ? chunks : [];
}

async function getAiSearchContext(env: Env, question: string): Promise<string> {
  if (!env.PUU_SEARCH) return "";

  try {
    const searchResults = await env.PUU_SEARCH.search({
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

    const chunks = extractSearchChunks(searchResults);

    return chunks
      .map((c: any, i: number) => {
        const text = c.text || c.content || c.markdown || "";
        const source =
          c.source || c.filename || c.url || c.title || "AI Search";

        return `Lähde ${i + 1}: ${source}\n${text}`;
      })
      .filter((x: string) => x.trim().length > 0)
      .join("\n\n---\n\n");
  } catch (err) {
    console.error("PUU_SEARCH search error:", err);
    return "";
  }
}

async function askGpt(
  env: Env,
  question: string,
  aiSearchContext: string,
): Promise<string> {
  if (!env.CF_AIG_TOKEN) {
    throw new Error("CF_AIG_TOKEN puuttuu Worker Secretseistä.");
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
            `AI Search -taustatieto JuKiPuun sisällöistä:\n${aiSearchContext || "Ei lisätaustaa."}`,
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
    "GPT sai vastauksen, mutta sitä ei voitu purkaa näytettävään muotoon."
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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
        const cleanQuestion = await readQuestion(request);

        if (!cleanQuestion) {
          return json({ ok: false, error: "Kysymys puuttuu tai on tyhjä." }, 400);
        }

        if (!isPlantQuestion(cleanQuestion)) {
          return json({
            ok: true,
            app: "AI-puuopas",
            version: VERSION,
            question: cleanQuestion,
            answer:
              "🌳 Olen JuKiPuun AI-puuopas. Vastaan vain kasvikuntaan, puihin, pensaisiin, kasvien hoitoon, puunkaatoon ja arboristin työhön liittyviin kysymyksiin.",
            durationMs: Date.now() - started,
          });
        }

        const aiSearchContext = await getAiSearchContext(env, cleanQuestion);

        let rawAnswer = "";

        try {
          rawAnswer = await askGpt(env, cleanQuestion, aiSearchContext);
        } catch (err) {
          console.error("GPT Gateway error:", err);
          rawAnswer =
            "Löysin JuKiPuun aineistoa, mutta vastauksen muodostaminen GPT:n kautta epäonnistui juuri nyt. Kokeile hetken päästä uudelleen.";
        }

        const finalAnswer = addServiceQuestionIfNeeded(rawAnswer, cleanQuestion);

        return json({
          ok: true,
          app: "AI-puuopas",
          version: VERSION,
          model: GPT_MODEL,
          question: cleanQuestion,
          answer: finalAnswer,
          usedAiSearch: aiSearchContext.length > 0,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        console.error("ASK endpoint error:", err);

        const message = err instanceof Error ? err.message : String(err);

        return json(
          {
            ok: false,
            app: "AI-puuopas",
            version: VERSION,
            error: message,
            durationMs: Date.now() - started,
          },
          500,
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
