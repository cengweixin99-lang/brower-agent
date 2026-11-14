import assert from "node:assert/strict";
import { test } from "node:test";
import { planUrls } from "./index.ts";

test("requires explicit URLs, strips sentence punctuation and deduplicates pages", () => {
  assert.deepEqual(planUrls("Read https://example.com.\nhttps://example.com/#intro"), [
    "https://example.com/",
  ]);
  assert.throws(() => planUrls("Research competitors"));
  assert.throws(() => planUrls("Read https://user:secret@example.com"));
  assert.throws(() => planUrls(Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ")));
});
