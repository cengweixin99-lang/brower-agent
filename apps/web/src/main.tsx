import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  const [status, setStatus] = useState("正在检查本地服务…");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      ["/api/healthz", "/browser/healthz"].map(async (url) => {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Service unavailable");
      }),
    ).then(
      () => setStatus("API 与浏览器服务进程已就绪"),
      () => {
        if (!controller.signal.aborted) setStatus("服务尚未就绪，请在项目根目录运行 pnpm dev");
      },
    );
    return () => controller.abort();
  }, []);
  return (
    <main>
      <p className="eyebrow">LOCAL DEVELOPMENT</p>
      <h1>Pi Browser Agent</h1>
      <p>基于 pi 的跨站浏览器 Agent 开发环境</p>
      <section>
        <h2>环境状态</h2>
        <p role="status">{status}</p>
        <p>当前提供开发骨架与连通性验证。任务执行、权限网关和人工接管待实现。</p>
      </section>
      <section>
        <h2>开发入口</h2>
        <ul>
          <li>
            API：<code>http://127.0.0.1:3100/healthz</code>
          </li>
          <li>
            浏览器服务：<code>http://127.0.0.1:3101/healthz</code>
          </li>
          <li>
            Temporal：<a href="http://127.0.0.1:8233">查看本地任务</a>
          </li>
        </ul>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
