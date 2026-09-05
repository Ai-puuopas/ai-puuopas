import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const chat = await readFile(new URL("../public/puuopas-chat.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("Astra is preferred with a safe temporary fallback and medium/high reasoning", () => {
  assert.match(worker, /const PRIMARY_MODEL = "openai\/gpt-6-astra"/);
  assert.match(worker, /const FALLBACK_MODEL = "openai\/gpt-5\.6-sol"/);
  assert.match(worker, /ASTRA_UNAVAILABLE_FALLBACK/);
  assert.match(worker, /effort: "medium" \| "high"/);
});

test("conversation memory keeps structured context and can be deleted", () => {
  assert.match(worker, /const MAX_CONVERSATION_TURNS = 8/);
  assert.match(worker, /activeSpecies: SpeciesProfile \| null/);
  assert.match(worker, /followUpQuestion: string/);
  assert.match(worker, /summary: string/);
  assert.match(worker, /request\.method === "DELETE" && url\.pathname === "\/history"/);
  assert.match(worker, /url\.pathname === "\/api\/conversation"/);
  assert.match(html, /kahdeksan viimeistä täydellistä/);
});

test("chat renders actual phases, response images, traits and follow-up", () => {
  assert.match(chat, /title\.textContent = "Ajatusvirta"/);
  assert.match(chat, /options\.onPhase\?\./);
  assert.doesNotMatch(chat, /seconds < 15/);
  assert.match(chat, /puuopas-response-gallery/);
  assert.match(chat, /renderSpeciesCard/);
  assert.match(chat, /renderFollowUp/);
  assert.match(chat, /Uusi keskustelu/);
});
