import type { HealthResponse } from "@pba/contracts";
import Fastify from "fastify";

const server = Fastify({ logger: true });
server.get<{ Reply: HealthResponse }>("/healthz", async () => ({ service: "api", status: "ok" }));
await server.listen({
  host: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3100),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
