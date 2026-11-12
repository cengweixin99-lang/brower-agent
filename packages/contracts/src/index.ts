export interface HealthResponse {
  service: "api" | "browser-worker";
  status: "ok";
}

export interface EnvironmentReport {
  status: "ok";
  nodeVersion: string;
}
