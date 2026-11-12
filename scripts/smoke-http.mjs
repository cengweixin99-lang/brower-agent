import assert from "node:assert/strict";

for (const [url, service] of [
  ["http://127.0.0.1:3100/healthz", "api"],
  ["http://127.0.0.1:3101/healthz", "browser-worker"],
]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service, status: "ok" });
  console.log(`PASS: ${service} HTTP health endpoint.`);
}
const web = await fetch("http://127.0.0.1:5173", { signal: AbortSignal.timeout(5000) });
assert.equal(web.status, 200);
assert.match(await web.text(), /Pi Browser Agent/);
console.log("PASS: web development server.");
