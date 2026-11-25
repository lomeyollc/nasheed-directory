import type { D1Migration } from "cloudflare:test";

// The migrations are handed to the test worker as a binding by
// vitest.config.ts, so trigger tests can apply the real SQL.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
