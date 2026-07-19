const INTERNAL_DRAFT_PATTERNS = [
  /\bwe\s+need\b/i,
  /\blet(?:'|’)s\s+(?:craft|answer|write|respond)\b/i,
  /\b(?:fix|correct)\s+(?:the\s+)?typo\b/i,
  /\b(?:the\s+)?user\s+(?:asks?|asked|wants?|requested)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b/i,
  /\b(?:internal|hidden)\s+(?:reasoning|notes?|instructions?)\b/i,
  /\bfinal\s+answer\b/i,
  /\bdo(?:n't|\s+not)\s+say\b/i,
];

const ENGLISH_WORDS = new Set([
  "after", "also", "alternatives", "answer", "appears", "assess",
  "before", "black", "could", "craft", "decay", "don't", "exactly",
  "explain", "fix", "from", "impacts", "indicates", "internal", "likely",
  "need", "needs", "note", "often", "photo", "please", "reasoning",
  "requested", "safe", "say", "send", "should", "that", "the", "this",
  "under", "user", "we", "with", "would",
]);

function englishWordCount(text) {
  const words = text.toLocaleLowerCase("en").match(/[a-z]+(?:'[a-z]+)?/g) || [];
  return words.reduce((count, word) => count + (ENGLISH_WORDS.has(word) ? 1 : 0), 0);
}

export function answerNeedsRepair(value) {
  if (typeof value !== "string") return true;
  const text = value.trim();
  if (!text) return true;
  if (INTERNAL_DRAFT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return englishWordCount(text) >= 4;
}

function firstNonEmptyString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

export function extractFinalAnswer(response) {
  if (typeof response === "string") return response.trim();

  const direct = firstNonEmptyString([
    response?.output_text,
    response?.result?.output_text,
    response?.answer,
    response?.result?.answer,
  ]);
  if (direct) return direct;

  for (const output of [response?.output, response?.result?.output]) {
    if (!Array.isArray(output)) continue;
    const texts = [];

    for (const item of output) {
      if (item?.type !== "message" || item?.phase !== "final_answer") continue;
      if (!Array.isArray(item?.content)) continue;

      for (const content of item.content) {
        if (content?.type !== "output_text") continue;
        const text = firstNonEmptyString([
          content?.text,
          content?.output_text,
          content?.value,
        ]);
        if (text) texts.push(text);
      }
    }

    if (texts.length) return texts.join("\n").trim();
  }

  const chatContent = response?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string") return chatContent.trim();
  if (Array.isArray(chatContent)) {
    const texts = chatContent
      .map((item) => typeof item === "string" ? item : item?.text || "")
      .filter((text) => typeof text === "string" && text.trim())
      .map((text) => text.trim());
    if (texts.length) return texts.join("\n").trim();
  }

  return "";
}

export function finalOutputDelta(payload) {
  if (
    payload?.type === "response.output_text.delta" &&
    typeof payload?.delta === "string"
  ) {
    return payload.delta;
  }

  const chatDelta = payload?.choices?.[0]?.delta?.content;
  return typeof chatDelta === "string" ? chatDelta : "";
}

function takeStreamingUnit(buffer) {
  const paragraphEnd = buffer.search(/\n\s*\n/);
  const sentenceMatch = /[.!?](?:["”’')\]]*)\s+/.exec(buffer);
  const sentenceEnd = sentenceMatch
    ? sentenceMatch.index + sentenceMatch[0].length
    : -1;

  if (paragraphEnd >= 0 && (sentenceEnd < 0 || paragraphEnd < sentenceEnd)) {
    const match = buffer.slice(paragraphEnd).match(/^\n\s*\n/)?.[0] || "\n\n";
    return buffer.slice(0, paragraphEnd + match.length);
  }
  if (sentenceEnd >= 0) return buffer.slice(0, sentenceEnd);
  return "";
}

export function createSafeAnswerStream(onSafeText) {
  let pending = "";
  let batch = "";
  let sentenceCount = 0;
  let unsafe = false;

  const emitBatch = () => {
    if (!batch || unsafe) return;
    if (answerNeedsRepair(batch)) {
      unsafe = true;
      return;
    }
    onSafeText(batch);
    batch = "";
    sentenceCount = 0;
  };

  return {
    push(delta) {
      if (typeof delta !== "string" || !delta || unsafe) return;
      pending += delta;

      let unit = takeStreamingUnit(pending);
      while (unit) {
        pending = pending.slice(unit.length);
        batch += unit;
        if (/\n\s*\n$/.test(unit)) {
          emitBatch();
        } else {
          sentenceCount += 1;
          if (sentenceCount >= 2) emitBatch();
        }
        unit = takeStreamingUnit(pending);
      }
    },
    finish() {
      if (!unsafe) {
        batch += pending;
        pending = "";
        emitBatch();
      }
      return { unsafe };
    },
  };
}
