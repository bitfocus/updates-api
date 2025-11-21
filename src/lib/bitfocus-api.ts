import createClient from "openapi-fetch";
import type { paths as BitfocusApiPaths } from "../generated/bitfocus-api.js";

export const BitfocusApi = createClient<BitfocusApiPaths>({
  baseUrl: "https://api.bitfocus.io/v1",
  headers: {
    "User-Agent": `Companion Updates Api`,
  },
});
