import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { registerAiRoutes } from "./ai";
import { registerPlanRoutes } from "./planRoutes";
import { personalPlanEnabled } from "./chatgpt";

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
const port = Number(process.env.PORT || 3000);
app.disable("x-powered-by");
app.use(express.json({ limit: "24mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    aiConfigured: false,
    storage: "browser-local",
    version: "0.3.1",
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
  }),
);
registerPlanRoutes(app);
registerAiRoutes(app);
app.post("/api/analyze", (_req, res) => res.status(503).json({ error: "기존 치수 전용 AI 연결은 비활성입니다. CSV/TXT 판독과 브라우저 이미지 추정은 키 없이 사용할 수 있습니다. ChatGPT 사용량 연결은 공식 인증과 실제 요청 검증 전입니다." }));
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "존재하지 않는 API입니다." });
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true, host: "0.0.0.0", allowedHosts: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(
  (
    err: Error & { type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status(err.type === "entity.too.large" ? 413 : 400)
      .json({
        error:
          err.type === "entity.too.large"
            ? "첨부 자료가 너무 큽니다. 자료 수나 이미지 크기를 줄여 주세요."
            : "요청 형식을 확인해 주세요.",
      });
  },
);
const server = app.listen(port, personalPlanEnabled() ? "127.0.0.1" : "0.0.0.0");
server.on("listening", () =>
  console.log(
    `TRADIATIVE Studio listening on port ${port} (${process.env.NODE_ENV === "production" ? "production" : "development"})`,
  ),
);
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `Server startup failed on port ${port}: ${error.code || error.message}`,
  );
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
