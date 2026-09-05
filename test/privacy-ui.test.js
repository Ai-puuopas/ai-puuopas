import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const privacyJs = await readFile(new URL("../public/privacy.js", import.meta.url), "utf8");
const chatJs = await readFile(new URL("../public/puuopas-chat.js", import.meta.url), "utf8");

test("privacy notice is rendered before the guide and remains reopenable", () => {
  assert.match(indexHtml, /id="privacyGate"/);
  assert.match(indexHtml, /id="continueToGuide"/);
  assert.match(indexHtml, /id="privacyPolicyDialog"/);
  assert.match(indexHtml, /data-open-privacy/);
  assert.ok(indexHtml.indexOf("./privacy.js") < indexHtml.indexOf("./puuopas-chat.js"));
  assert.match(privacyJs, /puuopasPrivacyNoticeVersion/);
  assert.match(privacyJs, /showModal/);
});

test("GPS access requires specific consent and can be withdrawn", () => {
  assert.match(chatJs, /puuopas-location-consent-input/);
  assert.match(chatJs, /Hyväksyn, että AI‑Puuopas käsittelee laitteen GPS-koordinaatit/);
  assert.match(chatJs, /if \(!locationConsent\.checked\)/);
  assert.match(chatJs, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(chatJs, /Poista sijainti ja peruuta suostumus/);
  assert.match(chatJs, /panel\.querySelector\('\[name="latitude"\]'\)\.value = ""/);
});
