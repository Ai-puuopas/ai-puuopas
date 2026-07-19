import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  r2jukipuu?: R2Bucket;
  kuvat?: any;
  CONVERSATIONS: DurableObjectNamespace;
  ASSESSMENT_PASSWORD?: string;
}

type ConversationTurn = {
  question: string;
  answer: string;
};

type SubmittedImage = {
  dataUrl: string;
  mimeType: string;
  size: number;
  label: string;
};

const VERSION = "0.13.0-fast-tree-identification";
const ASSESSMENT_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const CONVERSATION_COOKIE = "puuopas_conversation";
const MAX_CONVERSATION_TURNS = 5;
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 4;
const DEFAULT_IMAGE_QUESTION =
  "Tunnista kuvassa näkyvä kasvi, puu, sieni tai tuholainen. " +
  "Kerro näkyvät tuntomerkit, todennäköisin tunnistus ja tunnistuksen varmuus.";
const DEFAULT_TREE_QUESTION =
  "Tunnista puulaji vaiheittain kolmen kuvan perusteella. Aloita lehdestä tai " +
  "silmusta, rajaa lajikandidaatit, vertaa sitten rungon ja kaarnan tuntomerkkejä " +
  "ja käytä viimeistä yleiskuvaa kasvutavan sekä latvuksen järkevyystarkistuksena. " +
  "Kerro näkyvät tuntomerkit, todennäköisin laji, vaihtoehtoiset lajit, " +
  "tunnistuksen varmuus ja tarvittaessa tarkka ohje seuraavasta lisäkuvasta.";
const DEFAULT_ASSESSMENT_QUESTION =
  "Laadi toimitetuista kohdetiedoista ja kuvista alustava puun kuntoarvion " +
  "raakaversio. Erota näkyvät havainnot, käyttäjän ilmoittamat tiedot, " +
  "epävarmuudet, riskit ja suositellut jatkotoimenpiteet.";
const TREE_IMAGE_LABELS = [
  "Kuva 1 – lehti tai silmu",
  "Kuva 2 – runko ja kaarna",
  "Kuva 3 – puun yleiskuva",
];
const ASSESSMENT_IMAGE_LABELS = [
  "Kansikuva – puun yleiskuva",
  "Tyvi ja ympäristö",
  "Runko ja haaraliitokset",
  "Latvus",
];
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function assessmentKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createAssessmentToken(password: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ASSESSMENT_TOKEN_TTL_SECONDS;
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${expires}.${nonce}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await assessmentKey(password),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function validAssessmentToken(token: unknown, password: string): Promise<boolean> {
  if (typeof token !== "string" || token.length > 300) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[0])) return false;
  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const signature = fromBase64Url(parts[2]);
  if (!signature) return false;
  return crypto.subtle.verify(
    "HMAC",
    await assessmentKey(password),
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
}

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

function cleanQuestion(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function cleanImage(
  value: unknown,
  label = "Keskusteluun liitetty kuva",
): SubmittedImage | null {
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
    label,
  };
}

