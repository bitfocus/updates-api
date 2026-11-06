import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeReleases, releasesState } from "./releases-mock.js";
import {
  prepareCompanionResponse,
  prepareSatelliteResponse,
} from "../src/update.js";

vi.mock("../src/lib/releases.js", () => import("./releases-mock.js"));

const UP_TO_DATE = { ok: true, message: "" };

describe("prepareCompanionResponse", () => {
  // currentStable 4.2.3, oldStable 4.1.5: anything below 4.1.0 is obsolete
  beforeEach(() => {
    releasesState.companion = makeReleases("4.2.3", "4.1.5");
  });

  const NEW_STABLE = {
    ok: true,
    message: "A new stable version (v4.2.3) is available.",
    link: "https://user.bitfocus.io/download?companion_inapp_stable",
  };
  const BUGFIX = {
    ok: true,
    message: "A new bugfix release (v4.2.3) is available.",
    link: "https://user.bitfocus.io/download?companion_inapp_stable",
  };
  const OBSOLETE = {
    ok: true,
    message:
      "This version of Companion is outdated and no longer supported. Please update to the latest version v4.2.3.",
    link: "https://user.bitfocus.io/download?companion_inapp_obsolete",
  };
  const BETA = {
    ok: true,
    message: "Remember, this is a beta version!",
    link: "https://user.bitfocus.io/download?companion_inapp_beta",
  };
  const EXPERIMENTAL = {
    ok: true,
    message: "EXPERIMENTAL: Thank you for testing these experimental features!",
    link: "https://companion.free?companion_inapp_beyond",
  };

  test.each([
    // Current stable branch
    ["latest stable", "4.2.3+8001-stable-ee7c3daa", UP_TO_DATE],
    ["leading v", "v4.2.3+8001-stable-ee7c3daa", UP_TO_DATE],
    ["full length hash", "4.2.3+8001-stable-ee7c3daaee7c3daaee7c3daaee7c3daaee7c3daa", UP_TO_DATE],
    ["behind on current branch", "4.2.1+7990-stable-ee7c3daa", BUGFIX],
    ["first release of current branch", "4.2.0+7980-stable-ee7c3daa", BUGFIX],
    ["stable-<branch> build kind", "4.2.1+7990-stable-4.2-ee7c3daa", BUGFIX],

    // Old stable branch
    ["behind on old stable branch", "4.1.2+7800-stable-ee7c3daa", NEW_STABLE],
    ["latest of old stable branch", "4.1.5+7850-stable-ee7c3daa", NEW_STABLE],

    // Releases cache is stale, or the client is newer than the latest release
    ["ahead on current branch", "4.2.4+8010-stable-ee7c3daa", UP_TO_DATE],
    ["newer minor", "4.3.0+8100-stable-ee7c3daa", UP_TO_DATE],
    ["newer major", "5.0.0+9000-stable-ee7c3daa", UP_TO_DATE],

    // Older than the old stable branch
    ["obsolete patch release", "4.0.7+7500-stable-ee7c3daa", OBSOLETE],
    ["obsolete major", "3.5.2+7000-stable-ee7c3daa", OBSOLETE],
    ["obsolete beta", "4.0.0+7400-beta-ee7c3daa", OBSOLETE],

    // Non-stable builds
    ["beta", "4.3.0+8200-beta-ee7c3daa", BETA],
    ["main branch build", "4.3.0+8200-main-ee7c3daa", BETA],
    ["beta of the current branch", "4.2.4+8020-beta-ee7c3daa", BETA],
    ["feature branch build", "4.3.0+8200-feat-some-thing-ee7c3daa", EXPERIMENTAL],
    ["unrecognised build kind", "4.2.3+8001-nightly-ee7c3daa", EXPERIMENTAL],
  ])("%s (%s)", async (_name, build, expected) => {
    expect(await prepareCompanionResponse(build)).toEqual(expected);
  });

  describe("unparseable builds", () => {
    test.each([
      ["empty", ""],
      ["garbage", "not-a-version"],
      ["only major.minor", "4.2"],
    ])("%s (%s)", async (_name, build) => {
      expect(await prepareCompanionResponse(build)).toEqual({
        ok: true,
        message: "Unable to check updates: Invalid version format",
      });
    });

    test.each([
      ["plain version", "4.2.3"],
      ["no build number", "4.2.3+stable-ee7c3daa"],
      ["no hash", "4.2.3+8001-stable"],
      ["short hash", "4.2.3+8001-stable-ee7c3d"],
      ["non-hex hash", "4.2.3+8001-stable-zzzzzzzz"],
      ["3.x prerelease style", "3.0.0-rc2+5100-beta-ee7c3daa"],
    ])("%s (%s)", async (_name, build) => {
      expect(await prepareCompanionResponse(build)).toEqual({
        ok: true,
        message: "Unable to check updates: Unknown build format",
      });
    });
  });

  test.each([
    ["2.4.2-a8b2c3d"],
    ["2.1.0+2200-stable-a8b2c3d"],
    ["1.4.0"],
  ])("ancient version (%s)", async (build) => {
    expect(await prepareCompanionResponse(build)).toEqual({
      ok: true,
      message:
        "This is a very old version of Companion. Companion has improved a lot, we strongly recommend updating",
      link: "https://user.bitfocus.io/download?companion_inapp_ancient",
    });
  });

  test("ancient versions don't depend on the releases being known", async () => {
    releasesState.companion = null;
    expect(await prepareCompanionResponse("2.4.2-a8b2c3d")).toMatchObject({
      ok: true,
    });
  });

  test.each([
    ["stable", "4.2.3+8001-stable-ee7c3daa"],
    ["beta", "4.3.0+8200-beta-ee7c3daa"],
  ])("asks the client to retry when releases are unknown (%s)", async (_name, build) => {
    releasesState.companion = null;
    expect(await prepareCompanionResponse(build)).toEqual({
      ok: false,
      message: "",
    });
  });

  test("old stable on a previous major", async () => {
    releasesState.companion = makeReleases("5.0.1", "4.2.3");

    expect(await prepareCompanionResponse("4.2.1+7990-stable-ee7c3daa")).toEqual({
      ok: true,
      message: "A new stable version (v5.0.1) is available.",
      link: "https://user.bitfocus.io/download?companion_inapp_stable",
    });
    expect(await prepareCompanionResponse("4.1.5+7850-stable-ee7c3daa")).toMatchObject({
      link: "https://user.bitfocus.io/download?companion_inapp_obsolete",
    });
  });
});

