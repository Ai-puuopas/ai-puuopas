import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  r2jukipuu?: R2Bucket;
  kuvat?: any;
  CONVERSATIONS: DurableObjectNamespace;
  ANALYTICS_JUKIPUU?: any;
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

type RagResult = {
  context: string;
  durationMs: number;
  matchCount: number;
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};

type ModelResult = {
  answer: string;
  firstPassMs: number;
  verificationMs: number;
  verified: boolean;
  usage: ModelUsage;
};

type PerformanceMetrics = {
  mode: string;
  streamed: boolean;
  totalMs: number;
  memoryReadMs: number;
  ragMs: number;
  firstPassMs: number;
  verificationMs: number;
  memoryWriteMs: number;
  imageBytes: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  verified: boolean;
};

const VERSION = "0.14.0-streaming-and-observability";
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
  "Access-Control-Expose-Headers": "Server-Timing, X-Conversation-Id, X-AI-Puuopas-Version",
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

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractUsage(response: any): ModelUsage {
  const usage = response?.usage ?? response?.result?.usage ?? {};
  const inputDetails = usage?.input_tokens_details ?? {};
  const outputDetails = usage?.output_tokens_details ?? {};

  return {
    inputTokens: numberValue(usage?.input_tokens),
    outputTokens: numberValue(usage?.output_tokens),
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens),
    cachedTokens: numberValue(inputDetails?.cached_tokens),
  };
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}

function requestMode(assessmentMode: boolean, images: SubmittedImage[]): string {
  if (assessmentMode) return "assessment";
  if (images.length === 3) return "tree-identification";
  if (images.length > 0) return "single-image";
  return "text";
}

function serverTiming(metrics: Partial<PerformanceMetrics>): string {
  const timings: Array<[string, number | undefined]> = [
    ["memory-read", metrics.memoryReadMs],
    ["rag", metrics.ragMs],
    ["model", metrics.firstPassMs],
    ["verification", metrics.verificationMs],
    ["memory-write", metrics.memoryWriteMs],
    ["total", metrics.totalMs],
  ];

  return timings
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, duration]) => `${name};dur=${Math.max(0, Math.round(duration))}`)
    .join(", ");
}

function recordPerformance(env: Env, metrics: PerformanceMetrics): void {
  console.log("PERFORMANCE_METRICS", JSON.stringify(metrics));

  try {
    env.ANALYTICS_JUKIPUU?.writeDataPoint({
      blobs: [VERSION, metrics.mode, metrics.streamed ? "stream" : "json"],
      doubles: [
        metrics.totalMs,
        metrics.memoryReadMs,
        metrics.ragMs,
        metrics.firstPassMs,
        metrics.verificationMs,
        metrics.memoryWriteMs,
        metrics.imageBytes,
        metrics.inputTokens,
        metrics.outputTokens,
        metrics.reasoningTokens,
        metrics.cachedTokens,
        metrics.verified ? 1 : 0,
      ],
      indexes: [metrics.mode],
    });
  } catch (error: any) {
    console.warn("ANALYTICS_WRITE_ERROR", error?.message || error);
  }
}

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
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

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function parseAskBody(request: Request): Promise<any> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return request.json().catch(() => ({}));
  }

  const form = await request.formData();
  const metadataText = form.get("metadata");
  const body = typeof metadataText === "string"
    ? JSON.parse(metadataText)
    : {};
  const descriptors = Array.isArray(body?.imageDescriptors)
    ? body.imageDescriptors
    : [];
  const images: any[] = [];
  let totalSize = 0;

  for (const descriptor of descriptors.slice(0, MAX_IMAGES)) {
    const index = Number(descriptor?.index);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) continue;
    const value: any = form.get(`image-${index}`);
    if (!value || typeof value.arrayBuffer !== "function") continue;

    const size = numberValue(value.size);
    if (size <= 0 || size > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    totalSize += size;
    if (totalSize > MAX_TOTAL_IMAGE_BYTES) throw new Error("IMAGES_TOO_LARGE");

    const mimeType = typeof value.type === "string" ? value.type : "";
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) throw new Error("UNSUPPORTED_IMAGE");
    images[index] = {
      dataUrl: `data:${mimeType};base64,${bufferToBase64(await value.arrayBuffer())}`,
      mimeType,
      label: descriptor?.label,
    };
  }

  delete body.imageDescriptors;
  if (body?.imageMode === "single") {
    body.image = images.find(Boolean) ?? null;
  } else {
    body.images = images;
  }
  delete body.imageMode;
  return body;
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

function readableModelStream(response: any): ReadableStream<Uint8Array> | null {
  if (response instanceof Response) return response.body;
  if (response?.body && typeof response.body.getReader === "function") {
    return response.body;
  }
  if (response && typeof response.getReader === "function") return response;
  return null;
}