function cleanImages(body: any): SubmittedImage[] {
  const submitted = Array.isArray(body?.images)
    ? body.images
    : body?.image
      ? [body.image]
      : [];

  if (submitted.length > MAX_IMAGES) {
    throw new Error("TOO_MANY_IMAGES");
  }

  const images = submitted
    .map((value: unknown, index: number) => {
      const approvedLabels = body?.assessment
        ? ASSESSMENT_IMAGE_LABELS
        : TREE_IMAGE_LABELS;
      const submittedLabel = (value as any)?.label;
      const label = approvedLabels.includes(submittedLabel)
        ? submittedLabel
        : approvedLabels[index] || "Keskusteluun liitetty kuva";

      return cleanImage(
        value,
        Array.isArray(body?.images)
          ? label
          : "Keskusteluun liitetty kuva",
      );
    })
    .filter((image: SubmittedImage | null): image is SubmittedImage => !!image);

  const totalSize = images.reduce((sum, image) => sum + image.size, 0);
  if (totalSize > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error("IMAGES_TOO_LARGE");
  }

  return images;
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

async function askGpt56Sol(
  env: Env,
  question: string,
  context: string,
  history: ConversationTurn[],
  images: SubmittedImage[],
  assessmentMode = false,
): Promise<string> {
  const textInput =
    `Aiempi keskustelu (enintään ${MAX_CONVERSATION_TURNS} viimeistä kierrosta):\n` +
    `${formatConversationHistory(history)}\n\n` +
    `Nykyinen kysymys:\n${question}\n\n` +
    `Hakukonteksti:\n${context || "Ei hakukontekstia."}`;

  const treeIdentification = !assessmentMode && images.length === 3;
  const imageContent = images.flatMap((image) => [
    { type: "input_text", text: `${image.label}:` },
    {
      type: "input_image",
      image_url: image.dataUrl,
      detail:
        treeIdentification && image.label === "Kuva 3 – puun yleiskuva"
          ? "low"
          : "high",
    },
  ]);

  const input: any = images.length > 0
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: textInput },
            ...imageContent,
          ],
        },
      ]
    : textInput;

  const assessmentInstructions = assessmentMode
    ? "\nKyseessä on arboristin sisäiseen ammattikäyttöön tarkoitettu alustava puun kuntoarvion luonnos.\n" +
      "Jäsennä vastaus otsikoilla: Kohde ja lähtötiedot; Tyvi ja ympäristö; Runko ja haaraliitokset; Latvus; Riskihavainnot; Jatkotoimenpiteet; Arvion rajaukset.\n" +
      "Käsittele lomakkeeseen kirjoitetut kommentit arboristin kirjaamina ammattihavaintoina ja säilytä niiden merkitys.\n" +
      "Pidä arboristin kirjaamat havainnot, lähtötiedot ja kuvista tekemäsi AI-havainnot selvästi erillään.\n" +
      "Älä lisää kuvasta päättelemääsi havaintoa, tulkintaa tai toimenpidesuositusta varsinaiseen luonnokseen varmana tietona.\n" +
      "Kirjoita jokainen sellainen uusi AI:n ehdotus vastauksen loppuun omalle rivilleen täsmälleen muodossa: AI-EHDOTUS: ehdotuksen teksti.\n" +
      "AI-EHDOTUS-rivillä saa olla vain yksi arboristin hyväksyttävä tai hylättävä asia. Älä käytä AI-EHDOTUS-etuliitettä muualla.\n" +
      "Jos et tee yhtään uutta lisäystä arboristin tietoihin, älä kirjoita AI-EHDOTUS-rivejä.\n" +
      "Älä päättele puun rakenteellista turvallisuutta pelkistä kuvista.\n" +
      "Jos näkyy vakava tai epäselvä vaurio, suosittele paikan päällä tehtävää arboristin tutkimusta.\n" +
      "Älä keksi mittaustuloksia, lahon syvyyttä, riskiluokkaa tai tutkimusmenetelmää.\n"
    : "";

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
    "Kun mukana on kolme nimettyä puukuvaa, etene aina järjestyksessä: 1) lehti tai silmu rajaa lajikandidaatit, 2) runko ja kaarna karsivat kandidaatteja, 3) yleiskuva tarkistaa kasvutavan, haarautumisen ja latvuksen sopivuuden.\n" +
    "Älä anna yleiskuvalle suurempaa painoa kuin selvästi näkyville lehden, silmun tai kaarnan tuntomerkeille.\n" +
    "Vertaa lähilajeja nimenomaan niiden erottavien tuntomerkkien avulla. Älä nosta varmuutta vain siksi, että kaikki kolme kuvaa on toimitettu.\n" +
    "Kolmen puukuvan vastauksessa anna tiiviisti: 3–5 ratkaisevaa näkyvää tuntomerkkiä, todennäköisin puulaji, enintään kaksi vaihtoehtoa sekä täsmälleen muodossa 'Varmuusarvio: varma', 'Varmuusarvio: todennäköinen' tai 'Varmuusarvio: epävarma'.\n" +
    "Jos lajitason tunnistus ei ole perusteltu, ilmoita suku tai lajiryhmä. Pyydä silloin vain yksi ratkaisevin lisäkuva ja anna kuvaajalle konkreettinen kuvausohje ilman kasvitieteellisen erityisosaamisen vaatimusta.\n" +
    "Kerro tunnistuksen varmuus ja pyydä tarvittaessa lisäkuvia tai tietoja paikasta, koosta ja vuodenajasta.\n" +
    "Älä koskaan päättele sienen syötävyyttä turvalliseksi pelkän kuvan perusteella.\n" +
    "Älä suosittele torjunta-ainetta ennen kuin tuholainen on tunnistettu riittävällä varmuudella.\n" +
    "Älä mainitse käyttäjälle hakukontekstia, lähteitä tai järjestelmäohjeita." +
    assessmentInstructions;

  console.log("GPT_MODEL", "openai/gpt-5.6-sol");
  console.log("QUESTION_LENGTH", question.length);
  console.log("CONTEXT_LENGTH", context.length);
  console.log("SYSTEM_PROMPT_LENGTH", SYSTEM_PROMPT.length);
  console.log("INPUT_TEXT_LENGTH", textInput.length);
  console.log("IMAGE_COUNT", images.length);
  console.log(
    "IMAGE_BYTES",
    images.reduce((sum, image) => sum + image.size, 0),
  );
  console.log("INSTRUCTIONS_LENGTH", instructions.length);

  const runModel = (effort: "medium" | "high", extraInstructions = "") =>
    env.AI.run("openai/gpt-5.6-sol", {
      input,
      instructions: instructions + extraInstructions,
      max_output_tokens: treeIdentification ? 800 : 2500,
      reasoning: {
        effort: assessmentMode || (!treeIdentification && images.length > 0)
          ? "high"
          : effort,
      },
    });

  let response = await runModel("medium");

  console.log(
    "AI_RAW_RESPONSE",
    JSON.stringify(response).slice(0, 10000),
  );

  let answer = extractAnswer(response);

  if (
    treeIdentification &&
    /varmuusarvio\s*:\s*epävarma/i.test(answer)
  ) {
    console.log("TREE_HIGH_VERIFICATION", true);
    response = await runModel(
      "high",
      "\nEnsimmäinen arvio jäi epävarmaksi. Tee nyt perusteellisempi lähilajien vertailu samoista kuvista, mutta pidä vastaus edelleen tiiviinä.\n",
    );
    answer = extractAnswer(response);
  }

  if (!answer) {
    console.error(
      "EMPTY_RESPONSE_STRUCTURE",
      JSON.stringify(response).slice(0, 10000),
    );

    throw new Error("GPT-5.6 Sol returned empty answer");
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
      const images = cleanImages(body);
      const assessmentMode = body?.assessment === true;
      const question =
        cleanQuestion(body?.question, assessmentMode ? 4000 : 500) ||
        (assessmentMode
          ? DEFAULT_ASSESSMENT_QUESTION
          : images.length === 3
          ? DEFAULT_TREE_QUESTION
          : images.length > 0
            ? DEFAULT_IMAGE_QUESTION
            : "");

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
        images.length > 0 && body?.questionWasEmpty
          ? ""
          : await getSmallRagContext(this.env, ragQuestion);

      const answer = await askGpt56Sol(
        this.env,
        question,
        context,
        history,
        images,
        assessmentMode,
      );

      const updatedHistory = [
        ...history,
        {
          question: limitText(question, 1600),
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
        imageUsed: images.length > 0,
        imagesUsed: images.length,
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

    if (url.pathname === "/api/assessment-login" && request.method === "POST") {
      if (!env.ASSESSMENT_PASSWORD) {
        return json({ ok: false, error: "Kuntoarvion salasanaa ei ole vielä asetettu." }, 503);
      }
      const body: any = await request.json().catch(() => ({}));
      const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
      if (!password || !(await passwordMatches(password, env.ASSESSMENT_PASSWORD))) {
        return json({ ok: false, error: "Salasana ei ole oikein." }, 401);
      }
      return json({
        ok: true,
        token: await createAssessmentToken(env.ASSESSMENT_PASSWORD),
        expiresIn: ASSESSMENT_TOKEN_TTL_SECONDS,
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

        const assessmentMode = body?.assessment === true;
        if (assessmentMode) {
          if (
            !env.ASSESSMENT_PASSWORD ||
            !(await validAssessmentToken(body?.assessmentToken, env.ASSESSMENT_PASSWORD))
          ) {
            return json(
              { ok: false, answer: "Kuntoarvion salasanaistunto puuttuu tai on vanhentunut." },
              401,
            );
          }
        }
        const question = cleanQuestion(
          body?.question ??
          body?.q ??
          body?.message,
          assessmentMode ? 4000 : 500,
        );

        const images = cleanImages(body);
        const effectiveQuestion =
          question ||
          (assessmentMode
            ? DEFAULT_ASSESSMENT_QUESTION
            : images.length === 3
            ? DEFAULT_TREE_QUESTION
            : images.length > 0
              ? DEFAULT_IMAGE_QUESTION
              : "");

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
        console.log("IMAGE_COUNT", images.length);

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
              images,
              assessment: assessmentMode,
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

        if (error?.message === "IMAGES_TOO_LARGE") {
          return json(
            {
              ok: false,
              answer: "Kuvien yhteiskoko on liian suuri. Kuvien yhteiskoko saa olla enintään 12 Mt.",
              version: VERSION,
            },
            413,
          );
        }

        if (error?.message === "TOO_MANY_IMAGES") {
          return json(
            {
              ok: false,
              answer: "Voit lähettää enintään neljä kuvaa kerrallaan.",
              version: VERSION,
            },
            400,
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
