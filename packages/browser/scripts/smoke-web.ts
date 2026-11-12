import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.getByRole("heading", { name: "Pi Browser Agent", exact: true }).waitFor();
  await page.getByText("API 与浏览器服务进程已就绪", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await mkdir(".data/screenshots", { recursive: true });
  await page.screenshot({ path: ".data/screenshots/dev-home.png", fullPage: true });
  console.log("PASS: React page rendered, both service proxies responded, and no page errors occurred.");
} finally {
  await browser.close();
}
