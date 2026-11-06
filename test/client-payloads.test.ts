import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { makeReleases, releasesState } from "./releases-mock.js";
import { createTestApp } from "./app-harness.js";

vi.mock("../src/lib/releases.js", () => import("./releases-mock.js"));

/**
 * Real payloads sent by released Companion and Satellite versions, reconstructed from their source.
 * Old installs keep running for years, so every one of these must stay accepted.
 */
interface ClientPayloadFixture {
  source: { repo: string; tag: string; file: string; url: string };
  notes: string;
  body: unknown;
}

/**
 * The URLs clients post to, and the route each one ends up at.
 * The updates.bitfocus.io URLs rely on the reverse proxy rewriting them.
 */
const ROUTE_FOR_CLIENT_URL: Record<string, string> = {
  "https://updates.bitfocus.io/updates": "/updates-old",
  "https://updates.bitfocus.io/companion/metrics": "/companion/old-metrics",
  "https://updates.companion.free/updates": "/updates",
  "https://updates.companion.free/companion/detailed-usage":
    "/companion/detailed-usage",
  "https://updates.companion.free/satellite/detailed-usage":
    "/satellite/detailed-usage",
};

const fixturesDir = new URL("./fixtures/client-payloads/", import.meta.url);
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const fixture: ClientPayloadFixture = JSON.parse(
      readFileSync(new URL(name, fixturesDir), "utf8")
    );
    return { name, fixture };
  });

let ctx: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.instance.close();
});
beforeEach(() => {
  releasesState.companion = makeReleases("5.1.2", "5.0.7");
  releasesState.satellite = makeReleases("3.8.0", "3.7.0");
});

test("fixtures were found", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)("$name", ({ fixture }) => {
  test("is accepted by the server", async () => {
    const route = ROUTE_FOR_CLIENT_URL[fixture.source.url];
    expect(route, `no route known for ${fixture.source.url}`).toBeDefined();

    const res = await ctx.app.instance.inject({
      method: "POST",
      url: route,
      payload: fixture.body as object,
    });
    expect(res.statusCode, res.body).toBe(200);

    const json = res.json();
    if (route === "/updates-old") {
      // Legacy clients only understand message and link
      expect(["link", "message"]).toEqual(
        expect.arrayContaining(Object.keys(json))
      );
      expect(typeof json.message).toBe("string");
    } else if (route === "/updates") {
      expect(json.ok).toBe(true);
      expect(typeof json.message).toBe("string");
    } else {
      expect(json).toEqual({ ok: true });
    }
  });
});
