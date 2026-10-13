/**
 * Server and edge error tracking (Sentry). Inert until SENTRY_DSN (or
 * NEXT_PUBLIC_SENTRY_DSN) is set, so local runs and CI send nothing.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    // Errors and the execution journal only: no performance tracing.
    tracesSampleRate: 0,
    // No IPs/user info, cookies (beta gate), headers, bodies or query strings.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
  });
}

/** Errors thrown in route handlers, server components and the proxy. */
export const onRequestError = Sentry.captureRequestError;
