import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "password", "passwordHash", "token", "tokenHash", "secret",
    "body.password", "req.body", "databaseUrl", "connectionString",
  ],
  serializers: {
    // Prisma/driver errors can contain full queries, credentials and customer data.
    err(error) {
      return { type: error instanceof Error ? error.name : "Error",
        code: typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code) ? error.code : undefined,
        message: "Server operation failed" };
    },
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
