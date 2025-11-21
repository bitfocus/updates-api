import * as Sentry from "@sentry/node";

const sentryDsn = process.env.SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    integrations: [Sentry.prismaIntegration()],
  });
  console.log("Sentry initialized");
} else {
  console.log("SENTRY_DSN not provided, Sentry not initialized");
}
