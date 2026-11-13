import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { gradeDemoTask } from "../../../evals/graders/demo.ts";
import { demoTasks, getDemoTask } from "../../../evals/tasks/demo.ts";
import type { FormValues } from "./data.ts";
import { createDemoFixture } from "./demo.ts";

test("demo suite has 30 unique cases and keeps expected results outside agent inputs", () => {
  assert.equal(demoTasks.length, 30);
  assert.equal(new Set(demoTasks.map((task) => task.id)).size, 30);
  for (const kind of ["fact", "filter", "form"] as const)
    assert.equal(demoTasks.filter((task) => task.kind === kind).length, 10);
  assert.throws(() => getDemoTask("missing"));
});

test("all 30 controlled website cases have reachable evidence and objective positive/negative grades", async (t) => {
  const site = await createDemoFixture();
  try {
    for (const task of demoTasks) {
      await t.test(task.id, async () => {
        const attempt = site.createAttempt(task.id);
        const get = async (path: string): Promise<string> => {
          const response = await fetch(`${attempt.startUrl}${path}`);
          assert.equal(response.status, 200);
          return response.text();
        };
        assert.equal(gradeDemoTask(task, site.evidence(attempt.attemptId)).passed, false);
        assert.match(await get(""), /浏览器任务测试站/);
        if (task.kind === "fact") {
          const sourceUrl = `${attempt.startUrl}facts/${task.officeId}`;
          assert.match(await get("facts"), new RegExp(`facts/${task.officeId}`));
          assert.ok((await get(`facts/${task.officeId}`)).includes(task.expectedHours));
          const evidence = site.evidence(attempt.attemptId);
          assert.deepEqual(gradeDemoTask(task, evidence, { value: task.expectedHours, sourceUrl }), {
            passed: true,
            failures: [],
          });
          assert.equal(gradeDemoTask(task, evidence, { value: "wrong", sourceUrl }).passed, false);
          assert.equal(
            gradeDemoTask(task, evidence, { value: task.expectedHours, sourceUrl: attempt.startUrl }).passed,
            false,
          );
          assert.equal(
            gradeDemoTask(task, { ...evidence, visitedOffices: [] }, { value: task.expectedHours, sourceUrl })
              .passed,
            false,
          );
        } else if (task.kind === "filter") {
          const query = new URLSearchParams({ category: task.category, maxPrice: String(task.maxPrice) });
          const html = await get(`catalog?${query}`);
          assert.ok(html.includes(task.expectedProductId));
          assert.equal(html.includes("premium"), false);
          assert.ok((await get(`items/${task.expectedProductId}`)).includes("有货"));
          const evidence = site.evidence(attempt.attemptId);
          assert.equal(gradeDemoTask(task, evidence).passed, true);
          assert.equal(gradeDemoTask(task, { ...evidence, filter: null }).passed, false);
          assert.equal(gradeDemoTask(task, { ...evidence, detailId: "wrong" }).passed, false);
          assert.equal(gradeDemoTask(task, { ...evidence, lastPath: "/catalog" }).passed, false);
        } else {
          const html = await get("form");
          const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
          assert.ok(script);
          assert.doesNotThrow(() => new Script(script));
          const response = await fetch(`${attempt.startUrl}draft`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: 1, fields: task.expectedFields }),
          });
          assert.equal(response.status, 200);
          const evidence = site.evidence(attempt.attemptId);
          assert.equal(gradeDemoTask(task, evidence).passed, true);
          for (const field of ["name", "email", "topic", "note", "newsletter"] as const) {
            const wrong: FormValues = {
              ...task.expectedFields,
              [field]: field === "newsletter" ? !task.expectedFields.newsletter : "wrong",
            };
            assert.equal(gradeDemoTask(task, { ...evidence, draft: wrong }).passed, false);
          }
          assert.equal(
            (await fetch(`${attempt.startUrl}submit`, { method: "POST", body: "synthetic submission" }))
              .status,
            200,
          );
          assert.ok(
            gradeDemoTask(task, site.evidence(attempt.attemptId)).failures.includes("form_was_submitted"),
          );
        }
      });
    }
  } finally {
    await site.close();
  }
});

test("fixture attempts are isolated; evidence cannot be mutated through returned snapshots", async () => {
  const site = await createDemoFixture();
  try {
    const first = site.createAttempt("fact-north");
    const second = site.createAttempt("fact-north");
    await fetch(`${first.startUrl}facts/north`);
    const copy = site.evidence(first.attemptId);
    copy.visitedOffices.push("south");
    assert.deepEqual(site.evidence(first.attemptId).visitedOffices, ["north"]);
    assert.deepEqual(site.evidence(second.attemptId).visitedOffices, []);
    assert.equal(gradeDemoTask(getDemoTask("fact-south"), site.evidence(first.attemptId)).passed, false);
    assert.equal((await fetch(`${site.origin}/unknown/facts`)).status, 404);
    assert.equal((await fetch(`${first.startUrl}evidence`)).status, 404);
    assert.equal((await fetch(`${first.startUrl}catalog?maxPrice=NaN`)).status, 400);
    assert.equal((await fetch(`${first.startUrl}catalog?category=missing`)).status, 400);
  } finally {
    await site.close();
  }
});

test("draft endpoint rejects malformed, oversized and out-of-order updates", async () => {
  const site = await createDemoFixture();
  try {
    const task = getDemoTask("form-0");
    assert.equal(task.kind, "form");
    if (task.kind !== "form") throw new Error("Expected form case");
    const attempt = site.createAttempt(task.id);
    const post = (value: unknown) =>
      fetch(`${attempt.startUrl}draft`, { method: "POST", body: JSON.stringify(value) });
    assert.equal((await post({ revision: 1, fields: task.expectedFields })).status, 409);
    await fetch(`${attempt.startUrl}form`);
    assert.equal((await post({ revision: 2, fields: task.expectedFields })).status, 200);
    assert.equal(
      (await post({ revision: 1, fields: { ...task.expectedFields, name: "stale" } })).status,
      409,
    );
    assert.equal(
      (await post({ revision: 3, fields: { ...task.expectedFields, newsletter: "yes" } })).status,
      400,
    );
    assert.equal(
      (await post({ revision: 3, fields: { ...task.expectedFields, note: "x".repeat(20_000) } })).status,
      400,
    );
    assert.equal(site.evidence(attempt.attemptId).draft?.name, task.expectedFields.name);
    await fetch(`${attempt.startUrl}form`);
    assert.equal(
      gradeDemoTask(task, site.evidence(attempt.attemptId)).passed,
      false,
      "Reload clears unpersisted DOM fields",
    );
  } finally {
    await site.close();
  }
});
