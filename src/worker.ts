import { SYSTEM_PROMPT } from "./prompt";
import {
  answerNeedsRepair,
  createSafeAnswerStream,
  extractFinalAnswer,
  finalOutputDelta,
} from "./answer-safety";

export interface Env {
  ASSETS: Fetcher;
  AI: any;
  PUU_SEARCH?: any;
  CONVERSATIONS: DurableObjectNamespace;
  ANALYTICS_JUKIPUU?: any;
  ASSESSMENT_PASSWORD?: string;
  ASK_RATE_LIMITER?: RateLimitBinding;
  ASSESSMENT_RATE_LIMITER?: RateLimitBinding;
}

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type ConversationTurn = {
  question: string;
  answer: string;
  createdAt?: string;
  imageLabels?: string[];
  speciesProfile?: SpeciesProfile | null;
};

type SpeciesProfile = {
  commonName: string;
  scientificName: string;
  confidence: string;
  characteristics: string[];
};

type ConversationState = {
  schemaVersion: 2;
  history: ConversationTurn[];
  summary: string;
  activeSpecies: SpeciesProfile | null;
  followUpQuestion: string;
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
  model: string;
  firstPassMs: number;
  verificationMs: number;
  verified: boolean;
  usage: ModelUsage;
};

type StreamedModelResult = {
  answer: string;
  usage: ModelUsage;
  unsafe: boolean;
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

const VERSION = "0.17.0-astra-memory";
const PRIMARY_MODEL = "openai/gpt-6-astra";
const FALLBACK_MODEL = "openai/gpt-5.6-sol";
const ASTRA_RETRY_DELAY_MS = 10 * 60 * 1000;
let astraUnavailableUntil = 0;
const SITE_LAUNCH_HOSTS = new Set(["jukipuu.fi", "www.jukipuu.fi"]);
const SITE_LAUNCH_PATH = "/ai-puuopas/public";
const LEGACY_WORKERS_DEV_HOST = "ai-puuopas.jukipuu-fi.workers.dev";
const CANONICAL_APP_URL = "https://jukipuu.fi/ai-puuopas/public/";
const ASSESSMENT_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const CONVERSATION_COOKIE = "puuopas_conversation";
const MAX_CONVERSATION_TURNS = 8;
const MAX_CONVERSATION_SUMMARY_LENGTH = 2800;
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
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Expose-Headers": "Server-Timing, X-Conversation-Id, X-AI-Puuopas-Version",
};

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self' https://jukipuu.fi; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), geolocation=(self), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
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
      ...securityHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function clientRateLimitKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "anonymous";
  return `${scope}:${forwarded}`;
}

