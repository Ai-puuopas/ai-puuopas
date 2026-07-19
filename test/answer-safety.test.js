import test from "node:test";
import assert from "node:assert/strict";

import {
  answerNeedsRepair,
  createSafeAnswerStream,
  extractFinalAnswer,
  finalOutputDelta,
} from "../src/answer-safety.js";

test("extractFinalAnswer returns only the final message and ignores reasoning", () => {
  const response = {
    output: [
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "We need fix typo. Let's craft." }],
      },
      {
        type: "message",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Todennäköisin vaihtoehto on pakuri." }],
      },
    ],
  };

  assert.equal(extractFinalAnswer(response), "Todennäköisin vaihtoehto on pakuri.");
});

test("finalOutputDelta accepts final answer deltas only", () => {
  assert.equal(finalOutputDelta({
    type: "response.output_text.delta",
    delta: "Valmis vastaus",
  }), "Valmis vastaus");
  assert.equal(finalOutputDelta({
    type: "response.reasoning_summary_text.delta",
    delta: "We need explain this",
  }), "");
  assert.equal(finalOutputDelta({ response: "untyped internal text" }), "");
});

test("answerNeedsRepair detects language switches and internal drafting", () => {
  const leaked =
    "Koivun musta kasvannainen voi olla pakuri. " +
    "We need fix typo. Need explain impacts and alternatives. Let's craft.";

  assert.equal(answerNeedsRepair(leaked), true);
  assert.equal(
    answerNeedsRepair("Koivun musta kasvannainen voi olla pakuri, mutta tunnistus vaatii kuvan."),
    false,
  );
});

test("safe stream withholds an unsafe sentence batch", () => {
  let visible = "";
  const stream = createSafeAnswerStream((text) => {
    visible += text;
  });

  stream.push(
    "Koivun musta kasvannainen voi olla pakuri. " +
    "Se näyttää usein rosoiselta ja hiiltyneeltä. " +
    "Pakurikääpä lah? We need fix typo. Need explain impacts. Let's craft.",
  );
  const result = stream.finish();

  assert.equal(result.unsafe, true);
  assert.equal(
    visible,
    "Koivun musta kasvannainen voi olla pakuri. " +
      "Se näyttää usein rosoiselta ja hiiltyneeltä. ",
  );
});

test("safe stream preserves a clean Finnish answer", () => {
  let visible = "";
  const stream = createSafeAnswerStream((text) => {
    visible += text;
  });
  const answer =
    "Todennäköisin vaihtoehto on pakuri. " +
    "Pelkkä sanallinen kuvaus ei kuitenkaan riitä varmaan tunnistukseen. " +
    "Lähetä yksi tarkka kuva kasvannaisesta.";

  stream.push(answer.slice(0, 37));
  stream.push(answer.slice(37));
  const result = stream.finish();

  assert.equal(result.unsafe, false);
  assert.equal(visible, answer);
});
