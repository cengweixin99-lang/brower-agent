import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(
    '<label>Name <input id="name"></label><button type="button">Save</button><output></output><script>document.querySelector("button").onclick = () => { document.querySelector("output").textContent = document.querySelector("input").value; };</script>',
  );
  await page.getByLabel("Name").fill("browser smoke passed");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("browser smoke passed", { exact: true }).waitFor();
  assert.equal(await page.locator("output").textContent(), "browser smoke passed");
  console.log("PASS: Chromium launch, page observation, form input, click, and result verification.");
} finally {
  await browser.close();
}
