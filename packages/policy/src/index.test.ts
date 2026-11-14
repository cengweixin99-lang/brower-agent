import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { publicAddress, resolveAllowedUrl, resolvePublicIPv4 } from "./index.ts";

test("blocks private, loopback, link local and mapped addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700::1111"), true);
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://127.0.0.1",
    "http://[::1]",
  ])
    await assert.rejects(resolveAllowedUrl(url));
  assert.equal(
    (await resolveAllowedUrl("http://127.0.0.1:3131/test", ["http://127.0.0.1:3131"])).address,
    "127.0.0.1",
  );
  await assert.rejects(resolveAllowedUrl("http://127.0.0.1:3132/test", ["http://127.0.0.1:3131"]));
});

test("fake-IP fallback only accepts public A records from HTTPS DNS", async () => {
  const mocked = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1", TTL: 30 }] })),
  );
  try {
    await assert.rejects(resolvePublicIPv4("private-answer.invalid"));
    mocked.mock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8", TTL: 30 }] })),
    );
    assert.deepEqual(await resolvePublicIPv4("public-answer.invalid"), [{ address: "8.8.8.8", family: 4 }]);
    assert.equal(publicAddress("198.18.0.1"), false);
  } finally {
    mocked.mock.restore();
  }
});
