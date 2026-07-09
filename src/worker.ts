import { SYSTEM_PROMPT } from "./prompt.js";

export interface Env {
  ASSETS: Fetcher;
  PUU_SEARCH?: any;
  AI?: any;
  DB?: any;
  tyoskentelu?: any;
  CF_AIG_TOKEN?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://jukipuu.fi",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const VERSION = "0.4.6-gpt-gateway-rag";

const AI_GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/c929d499c01584b02d13721d801e78ff/default/openai/chat/completions";

const GPT_MODEL = "gpt-5.5";
// Jos haluat kokeilla myöhemmin:
// const GPT_MODEL = "gpt-4o-mini";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function normalize(text: unknown) {
  return String(text || "").toLowerCase().trim();
}

function isPlantQuestion(question: string) {
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
    "istutus", "istuttaa", "multa", "lannoitus"
  ];

  return allowedWords.some((word) => q.includes(word));
}

function shouldAskJuKiPuuService(question: string) {
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
    "mitä maksaa", "hinta", "paljon maksaa", "tarjous"
  ];

  return serviceIntentWords.some((word) => q.includes(word));
}

function shouldAvoidJuKiPuuService(question: string) {
  const q = normalize(question);

  const avoidWords = [
    "juurenniska",
    "vesiverso", "vesiversot",
    "istutus", "istuttaa",
    "multa",
    "lannoitus"
  ];

  return avoidWords.some((word) => q.includes(word));
}

function extractAnswer(aiSearchResponse: any) {
  return (
    aiSearchResponse?.response ||
    aiSearchResponse?.answer ||
    aiSearchResponse?.choices?.[0]?.message?.content ||
    aiSearchResponse?.result?.response ||
    aiSearchResponse?.result?.answer ||
    ""
  );
}

function addServiceQuestionIfNeeded(answer: string, question: string) {
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

async function readQuestion(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body: any = await request.json();
    return String(body?.question || "").trim();
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return String(formData.get("question") || "").trim();
  }

  try {
    const body: any = await request.json();
    return String(body?.question || "").trim();
  } catch {
    return "";
  }
}

async function askGpt(env: Env, question: string, aiSearchContext: string) {
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
            "\n\nKäytä alla olevaa AI Search -taustatietoa apuna, mutta älä väitä tietäväsi enempää kuin tiedät. Vastaa suomeksi.",
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

  const data: any = await response.json();

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
          workersAI: !!env.AI,
          aiSearch: !!env.PUU_SEARCH,
          assets: !!env.ASSETS,
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

let aiSearchContext = "";

if (env.PUU_SEARCH) {
  try {
    const searchResults = await env.PUU_SEARCH.search({
      query: cleanQuestion,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: 6,
          match_threshold: 0.35,
          context_expansion: 1
        }
      }
    });

    const chunks = searchResults?.chunks ?? [];

    aiSearchContext = chunks
      .map((c: any, i: number) => {
        const text = c.text || c.content || "";
        const source = c.source || c.filename || c.url || "AI Search";
        return `Lähde ${i + 1}: ${source}\n${text}`;
      })
        .join("\n\n---\n\n");
  } catch (err) {
    console.error("PUU_SEARCH search error:", err);
    aiSearchContext = "";
  }
}

let rawAnswer: string;

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
  durationMs: Date.now() - started,
});
