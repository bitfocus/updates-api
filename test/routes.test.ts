import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { makeReleases, releasesState } from "./releases-mock.js";
import { createTestApp, flushBackgroundWork } from "./app-harness.js";

vi.mock("../src/lib/releases.js", () => import("./releases-mock.js"));

let ctx: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.instance.close();
});
beforeEach(() => {
  ctx.db.calls.length = 0;
  ctx.db.state.fail = false;
  releasesState.companion = makeReleases("4.2.3", "4.1.5");
  releasesState.satellite = makeReleases("3.7.2", "3.6.1");
});

function post(url: string, body: unknown) {
  return ctx.app.instance.inject({ method: "POST", url, payload: body as any });
}

const companionUpdateBody = {
  id: "0b1a7a9e-6c1f-4b8e-9f0e-2f7a3c6d9e11",
  app: {
    name: "companion",
    version: "4.2.1",
    build: "4.2.1+7990-stable-ee7c3daa",
  },
  os: { platform: "linux", arch: "x64", release: "6.8.0-45-generic" },
};

test("root redirects to the website", async () => {
  const res = await ctx.app.instance.inject({ method: "GET", url: "/" });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("https://companion.free");
});

describe("POST /updates", () => {
  test("returns the update message and records the user", async () => {
    const res = await post("/updates", companionUpdateBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      type: "update",
      version: "4.2.3",
      message: "A new bugfix release (v4.2.3) is available.",
      link: "https://bitfocus.io/account/downloads?companion_inapp_stable",
    });

    await flushBackgroundWork();
    expect(ctx.db.calls).toEqual([
      {
        model: "user",
        method: "upsert",
        args: {
          where: {
            user_id_app_name: {
              user_id: companionUpdateBody.id,
              app_name: "companion",
            },
          },
          update: {
            app_version: "4.2.1",
            app_build: "4.2.1+7990-stable-ee7c3daa",
            os_platform: "linux",
            os_arch: "x64",
            os_release: "6.8.0-45-generic",
          },
          create: {
            user_id: companionUpdateBody.id,
            app_name: "companion",
            app_version: "4.2.1",
            app_build: "4.2.1+7990-stable-ee7c3daa",
            os_platform: "linux",
            os_arch: "x64",
            os_release: "6.8.0-45-generic",
          },
        },
      },
    ]);
  });

  test("still responds when the database write fails", async () => {
    ctx.db.state.fail = true;
    const res = await post("/updates", companionUpdateBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  test("routes satellite to the satellite releases", async () => {
    const res = await post("/updates", {
      ...companionUpdateBody,
      app: { name: "satellite", version: "3.6.1", build: "3.6.1" },
    });
    expect(res.json()).toEqual({
      ok: true,
      type: "update",
      version: "3.7.2",
      message: "A new stable version (v3.7.2) is available.",
      link: "https://bitfocus.io/account/downloads?satellite_inapp_stable",
    });
  });

  test("unknown apps get an empty message", async () => {
    const res = await post("/updates", {
      ...companionUpdateBody,
      app: { name: "something-else", version: "1.0.0", build: "1.0.0" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, type: "none", message: "" });
  });

  test("clamps long values to the column lengths", async () => {
    await post("/updates", {
      ...companionUpdateBody,
      os: {
        platform: "p".repeat(40),
        arch: "a".repeat(40),
        release: "r".repeat(100),
      },
    });
    await flushBackgroundWork();
    expect((ctx.db.calls[0].args as any).update).toMatchObject({
      os_platform: "p".repeat(16),
      os_arch: "a".repeat(8),
      os_release: "r".repeat(48),
    });
  });

  test("ignores unexpected query parameters", async () => {
    const res = await post("/updates?utm_source=proxy", companionUpdateBody);
    expect(res.statusCode, res.body).toBe(200);
  });

  test("rejects a body missing os", async () => {
    const { os: _os, ...body } = companionUpdateBody;
    const res = await post("/updates", body);
    expect(res.statusCode).toBe(400);
    expect(ctx.db.calls).toEqual([]);
  });
});

describe("POST /updates-old", () => {
  test("responds with only message and link", async () => {
    const res = await post("/updates-old", {
      id: "0b1a7a9e6c1f4b8e9f0e2f7a3c6d9e11",
      app_name: "companion",
      app_version: "2.4.2",
      app_build: "2.4.2-a8b2c3d",
      platform: "win32",
      arch: "x64",
      release: "10.0.19045",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      message:
        "This is a very old version of Companion. Companion has improved a lot, we strongly recommend updating",
      link: "https://bitfocus.io/account/downloads?companion_inapp_ancient",
    });
  });
});

describe("POST /companion/old-metrics", () => {
  test("records surfaces with no type as unknown", async () => {
    const res = await post("/companion/old-metrics", {
      i: "7hD2kPz9QmXcV4bN1sLwE",
      r: 7201.002,
      m: {},
      mv: {},
      // Companion 4.0 drops undefined type and description from the JSON
      s: {
        "emberplus-1234": {},
        "streamdeck:CL15K1A01234": { type: "elgato-streamdeck" },
      },
    });
    expect(res.json()).toEqual({ ok: true });

    const dailyUsage = ctx.db.calls.find(
      (c) => c.model === "surfaceDailyUsage" && c.method === "createMany",
    );
    expect((dailyUsage?.args as any).data).toEqual([
      expect.objectContaining({ module_name: "unknown", max_count: 1 }),
      expect.objectContaining({
        module_name: "elgato-streamdeck",
        max_count: 1,
      }),
    ]);
    expect(JSON.stringify(ctx.db.calls)).not.toContain('"undefined"');
  });
});