function streamedDelta(payload: any): string {
  if (
    payload?.type === "response.output_text.delta" &&
    typeof payload?.delta === "string"
  ) {
    return payload.delta;
  }

  if (typeof payload?.response === "string") return payload.response;

  const chatDelta = payload?.choices?.[0]?.delta?.content;
  return typeof chatDelta === "string" ? chatDelta : "";
}

async function consumeModelStream(
  response: any,
  onDelta: (delta: string) => void,
): Promise<{ answer: string; usage: ModelUsage }> {
  const stream = readableModelStream(response);
  if (!stream) {
    const answer = extractAnswer(response);
    if (answer) onDelta(answer);
    return { answer, usage: extractUsage(response) };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let completedAnswer = "";
  let usage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };

  const processEvent = (eventText: string) => {
    const dataText = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!dataText || dataText === "[DONE]") return;

    try {
      const payload = JSON.parse(dataText);
      const delta = streamedDelta(payload);
      if (delta) {
        answer += delta;
        onDelta(delta);
      }

      if (payload?.type === "response.completed") {
        completedAnswer = extractAnswer(payload?.response);
        usage = extractUsage(payload?.response);
      }
    } catch {
      // Unknown SSE metadata is ignored; the completed response remains authoritative.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const eventText = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      processEvent(eventText);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer);

  if (!answer && completedAnswer) {
    answer = completedAnswer;
    onDelta(answer);
  }

  return { answer: answer || completedAnswer, usage };
}

async function getSmallRagContext(
  env: Env,
  question: string,
): Promise<RagResult> {
  const startedAt = Date.now();

  if (!env.PUU_SEARCH) {
    console.warn("RAG_SEARCH_SKIPPED", "PUU_SEARCH binding missing");
    return { context: "", durationMs: 0, matchCount: 0 };
  }

  try {
    const result = await env.PUU_SEARCH.search({
      query: question,
      ai_search_options: {
        retrieval: {
          max_num_results: 3,
        },
        cache: {
          enabled: true,
          cache_threshold: "super_strict_match",
        },
      },
    });

    const matches =
      (Array.isArray(result?.chunks) && result.chunks) ||
      (Array.isArray(result?.matches) && result.matches) ||
      (Array.isArray(result?.result?.chunks) && result.result.chunks) ||
      (Array.isArray(result?.result?.matches) && result.result.matches) ||
      [];

    const contextParts = matches
      .slice(0, 3)
      .map((item: any, index: number) => {
        const title =
          item?.metadata?.title ??
          item?.metadata?.source ??
          item?.item?.metadata?.title ??
          item?.item?.key ??
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

    return {
      context,
      durationMs: elapsedMs(startedAt),
      matchCount: matches.length,
    };
  } catch (error: any) {
    console.error(
      "RAG_SEARCH_ERROR",
      error?.message || error,
    );

    console.error(
      "RAG_SEARCH_STACK",
      error?.stack || "",
    );

    return {
      context: "",
      durationMs: elapsedMs(startedAt),
      matchCount: 0,
    };
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
  sessionAffinity = "",
  onVerification?: () => void,
  onDelta?: (delta: string) => void,
): Promise<ModelResult> {
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
    "Kun mukana on kolme nimettyä puukuvaa, jäsennä vastaus järjestyksessä: 1) Lehden tai silmun näkyvät havainnot, 2) Rungon ja kaarnan näkyvät havainnot, 3) Yleiskuvan järkevyystarkistus, 4) Kokonaispäätelmä.\n" +
    "Rajaa lajikandidaatit lehden tai silmun perusteella, karsi niitä rungon ja kaarnan tuntomerkeillä ja käytä yleiskuvaa vain kasvutavan, haarautumisen ja latvuksen sopivuuden tarkistamiseen.\n" +
    "Älä anna yleiskuvalle suurempaa painoa kuin selvästi näkyville lehden, silmun tai kaarnan tuntomerkeille.\n" +
    "Vertaa lähilajeja nimenomaan niiden erottavien tuntomerkkien avulla. Älä nosta varmuutta vain siksi, että kaikki kolme kuvaa on toimitettu.\n" +
    "Jos kuvien tuntomerkit ovat keskenään ristiriidassa, kerro että kuvat saattavat olla eri puuyksilöistä äläkä tee väkisin yhtä lajitunnistusta.\n" +
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

  const runModel = (
    effort: "medium" | "high",
    firstAnswer = "",
    stream = false,
  ) => {
    const modelInput = firstAnswer && Array.isArray(input)
      ? [
          ...input,
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Ensimmäinen arvio jäi epävarmaksi. Arvioi se kriittisesti ja " +
                  "tee perusteellisempi lähilajien vertailu samoista kuvista. " +
                  "Pidä vastaus edelleen tiiviinä. Ensimmäinen arvio oli:\n" +
                  firstAnswer,
              },
            ],
          },
        ]
      : input;

    return env.AI.run(
      "openai/gpt-5.6-sol",
      {
        input: modelInput,
        instructions,
        max_output_tokens: treeIdentification ? 800 : 2500,
        reasoning: {
          effort: assessmentMode || (!treeIdentification && images.length > 0)
            ? "high"
            : effort,
        },
        ...(stream ? { stream: true } : {}),
      },
      sessionAffinity
        ? {
            extraHeaders: {
              "x-session-affinity": sessionAffinity,
            },
          }
        : undefined,
    );
  };

  const firstStartedAt = Date.now();
  const shouldStreamFirstPass = !!onDelta && !treeIdentification;
  let response = await runModel("medium", "", shouldStreamFirstPass);
  let streamed: { answer: string; usage: ModelUsage } | null = null;

  if (shouldStreamFirstPass) {
    streamed = await consumeModelStream(response, onDelta!);
  }

  const firstPassMs = elapsedMs(firstStartedAt);

  let answer = streamed?.answer || extractAnswer(response);
  let usage = streamed?.usage || extractUsage(response);
  let verificationMs = 0;
  let verified = false;

  if (
    treeIdentification &&
    /varmuusarvio\s*:\s*epävarma/i.test(answer)
  ) {
    console.log("TREE_HIGH_VERIFICATION", true);
    verified = true;
    onVerification?.();
    const verificationStartedAt = Date.now();
    response = await runModel("high", answer);
    verificationMs = elapsedMs(verificationStartedAt);
    answer = extractAnswer(response);
    usage = addUsage(usage, extractUsage(response));
  }

  if (onDelta && treeIdentification && answer) onDelta(answer);

  if (!answer) {
    console.error(
      "EMPTY_RESPONSE_STRUCTURE",
      JSON.stringify(Object.keys(response ?? {})).slice(0, 1000),
    );

    throw new Error("GPT-5.6 Sol returned empty answer");
  }

  console.log("ANSWER_LENGTH", answer.length);
  console.log("MODEL_USAGE", JSON.stringify(usage));

  return {
    answer,
    firstPassMs,
    verificationMs,
    verified,
    usage,
  };
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
      const url = new URL(request.url);

      const storedHistory =
        (await this.state.storage.get<ConversationTurn[]>(
          "history",
        )) ?? [];
      const history = storedHistory.slice(
        -MAX_CONVERSATION_TURNS,
      );

      if (request.method === "GET" && url.pathname === "/history") {
        return json({ ok: true, history });
      }

      if (request.method !== "POST" || url.pathname !== "/history") {
        return json({ ok: false, error: "Tuntematon muistipyyntö." }, 404);
      }

      const body: any = await request.json().catch(() => ({}));
      const question = cleanQuestion(body?.question, 4000);
      const answer = limitText(body?.answer, 6000);

      if (!question || !answer) {
        return json({ ok: false, error: "Muistimerkintä on puutteellinen." }, 400);
      }

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
        historySize: updatedHistory.length,
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

async function readConversationHistory(
  memory: DurableObjectStub,
): Promise<ConversationTurn[]> {
  const response = await memory.fetch("https://conversation-memory/history", {
    method: "GET",
  });
  const data: any = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok || !Array.isArray(data?.history)) {
    throw new Error(data?.debug || "Conversation history could not be read");
  }

  return data.history.slice(-MAX_CONVERSATION_TURNS);
}

async function appendConversationHistory(
  memory: DurableObjectStub,
  question: string,
  answer: string,
): Promise<number> {
  const response = await memory.fetch("https://conversation-memory/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, answer }),
  });
  const data: any = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(data?.debug || "Conversation history could not be saved");
  }

  return numberValue(data?.historySize);
}

