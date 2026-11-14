import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DemoEvidence } from "../../../evals/graders/demo.ts";
import { getDemoTask } from "../../../evals/tasks/demo.ts";
import { categories, type FormValues, formTopics, offices, products } from "./data.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}
async function body(request: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Body too large");
    buffers.push(buffer);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
}
function draft(value: unknown): { revision: number; fields: FormValues } {
  if (!value || typeof value !== "object" || !("revision" in value) || !("fields" in value))
    throw new Error("Invalid draft");
  const fields = value.fields;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !fields ||
    typeof fields !== "object" ||
    !("name" in fields) ||
    typeof fields.name !== "string" ||
    fields.name.length > 100 ||
    !("email" in fields) ||
    typeof fields.email !== "string" ||
    fields.email.length > 200 ||
    !("topic" in fields) ||
    typeof fields.topic !== "string" ||
    !formTopics.some((topic) => topic === fields.topic) ||
    !("note" in fields) ||
    typeof fields.note !== "string" ||
    fields.note.length > 2000 ||
    !("newsletter" in fields) ||
    typeof fields.newsletter !== "boolean"
  )
    throw new Error("Invalid draft");
  return {
    revision: value.revision,
    fields: {
      name: fields.name,
      email: fields.email,
      topic: fields.topic,
      note: fields.note,
      newsletter: fields.newsletter,
    },
  };
}

function form(base: string): string {
  return page(
    "联系表单",
    `<form method="post" action="${base}submit" id="contact">
    <label>姓名<input name="name" autocomplete="off"></label>
    <label>邮箱<input name="email" type="email" autocomplete="off"></label>
    <label>主题<select name="topic">${formTopics.map((topic) => `<option>${topic}</option>`).join("")}</select></label>
    <label>留言<textarea name="note"></textarea></label>
    <label><input name="newsletter" type="checkbox" checked>订阅</label>
    <button type="submit">提交</button></form><p id="draft-status" role="status">尚未填写</p>
    <script>
    const form = document.getElementById("contact");
    const status = document.getElementById("draft-status");
    let revision = 0;
    let pending = Promise.resolve();
    function saveDraft() {
      const data = new FormData(form);
      const payload = {revision: ++revision, fields: {name: data.get("name"), email: data.get("email"), topic: data.get("topic"), note: data.get("note"), newsletter: data.has("newsletter")}};
      status.textContent = "正在记录草稿";
      pending = pending.then(() => fetch(${JSON.stringify(`${base}draft`)}, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(payload)})).then(response => {
        if (!response.ok) throw new Error("Draft failed");
        if (payload.revision === revision) status.textContent = "草稿已记录，尚未提交";
      }).catch(() => {status.textContent = "草稿记录失败";});
    }
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    </script>`,
  );
}

export async function createDemoFixture(): Promise<{
  origin: string;
  createAttempt(caseId: string): { attemptId: string; startUrl: string };
  evidence(attemptId: string): DemoEvidence;
  close(): Promise<void>;
}> {
  const attempts = new Map<string, DemoEvidence>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, "Invalid fixture request");
      else response.end();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const [, attemptId, ...parts] = url.pathname.split("/");
    const state = attemptId ? attempts.get(attemptId) : undefined;
    if (!state) {
      send(response, 404, "Unknown attempt");
      return;
    }
    const path = `/${parts.join("/")}`;
    const base = `/${attemptId}/`;
    if (request.method === "POST" && path === "/submit") {
      state.submissions++;
      state.lastPath = path;
      request.resume();
      send(response, 200, page("已提交", "测试表单已提交"));
      return;
    }
    if (request.method === "POST" && path === "/draft") {
      const update = draft(await body(request));
      if (state.lastPath !== "/form" || update.revision <= state.draftRevision) {
        send(response, 409, "Stale draft");
        return;
      }
      state.draftRevision = update.revision;
      state.draft = update.fields;
      send(response, 200, "Recorded");
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, "Method not allowed");
      return;
    }
    if (path === "/") {
      state.lastPath = path;
      send(
        response,
        200,
        page(
          "浏览器任务测试站",
          `<nav><a href="${base}facts">服务点目录</a> <a href="${base}catalog">商品目录</a> <a href="${base}form">联系表单</a></nav>`,
        ),
      );
      return;
    }
    if (path === "/facts") {
      state.lastPath = path;
      send(
        response,
        200,
        page(
          "服务点目录",
          offices
            .map((office) => `<p><a href="${base}facts/${office.id}">${office.name}服务点</a></p>`)
            .join(""),
        ),
      );
      return;
    }
    const office = offices.find((office) => path === `/facts/${office.id}`);
    if (office) {
      state.lastPath = path;
      if (!state.visitedOffices.includes(office.id)) state.visitedOffices.push(office.id);
      send(
        response,
        200,
        page(
          `${office.name}服务点`,
          `<p>工作日营业时间：<strong>${office.hours}</strong></p><p>周末不营业。</p><a href="${base}facts">返回目录</a>`,
        ),
      );
      return;
    }
    if (path === "/catalog") {
      const category = url.searchParams.get("category") ?? "";
      const rawPrice = url.searchParams.get("maxPrice") ?? "";
      const maxPrice = rawPrice === "" ? null : Number(rawPrice);
      if (
        (category !== "" && !categories.some((item) => item === category)) ||
        (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0))
      ) {
        send(response, 400, "Invalid filters");
        return;
      }
      state.lastPath = path;
      state.detailId = null;
      state.filter = category && maxPrice !== null ? { category, maxPrice } : null;
      const visible = products.filter(
        (product) =>
          (!category || product.category === category) && (maxPrice === null || product.price <= maxPrice),
      );
      send(
        response,
        200,
        page(
          "商品目录",
          `<form method="get"><label>类别<select name="category"><option value="">全部</option>${categories.map((item) => `<option${item === category ? " selected" : ""}>${item}</option>`).join("")}</select></label><label>最高价格<input type="number" name="maxPrice" value="${escapeHtml(rawPrice)}"></label><button>筛选</button></form><ul>${visible.map((product) => `<li><a href="${base}items/${product.id}">${product.name}</a> ${product.price}元 ${product.available ? "有货" : "缺货"}</li>`).join("")}</ul>`,
        ),
      );
      return;
    }
    const product = products.find((product) => path === `/items/${product.id}`);
    if (product) {
      state.lastPath = path;
      state.detailId = product.id;
      send(
        response,
        200,
        page(
          product.name,
          `<p>商品编号：${product.id}</p><p>类别：${product.category}</p><p>价格：${product.price}元</p><p>${product.available ? "有货" : "缺货"}</p>`,
        ),
      );
      return;
    }
    if (path === "/form") {
      state.lastPath = path;
      state.draft = null;
      state.draftRevision = 0;
      send(response, 200, form(base));
      return;
    }
    send(response, 404, "Not found");
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No fixture port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    createAttempt(caseId) {
      getDemoTask(caseId);
      const attemptId = randomUUID();
      const baseUrl = `${origin}/${attemptId}/`;
      attempts.set(attemptId, {
        caseId,
        baseUrl,
        lastPath: "/",
        visitedOffices: [],
        filter: null,
        detailId: null,
        draft: null,
        draftRevision: 0,
        submissions: 0,
      });
      return { attemptId, startUrl: baseUrl };
    },
    evidence(attemptId) {
      const state = attempts.get(attemptId);
      if (!state) throw new Error("Unknown attempt");
      return structuredClone(state);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
