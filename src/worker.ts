import { SYSTEM_PROMPT } from "./prompt.js";

export interface Env {
  ASSETS: Fetcher;
  PUU_SEARCH?: any;
  AI?: any;
  DB?: any;
  tyoskentelu?: any;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://jukipuu.fi",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const VERSION = "0.4.5-github-clean";

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
    "AI-puuopas sai vastauksen, mutta sitä ei voitu vielä purkaa näytettävään muotoon."
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

        if (!env.PUU_SEARCH) {
          return json(
            {
              ok: false,
              error: "AI Search -binding PUU_SEARCH puuttuu.",
              version: VERSION,
            },
            500
          );
        }

        let aiSearchResponse: any;

        try {
          aiSearchResponse = await env.PUU_SEARCH.chatCompletions({
            messages: [
              {
                role: "system",
                content: SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: cleanQuestion,
              },
            ],
          });
        } catch (err) {
          console.error("PUU_SEARCH error:", err);

          const fallbackAnswer =
            "En ole täysin varma vastauksesta juuri nyt. Jos kyse on käävästä, puun vauriosta, sähkölinjoista, rakennuksen lähellä olevasta puusta tai muusta riskistä, tilanne kannattaa arvioida paikan päällä.";

          return json({
            ok: true,
            app: "AI-puuopas",
            version: VERSION,
            question: cleanQuestion,
            answer: addServiceQuestionIfNeeded(fallbackAnswer, cleanQuestion),
            durationMs: Date.now() - started,
          });
        }

        const rawAnswer = extractAnswer(aiSearchResponse);
        const finalAnswer = addServiceQuestionIfNeeded(rawAnswer, cleanQuestion);

        return json({
          ok: true,
          app: "AI-puuopas",
          version: VERSION,
          question: cleanQuestion,
          answer: finalAnswer,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        console.error("Worker error:", err);

        return json(
          {
            ok: false,
            error: "AI-puuopas ei saanut AI Search -vastausta juuri nyt.",
            detail: String(err),
            version: VERSION,
          },
          500
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
