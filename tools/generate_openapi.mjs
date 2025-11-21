#!/usr/bin/env zx
import { $ } from "zx";

await $`yarn openapi-typescript https://api.bitfocus.io/openapi.json -o ./src/generated/bitfocus-api.ts`;

// await $`yarn prettier -w ./src/generated/bitfocus-api.ts`;

// strip ["schema"] from the schema as it seems confused..
await $`sed -i 's/\\["schema"\\]//g' ./src/generated/bitfocus-api.ts`;