describe("prepareSatelliteResponse", () => {
  beforeEach(() => {
    releasesState.satellite = makeReleases("3.7.2", "3.6.1");
  });

  const NEW_STABLE = {
    ok: true,
    message: "A new stable version (v3.7.2) is available.",
    link: "https://user.bitfocus.io/download?satellite_inapp_stable",
  };
  const BUGFIX = {
    ok: true,
    message: "A new bugfix release (v3.7.2) is available.",
    link: "https://user.bitfocus.io/download?satellite_inapp_stable",
  };
  const BETA = {
    ok: true,
    message: "Remember, this is a beta version!",
    link: "https://user.bitfocus.io/download?satellite_inapp_beta",
  };

  test.each([
    ["latest", "3.7.2", UP_TO_DATE],
    ["leading v", "v3.7.2", UP_TO_DATE],
    ["latest with build metadata", "3.7.2+abcdef0", UP_TO_DATE],
    ["ahead of latest", "3.8.0", UP_TO_DATE],
    ["behind on current branch", "3.7.0", BUGFIX],
    ["old branch", "3.6.1", NEW_STABLE],
    ["very old", "1.2.0", NEW_STABLE],
    ["beta", "3.8.0-1234+abcdef0", BETA],
    ["beta older than latest", "3.7.0-1100+abcdef0", BETA],
  ])("%s (%s)", (_name, build, expected) => {
    expect(prepareSatelliteResponse(build)).toEqual(expected);
  });

  test.each([[""], ["not-a-version"], ["3.7"]])(
    "invalid version (%s)",
    (build) => {
      expect(prepareSatelliteResponse(build)).toEqual({
        ok: true,
        message: "Unable to check updates: Invalid version format",
      });
    }
  );

  test("betas don't depend on the releases being known", () => {
    releasesState.satellite = null;
    expect(prepareSatelliteResponse("3.8.0-1234+abcdef0")).toEqual(BETA);
  });

  test("asks the client to retry when releases are unknown", () => {
    releasesState.satellite = null;
    expect(prepareSatelliteResponse("3.7.2")).toEqual({
      ok: false,
      message: "",
    });
  });
});
