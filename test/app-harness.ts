import type { APIServer } from "@bitfocusas/api";
import type { PrismaClient } from "../src/prisma/client.js";
import { createApp } from "../src/app.js";

export interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * A PrismaClient stand-in that records every call and returns an "empty database" result,
 * so the writers take their insert paths. Set `fail` to make every call reject.
 */
export function createFakePrisma() {
  const calls: PrismaCall[] = [];
  const state = { fail: false };

  const resultFor = (method: string, args: any): unknown => {
    switch (method) {
      case "findMany":
        return [];
      case "findUnique":
      case "findFirst":
        return null;
      case "createMany":
        return { count: Array.isArray(args?.data) ? args.data.length : 1 };
      case "updateMany":
      case "deleteMany":
        return { count: 0 };
      default:
        // create, upsert, findUniqueOrThrow, ...
        return { id: 1 };
    }
  };

  const prisma = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== "string" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_target, method) {
              if (typeof method !== "string" || method === "then")
                return undefined;
              return async (args: unknown) => {
                calls.push({ model, method, args });
                if (state.fail) throw new Error("Fake database failure");
                return resultFor(method, args);
              };
            },
          }
        );
      },
    }
  ) as PrismaClient;

  return { prisma, calls, state };
}

export async function createTestApp(): Promise<{
  app: APIServer;
  db: ReturnType<typeof createFakePrisma>;
}> {
  const db = createFakePrisma();
  const app = createApp(db.prisma, {
    logLevel: "silent",
    // inject() requests come from 127.0.0.1, which is rate limited by default
    rateLimitAllow: ["127.0.0.1"],
  });
  await app.instance.ready();
  return { app, db };
}

/** Wait for handlers that write to the database in the background */
export function flushBackgroundWork() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
