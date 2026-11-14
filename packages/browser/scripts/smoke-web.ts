import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.getByRole("heading", { name: "What should I do for you?", exact: true }).waitFor();
  await page.getByText("Browser connected", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await mkdir(".data/screenshots", { recursive: true });
  await page.screenshot({ path: ".data/screenshots/dev-home.png", fullPage: true });
  console.log("PASS: Figma-based task UI rendered with live service status and no page errors.");
} finally {
  await browser.close();
}
