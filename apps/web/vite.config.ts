import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${env.API_PORT ?? "3100"}`,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
