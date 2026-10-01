import pino from "pino"

const redactPaths = [
  "ADMIN_KEY",
  "SIGNER_SECRET_KEY",
  "WEBHOOK_SECRET",
  "API_KEY",
  "*.adminKey",
  "*.signerSecretKey",
  "*.webhookSecret",
  "*.apiKey",
  "req.headers.authorization",
  "req.headers.x-admin-key",
  "req.headers.x-api-key",
  "err.message",
  "error.message",
]

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "comebackhere-backend", correlationId: null },
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  ...(process.env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }
    : {}),
})