function createPerformanceMetrics(
  mode: string,
  streamed: boolean,
  requestStartedAt: number,
  memoryReadMs: number,
  ragMs: number,
  memoryWriteMs: number,
  imageBytes: number,
  model: ModelResult,
): PerformanceMetrics {
  return {
    mode,
    streamed,
    totalMs: elapsedMs(requestStartedAt),
    memoryReadMs,
    ragMs,
    firstPassMs: model.firstPassMs,
    verificationMs: model.verificationMs,
    memoryWriteMs,
    imageBytes,
    inputTokens: model.usage.inputTokens,
    outputTokens: model.usage.outputTokens,
    reasoningTokens: model.usage.reasoningTokens,
    cachedTokens: model.usage.cachedTokens,
    verified: model.verified,
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
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
      const requestStartedAt = Date.now();
      try {
        const body: any = await parseAskBody(request);

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

        console.log("QUESTION_LENGTH", effectiveQuestion.length);
        console.log("IMAGE_COUNT", images.length);

        const conversationId =
          cleanConversationId(body?.conversationId) ||
          getConversationId(request);
        const objectId =
          env.CONVERSATIONS.idFromName(conversationId);
        const memory = env.CONVERSATIONS.get(objectId);

        const memoryReadStartedAt = Date.now();
        const history = await readConversationHistory(memory);
        const memoryReadMs = elapsedMs(memoryReadStartedAt);

        const ragQuestion = [
          ...history.slice(-2).map((turn) => turn.question),
          effectiveQuestion,
        ].join("\n");
        const rag = images.length > 0 && !question
          ? { context: "", durationMs: 0, matchCount: 0 }
          : await getSmallRagContext(env, ragQuestion);

        const mode = requestMode(assessmentMode, images);
        const imageBytes = images.reduce((sum, image) => sum + image.size, 0);
        const wantsStream = request.headers
          .get("Accept")
          ?.includes("text/event-stream") === true;

        if (wantsStream) {
          let clientClosed = false;
          const responseStream = new ReadableStream<Uint8Array>({
            start(controller) {
              const emit = (event: string, data: unknown) => {
                if (clientClosed) return;
                try {
                  controller.enqueue(sseEvent(event, data));
                } catch {
                  clientClosed = true;
                }
              };

              emit("phase", { message: "Muodostan vastausta..." });

              const work = (async () => {
                try {
                  const model = await askGpt56Sol(
                    env,
                    effectiveQuestion,
                    rag.context,
                    history,
                    images,
                    assessmentMode,
                    conversationId,
                    () => emit("phase", {
                      message: "Epävarma tunnistus tarkistetaan perusteellisemmin...",
                    }),
                    (delta) => emit("delta", { delta }),
                  );

                  const memoryWriteStartedAt = Date.now();
                  let historySize = history.length;
                  try {
                    historySize = await appendConversationHistory(
                      memory,
                      effectiveQuestion,
                      model.answer,
                    );
                  } catch (error: any) {
                    console.error("MEMORY_WRITE_ERROR", error?.message || error);
                  }
                  const memoryWriteMs = elapsedMs(memoryWriteStartedAt);
                  const metrics = createPerformanceMetrics(
                    mode,
                    true,
                    requestStartedAt,
                    memoryReadMs,
                    rag.durationMs,
                    memoryWriteMs,
                    imageBytes,
                    model,
                  );
                  recordPerformance(env, metrics);

                  emit("done", {
                    ok: true,
                    conversationId,
                    version: VERSION,
                    imageUsed: images.length > 0,
                    imagesUsed: images.length,
                    historySize,
                    rag: {
                      used: rag.context.length > 0,
                      contextLength: rag.context.length,
                      matchCount: rag.matchCount,
                    },
                    performance: metrics,
                  });
                } catch (error: any) {
                  console.error("ASK_STREAM_ERROR", error?.message || error);
                  emit("error", {
                    message:
                      "AI-puuopas ei saanut vastausta juuri nyt. " +
                      "Kokeile hetken kuluttua uudelleen.",
                  });
                } finally {
                  if (!clientClosed) controller.close();
                }
              })();

              ctx.waitUntil(work);
            },
            cancel() {
              clientClosed = true;
            },
          });

          return new Response(responseStream, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Conversation-Id": conversationId,
              "X-AI-Puuopas-Version": VERSION,
              "Server-Timing": serverTiming({
                memoryReadMs,
                ragMs: rag.durationMs,
              }),
              "Set-Cookie": conversationCookie(conversationId),
            },
          });
        }

        const model = await askGpt56Sol(
          env,
          effectiveQuestion,
          rag.context,
          history,
          images,
          assessmentMode,
          conversationId,
        );
        const memoryWriteStartedAt = Date.now();
        let historySize = history.length;
        try {
          historySize = await appendConversationHistory(
            memory,
            effectiveQuestion,
            model.answer,
          );
        } catch (error: any) {
          console.error("MEMORY_WRITE_ERROR", error?.message || error);
        }
        const memoryWriteMs = elapsedMs(memoryWriteStartedAt);
        const metrics = createPerformanceMetrics(
          mode,
          false,
          requestStartedAt,
          memoryReadMs,
          rag.durationMs,
          memoryWriteMs,
          imageBytes,
          model,
        );
        recordPerformance(env, metrics);

        return json(
          {
            ok: true,
            answer: model.answer,
            imageUsed: images.length > 0,
            imagesUsed: images.length,
            historySize,
            rag: {
              used: rag.context.length > 0,
              contextLength: rag.context.length,
              matchCount: rag.matchCount,
            },
            performance: metrics,
            conversationId,
            version: VERSION,
          },
          200,
          {
            "Server-Timing": serverTiming(metrics),
            "X-Conversation-Id": conversationId,
            "X-AI-Puuopas-Version": VERSION,
            "Set-Cookie": conversationCookie(conversationId),
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
