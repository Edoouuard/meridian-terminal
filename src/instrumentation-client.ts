/**
 * Browser error tracking (Sentry). Inert until NEXT_PUBLIC_SENTRY_DSN is set.
 * Unhandled errors and promise rejections are captured automatically; render
 * errors are reported by the error boundaries (app/error.tsx,
 * app/global-error.tsx, components/ErrorBoundary.tsx).
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // No IPs/user info, cookies (beta gate), headers, bodies or query strings.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    // Wallet extensions throw into the page constantly; they aren't Meridian's errors.
    denyUrls: [/^chrome-extension:\/\//, /^moz-extension:\/\//, /^safari-(web-)?extension:\/\//],
    ignoreErrors: ["User rejected the request", "User denied transaction signature"],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
