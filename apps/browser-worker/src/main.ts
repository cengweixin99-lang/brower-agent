import type { HealthResponse } from "@pba/contracts";
import Fastify from "fastify";

const server = Fastify({ logger: true });
server.get<{ Reply: HealthResponse }>("/healthz", async () => ({ service: "browser-worker", status: "ok" }));
await server.listen({
  host: process.env.BROWSER_HOST ?? "127.0.0.1",
  port: Number(process.env.BROWSER_PORT ?? 3101),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
