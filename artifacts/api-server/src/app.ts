import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./middlewares/auth";
import { protectMutations, safeErrors, securityHeaders } from "./middlewares/security";

const app: Express = express();
app.disable("x-powered-by");
// One trusted platform proxy hop; do not trust arbitrary forwarding chains.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(securityHeaders);
app.use(cookieParser());
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.use("/api", protectMutations);
app.use("/api/admin", requireAuth, (req, res, next) => {
  if (req.user?.role !== "ADMIN") {
    req.log.warn({ event: "admin_denied" }, "Administrator access denied");
    res.status(403).json({ error: "Administrator access is required." }); return;
  }
  next();
});
app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "This operation is not available." }); });
app.use(safeErrors);

export default app;
