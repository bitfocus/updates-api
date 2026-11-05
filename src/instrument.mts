import * as Sentry from "@sentry/node";

const sentryDsn = process.env.SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // PII (eg IP addresses) is collected by default; tune via `dataCollection` if needed
    integrations: [
      Sentry.fastifyIntegration({
        shouldHandleError(error, _request, reply) {
          // Client disconnected mid-request, nothing we can do about it
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
            return false;

          // Errors thrown from hooks (eg rate-limit) carry their status on the error, not yet on the reply
          const statusCode =
            (error as { statusCode?: number }).statusCode ?? reply.statusCode;
          return statusCode >= 500 || statusCode <= 299;
        },
      }),
    ],
  });
  console.log("Sentry initialized");
} else {
  console.log("SENTRY_DSN not provided, Sentry not initialized");
}