async function rateLimitResponse(
  request: Request,
  binding: RateLimitBinding | undefined,
  scope: string,
): Promise<Response | null> {
  if (!binding) return null;

  try {
    const result = await binding.limit({
      key: clientRateLimitKey(request, scope),
    });
    if (result.success) return null;

    console.warn("RATE_LIMITED", scope);
    return json(
      {
        ok: false,
        error: "Pyyntöjä tuli liian nopeasti. Odota hetki ja yritä uudelleen.",
        version: VERSION,
      },
      429,
      { "Retry-After": "60" },
    );
  } catch (error: any) {
    console.warn("RATE_LIMIT_CHECK_ERROR", scope, error?.message || error);
    return null;
  }
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

function limitMultilineText(value: unknown, max = 6000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

function limitTailText(value: unknown, max = 700): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  const tail = compact.slice(-max);
  const sentenceStart = tail.search(/(?:[.!?]\s+|Käyttäjä:\s+)/);
  return (sentenceStart >= 0 ? tail.slice(sentenceStart + 1) : tail).trim();
}

function emptyConversationState(): ConversationState {
  return {
    schemaVersion: 2,
    history: [],
    summary: "",
    activeSpecies: null,
    followUpQuestion: "",
  };
}

function cleanMetadataText(value: unknown, max = 180): string {
  return limitText(value, max)
    .replace(/^[-*•#\s]+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function extractFollowUpQuestion(answer: string): string {
  const match = answer.match(
    /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?Jatkokysymys(?:\*\*)?\s*:\s*([^\n]+)/i,
  );
  return cleanMetadataText(match?.[1], 320);
}

function extractSpeciesProfile(answer: string): SpeciesProfile | null {
  const field = (labels: string[]) => {
    const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(
      `(?:^|\\n)\\s*(?:[-*•]\\s*)?(?:\\*\\*)?(?:${escaped.join("|")})(?:\\*\\*)?\\s*:\\s*([^\\n]+)`,
      "i",
    );
    return cleanMetadataText(answer.match(pattern)?.[1], 180);
  };

  const commonName = field([
    "Todennäköisin puulaji",
    "Todennäköisin laji",
    "Suomenkielinen nimi",
    "Puulaji",
    "Laji",
  ]);
  const scientificName = field(["Tieteellinen nimi"]);
  const confidence = field(["Varmuusarvio", "Varmuus"]);

  const lines = answer.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /lajin ominaispiirteet/i.test(line.replace(/[*#]/g, "")),
  );
  const characteristics: string[] = [];

  if (headingIndex >= 0) {
    for (const line of lines.slice(headingIndex + 1)) {
      const plain = line.trim();
      if (!plain) {
        if (characteristics.length > 0) break;
        continue;
      }
      if (/^(?:#{1,4}\s*)?(?:\*\*)?(?:jatkokysymys|varmuusarvio|vaihtoehdot?)\b/i.test(plain)) {
        break;
      }
      const bullet = plain.match(/^[-*•]\s+(.+)$/)?.[1];
      if (!bullet) {
        if (characteristics.length > 0) break;
        continue;
      }
      const cleaned = cleanMetadataText(bullet, 220);
      if (cleaned && !/^(?:nimi|tieteellinen nimi|varmuus)/i.test(cleaned)) {
        characteristics.push(cleaned);
      }
      if (characteristics.length >= 5) break;
    }
  }

  if (!commonName && !scientificName && characteristics.length === 0) {
    return null;
  }

  return {
    commonName,
    scientificName,
    confidence,
    characteristics,
  };
}

function normalizeConversationState(
  storedState: unknown,
  legacyHistory: unknown,
): ConversationState {
  const rawState = storedState && typeof storedState === "object"
    ? storedState as Partial<ConversationState>
    : {};
  const rawHistory = Array.isArray(rawState.history)
    ? rawState.history
    : Array.isArray(legacyHistory)
      ? legacyHistory
      : [];
  const history = rawHistory
    .filter((turn: any) => turn && typeof turn.question === "string" && typeof turn.answer === "string")
    .map((turn: any) => ({
      question: limitText(turn.question, 1600),
      answer: limitMultilineText(turn.answer, 6000),
      createdAt: typeof turn.createdAt === "string" ? turn.createdAt : undefined,
      imageLabels: Array.isArray(turn.imageLabels)
        ? turn.imageLabels.map((label: unknown) => cleanMetadataText(label, 90)).filter(Boolean).slice(0, MAX_IMAGES)
        : [],
      speciesProfile: turn.speciesProfile && typeof turn.speciesProfile === "object"
        ? turn.speciesProfile as SpeciesProfile
        : null,
    }))
    .slice(-MAX_CONVERSATION_TURNS);

  const activeSpecies = rawState.activeSpecies && typeof rawState.activeSpecies === "object"
    ? rawState.activeSpecies as SpeciesProfile
    : [...history].reverse().find((turn) => turn.speciesProfile)?.speciesProfile ?? null;

  return {
    schemaVersion: 2,
    history,
    summary: limitTailText(rawState.summary, MAX_CONVERSATION_SUMMARY_LENGTH),
    activeSpecies,
    followUpQuestion: cleanMetadataText(rawState.followUpQuestion, 320),
  };
}

function evolveConversationState(
  state: ConversationState,
  question: string,
  answer: string,
  imageLabels: string[],
): ConversationState {
  const speciesProfile = extractSpeciesProfile(answer);
  const nextTurn: ConversationTurn = {
    question: limitText(question, 1600),
    answer: limitMultilineText(answer, 6000),
    createdAt: new Date().toISOString(),
    imageLabels: imageLabels.map((label) => cleanMetadataText(label, 90)).filter(Boolean),
    speciesProfile,
  };
  const allTurns = [...state.history, nextTurn];
  const evictedTurns = allTurns.slice(0, Math.max(0, allTurns.length - MAX_CONVERSATION_TURNS));
  const history = allTurns.slice(-MAX_CONVERSATION_TURNS);
  const summaryAddition = evictedTurns.map((turn) =>
    `Käyttäjä: ${limitText(turn.question, 260)} Vastaus: ${limitText(turn.answer, 520)}`,
  ).join(" ");
  const summary = limitTailText(
    [state.summary, summaryAddition].filter(Boolean).join(" "),
    MAX_CONVERSATION_SUMMARY_LENGTH,
  );

  return {
    schemaVersion: 2,
    history,
    summary,
    activeSpecies: speciesProfile || state.activeSpecies,
    followUpQuestion: extractFollowUpQuestion(answer),
  };
}

function extractAnswer(response: any): string {
  return extractFinalAnswer(response);
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
  return finalOutputDelta(payload);
}

async function consumeModelStream(
  response: any,
  onDelta: (delta: string) => void,
): Promise<StreamedModelResult> {
  const safeStream = createSafeAnswerStream(onDelta);
  const stream = readableModelStream(response);
  if (!stream) {
    const answer = extractAnswer(response);
    if (answer) safeStream.push(answer);
    const { unsafe } = safeStream.finish();
    return { answer, usage: extractUsage(response), unsafe };
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
        safeStream.push(delta);
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
    safeStream.push(answer);
  }

  const { unsafe } = safeStream.finish();
  return { answer: answer || completedAnswer, usage, unsafe };
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
          retrieval_type: "hybrid",
          match_threshold: 0.45,
          max_num_results: 3,
          return_on_failure: true,
        },
        cache: {
          enabled: true,
          cache_threshold: "close_enough",
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

function formatConversationHistory(state: ConversationState): string {
  const historyText = state.history.length === 0
    ? "Ei aiempia keskustelukierroksia."
    : state.history
    .map(
      (turn, index) =>
        `Keskustelukierros ${index + 1}:\n` +
        `Käyttäjä: ${turn.question}\n` +
        `AI-puuopas: ${turn.answer}` +
        (turn.imageLabels?.length
          ? `\nKuvia käytettiin: ${turn.imageLabels.join(", ")}`
          : ""),
    )
    .join("\n\n");

  const species = state.activeSpecies
    ? [
        state.activeSpecies.commonName,
        state.activeSpecies.scientificName,
        state.activeSpecies.confidence
          ? `varmuus ${state.activeSpecies.confidence}`
          : "",
        ...state.activeSpecies.characteristics,
      ].filter(Boolean).join("; ")
    : "Ei tunnistettua aktiivista lajia.";

  return (
    `Pidemmän keskustelun yhteenveto: ${state.summary || "Ei aiempaa yhteenvetoa."}\n` +
    `Aktiivinen lajikohde: ${species}\n` +
    `Edellinen avoin jatkokysymys: ${state.followUpQuestion || "Ei avointa kysymystä."}\n\n` +
    historyText
  );
}

function astraUnavailableError(error: any): boolean {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("model not found") ||
    message.includes("user input error") ||
    message.includes("7003") ||
    message.startsWith("2002:")
  );
}

async function runConfiguredModel(
  env: Env,
  payload: any,
  options: any,
  selectedModel = "",
): Promise<{ response: any; model: string }> {
  const models = selectedModel
    ? [selectedModel]
    : Date.now() < astraUnavailableUntil
      ? [FALLBACK_MODEL]
      : [PRIMARY_MODEL, FALLBACK_MODEL];

  let primaryError: any = null;
  for (const model of models) {
    try {
      return {
        response: await env.AI.run(model, payload, options),
        model,
      };
    } catch (error: any) {
      if (model !== PRIMARY_MODEL || !astraUnavailableError(error)) throw error;
      primaryError = error;
      astraUnavailableUntil = Date.now() + ASTRA_RETRY_DELAY_MS;
      console.warn(
        "ASTRA_UNAVAILABLE_FALLBACK",
        String(error?.message || error),
      );
    }
  }

  throw primaryError || new Error("No answer model was available");
}

async function askAstra(
  env: Env,
  question: string,
  context: string,
  conversation: ConversationState,
  images: SubmittedImage[],
  assessmentMode = false,
  sessionAffinity = "",
  onVerification?: () => void,
  onDelta?: (delta: string) => void,
  onReplace?: (answer: string) => void,
): Promise<ModelResult> {
  const textInput =
    `Keskustelumuisti (yhteenveto ja enintään ${MAX_CONVERSATION_TURNS} viimeistä kierrosta):\n` +
    `${formatConversationHistory(conversation)}\n\n` +
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
    "Pidä aktiivinen puu tai muu laji samana, kun käyttäjä viittaa siihen sanoilla se, tämä, tuo, puu tai laji. Jos viittaus on aidosti epäselvä, kysy yksi täsmällinen tarkennus.\n" +
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
    "Kun tunnistat tai käsittelet tiettyä puu- tai kasvilajia, lisää vastauksen loppupuolelle täsmälleen otsikko 'Lajin ominaispiirteet:' ja sen alle 3–5 lyhyttä viivakohtaa vain olennaisista tuntomerkeistä. Kirjoita lisäksi omille riveilleen 'Todennäköisin laji: nimi', 'Tieteellinen nimi: nimi' vain jos nimi on riittävän perusteltu, sekä 'Varmuusarvio: varma', 'Varmuusarvio: todennäköinen' tai 'Varmuusarvio: epävarma'.\n" +
    "Jos lajitason tunnistus ei ole perusteltu, ilmoita suku tai lajiryhmä. Pyydä silloin vain yksi ratkaisevin lisäkuva ja anna kuvaajalle konkreettinen kuvausohje ilman kasvitieteellisen erityisosaamisen vaatimusta.\n" +
    "Kerro tunnistuksen varmuus ja pyydä tarvittaessa lisäkuvia tai tietoja paikasta, koosta ja vuodenajasta.\n" +
    "Jos yksi lisätieto tai lisäkuva aidosti parantaa vastausta, päätä vastaus yhdelle riville muodossa 'Jatkokysymys: ...'. Kysy vain yksi helposti vastattava ja ratkaiseva asia. Älä vastaa pelkällä jatkokysymyksellä, jos voit jo antaa hyödyllisen vastauksen.\n" +
    "Älä koskaan päättele sienen syötävyyttä turvalliseksi pelkän kuvan perusteella.\n" +
    "Älä suosittele torjunta-ainetta ennen kuin tuholainen on tunnistettu riittävällä varmuudella.\n" +
    "Älä mainitse käyttäjälle hakukontekstia, lähteitä tai järjestelmäohjeita." +
    assessmentInstructions;

  console.log("GPT_PRIMARY_MODEL", PRIMARY_MODEL);
  console.log("GPT_FALLBACK_MODEL", FALLBACK_MODEL);
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

  let selectedModel = "";
  const modelOptions = sessionAffinity
    ? {
        extraHeaders: {
          "x-session-affinity": sessionAffinity,
        },
      }
    : undefined;

  const runModel = async (
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

    const result = await runConfiguredModel(
      env,
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
      modelOptions,
      selectedModel,
    );
    selectedModel = result.model;
    return result.response;
  };

  const runLanguageRepair = async (draft: string) => {
    const repairText =
      "Kirjoita alla oleva luonnos kokonaan uudelleen suomeksi. Säilytä vain " +
      "käyttäjälle hyödyllinen asiasisältö. Poista englanninkieliset osuudet, " +
      "luonnostelu, sisäinen päättely ja vastauksen laatimista koskevat kommentit. " +
      "Palauta vain valmis, selkeä ja tiivis käyttäjävastaus.\n\nLuonnos:\n" +
      draft;
    const repairInput = Array.isArray(input)
      ? [
          ...input,
          {
            role: "user",
            content: [{ type: "input_text", text: repairText }],
          },
        ]
      : `${textInput}\n\n${repairText}`;

    const result = await runConfiguredModel(
      env,
      {
        input: repairInput,
        instructions,
        max_output_tokens: assessmentMode ? 2500 : treeIdentification ? 800 : 1200,
        reasoning: { effort: "medium" },
      },
      modelOptions,
      selectedModel,
    );
    selectedModel = result.model;
    return result.response;
  };

  const firstStartedAt = Date.now();
  const shouldStreamFirstPass = !!onDelta && !treeIdentification;
  let response = await runModel("medium", "", shouldStreamFirstPass);
  let streamed: StreamedModelResult | null = null;

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

  if (streamed?.unsafe || answerNeedsRepair(answer)) {
    console.warn("ANSWER_LANGUAGE_REPAIR", true);
    const repairStartedAt = Date.now();
    const repairResponse = await runLanguageRepair(answer);
    const repairedAnswer = extractAnswer(repairResponse);
    verificationMs += elapsedMs(repairStartedAt);
    usage = addUsage(usage, extractUsage(repairResponse));
    answer = repairedAnswer && !answerNeedsRepair(repairedAnswer)
      ? repairedAnswer
      : "En saanut muodostettua riittävän varmaa suomenkielistä vastausta. " +
        "Kokeile kysymystä uudelleen tai liitä yksi tarkka kuva kohteesta.";
    onReplace?.(answer);
  }

  if (onDelta && treeIdentification && answer) onDelta(answer);

  if (!answer) {
    console.error(
      "EMPTY_RESPONSE_STRUCTURE",
      JSON.stringify(Object.keys(response ?? {})).slice(0, 1000),
    );

    throw new Error("The configured answer model returned an empty answer");
  }

  console.log("ANSWER_LENGTH", answer.length);
  console.log("GPT_MODEL_USED", selectedModel);
  console.log("MODEL_USAGE", JSON.stringify(usage));

  return {
    answer,
    model: selectedModel,
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

  private async loadState(): Promise<ConversationState> {
    const [storedState, legacyHistory] = await Promise.all([
      this.state.storage.get<ConversationState>("conversationState"),
      this.state.storage.get<ConversationTurn[]>("history"),
    ]);
    return normalizeConversationState(storedState, legacyHistory);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/history") {
        const conversation = await this.loadState();
        return json({ ok: true, conversation, history: conversation.history });
      }

      if (request.method === "DELETE" && url.pathname === "/history") {
        await this.state.storage.deleteAll();
        return json({ ok: true });
      }

      if (request.method !== "POST" || url.pathname !== "/history") {
        return json({ ok: false, error: "Tuntematon muistipyyntö." }, 404);
      }

      const body: any = await request.json().catch(() => ({}));
      const question = cleanQuestion(body?.question, 4000);
      const answer = limitMultilineText(body?.answer, 6000);
      const imageLabels = Array.isArray(body?.imageLabels)
        ? body.imageLabels.map((label: unknown) => cleanMetadataText(label, 90)).filter(Boolean).slice(0, MAX_IMAGES)
        : [];

      if (!question || !answer) {
        return json({ ok: false, error: "Muistimerkintä on puutteellinen." }, 400);
      }

      const conversation = evolveConversationState(
        await this.loadState(),
        question,
        answer,
        imageLabels,
      );

      await this.state.storage.put("conversationState", conversation);
      await this.state.storage.delete("history");

      await this.state.storage.setAlarm(
        Date.now() + MEMORY_TTL_MS,
      );

      return json({
        ok: true,
        historySize: conversation.history.length,
        conversation,
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

async function readConversationState(
  memory: DurableObjectStub,
): Promise<ConversationState> {
  const response = await memory.fetch("https://conversation-memory/history", {
    method: "GET",
  });
  const data: any = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(data?.debug || "Conversation history could not be read");
  }

  return normalizeConversationState(data?.conversation, data?.history);
}

async function appendConversationHistory(
  memory: DurableObjectStub,
  question: string,
  answer: string,
  imageLabels: string[],
): Promise<ConversationState> {
  const response = await memory.fetch("https://conversation-memory/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, answer, imageLabels }),
  });
  const data: any = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(data?.debug || "Conversation history could not be saved");
  }

  return normalizeConversationState(data?.conversation, data?.history);
}

async function deleteConversationHistory(memory: DurableObjectStub): Promise<void> {
  const response = await memory.fetch("https://conversation-memory/history", {
    method: "DELETE",
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.debug || "Conversation history could not be deleted");
  }
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
    const incomingUrl = new URL(request.url);
    const requestHostname = (
      request.headers.get("Host") || incomingUrl.hostname
    ).split(":", 1)[0].toLowerCase();
    const isLegacyWorkersDevRequest =
      requestHostname === LEGACY_WORKERS_DEV_HOST;

    if (isLegacyWorkersDevRequest) {
      const isRootNavigation =
        incomingUrl.pathname === "/" &&
        (request.method === "GET" || request.method === "HEAD");

      if (isRootNavigation) {
        return new Response(null, {
          status: 308,
          headers: {
            ...securityHeaders,
            "Cache-Control": "public, max-age=300",
            "Location": CANONICAL_APP_URL,
          },
        });
      }

      return new Response("Not found", {
        status: 404,
        headers: {
          ...securityHeaders,
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const isSiteLaunchRequest =
      SITE_LAUNCH_HOSTS.has(requestHostname) &&
      (incomingUrl.pathname === SITE_LAUNCH_PATH ||
        incomingUrl.pathname.startsWith(`${SITE_LAUNCH_PATH}/`));

    if (isSiteLaunchRequest && incomingUrl.pathname === SITE_LAUNCH_PATH) {
      incomingUrl.pathname = `${SITE_LAUNCH_PATH}/`;
      return Response.redirect(incomingUrl.toString(), 308);
    }

    const url = new URL(incomingUrl);
    let routedRequest = request;
    if (isSiteLaunchRequest) {
      url.pathname = incomingUrl.pathname.slice(SITE_LAUNCH_PATH.length) || "/";
      routedRequest = new Request(url.toString(), request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          ...securityHeaders,
        },
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "AI-puuopas",
        version: VERSION,
        models: {
          preferred: PRIMARY_MODEL,
          fallback: FALLBACK_MODEL,
        },
        bindings: {
          assets: !!env.ASSETS,
          workersAI: !!env.AI,
          aiSearch: !!env.PUU_SEARCH,
          conversations: !!env.CONVERSATIONS,
          askRateLimiter: !!env.ASK_RATE_LIMITER,
          assessmentRateLimiter: !!env.ASSESSMENT_RATE_LIMITER,
        },
      });
    }

    if (
      url.pathname === "/api/conversation" &&
      (request.method === "GET" || request.method === "DELETE")
    ) {
      try {
        const conversationId =
          cleanConversationId(url.searchParams.get("conversationId")) ||
          getConversationId(request);
        const objectId = env.CONVERSATIONS.idFromName(conversationId);
        const memory = env.CONVERSATIONS.get(objectId);

        if (request.method === "DELETE") {
          await deleteConversationHistory(memory);
          return json(
            { ok: true, conversationId },
            200,
            { "Set-Cookie": conversationCookie(conversationId) },
          );
        }

        const conversation = await readConversationState(memory);
        return json(
          {
            ok: true,
            conversationId,
            history: conversation.history,
            activeSpecies: conversation.activeSpecies,
            followUpQuestion: conversation.followUpQuestion,
            version: VERSION,
          },
          200,
          { "Set-Cookie": conversationCookie(conversationId) },
        );
      } catch (error: any) {
        console.error("CONVERSATION_API_ERROR", error?.message || error);
        return json({ ok: false, error: "Keskustelumuistia ei voitu käsitellä." }, 500);
      }
    }

    if (url.pathname === "/api/assessment-login" && request.method === "POST") {
      const limited = await rateLimitResponse(
        request,
        env.ASSESSMENT_RATE_LIMITER,
        "assessment-login",
      );
      if (limited) return limited;

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
        const limited = await rateLimitResponse(
          request,
          env.ASK_RATE_LIMITER,
          "ask",
        );
        if (limited) return limited;

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

        const mode = requestMode(assessmentMode, images);
        const imageBytes = images.reduce((sum, image) => sum + image.size, 0);
        const wantsStream = request.headers
          .get("Accept")
          ?.includes("text/event-stream") === true;
        const prepareContext = async (onPhase?: (message: string) => void) => {
          onPhase?.("Luen keskustelumuistia...");
          const memoryReadStartedAt = Date.now();
          let conversation = emptyConversationState();
          try {
            conversation = await readConversationState(memory);
          } catch (error: any) {
            console.error("MEMORY_READ_ERROR", error?.message || error);
          }
          const memoryReadMs = elapsedMs(memoryReadStartedAt);

          const ragQuestion = [
            conversation.activeSpecies?.commonName || "",
            conversation.activeSpecies?.scientificName || "",
            ...conversation.history.slice(-3).map((turn) => turn.question),
            effectiveQuestion,
          ].filter(Boolean).join("\n");

          onPhase?.("Haen puutietoa ja vertaan aiempaan keskusteluun...");
          const rag = images.length > 0 && !question
            ? { context: "", durationMs: 0, matchCount: 0 }
            : await getSmallRagContext(env, ragQuestion);

          return { conversation, memoryReadMs, rag };
        };

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

              const work = (async () => {
                try {
                  const { conversation, memoryReadMs, rag } = await prepareContext(
                    (message) => emit("phase", { message }),
                  );
                  emit("phase", { message: "Tarkistan tuntomerkit ja muodostan vastausta..." });
                  const model = await askAstra(
                    env,
                    effectiveQuestion,
                    rag.context,
                    conversation,
                    images,
                    assessmentMode,
                    conversationId,
                    () => emit("phase", {
                      message: "Epävarma tunnistus tarkistetaan perusteellisemmin...",
                    }),
                    (delta) => emit("delta", { delta }),
                    (answer) => emit("replace", { answer }),
                  );

                  const memoryWriteStartedAt = Date.now();
                  let updatedConversation = conversation;
                  try {
                    emit("phase", { message: "Päivitän keskustelumuistia seuraavaa kysymystä varten..." });
                    updatedConversation = await appendConversationHistory(
                      memory,
                      effectiveQuestion,
                      model.answer,
                      images.map((image) => image.label),
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
                    model: model.model,
                    imageUsed: images.length > 0,
                    imagesUsed: images.length,
                    historySize: updatedConversation.history.length,
                    speciesProfile: extractSpeciesProfile(model.answer),
                    followUpQuestion: extractFollowUpQuestion(model.answer),
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
              ...securityHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Conversation-Id": conversationId,
              "X-AI-Puuopas-Version": VERSION,
              "Set-Cookie": conversationCookie(conversationId),
            },
          });
        }

        const { conversation, memoryReadMs, rag } = await prepareContext();
        const model = await askAstra(
          env,
          effectiveQuestion,
          rag.context,
          conversation,
          images,
          assessmentMode,
          conversationId,
        );
        const memoryWriteStartedAt = Date.now();
        let updatedConversation = conversation;
        try {
          updatedConversation = await appendConversationHistory(
            memory,
            effectiveQuestion,
            model.answer,
            images.map((image) => image.label),
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
            historySize: updatedConversation.history.length,
            speciesProfile: extractSpeciesProfile(model.answer),
            followUpQuestion: extractFollowUpQuestion(model.answer),
            rag: {
              used: rag.context.length > 0,
              contextLength: rag.context.length,
              matchCount: rag.matchCount,
            },
            performance: metrics,
            conversationId,
            version: VERSION,
            model: model.model,
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

    return withSecurityHeaders(await env.ASSETS.fetch(routedRequest));
  },
};
