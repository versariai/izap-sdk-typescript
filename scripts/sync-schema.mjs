#!/usr/bin/env node
// Refreshes the vendored input schema (openapi/izap-public.json) that `npm run generate` reads.
//
//   npm run sync:schema                                   # from the monorepo's devdocs export
//   IZAP_OPENAPI_INPUT=<file|https-url> npm run sync:schema
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "openapi/izap-public.json");
const source =
  process.env.IZAP_OPENAPI_INPUT ??
  resolve(root, "../../doc/external/devdocs/api-reference/openapi.json");

async function load(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`GET ${location} returned HTTP ${response.status}`);
    }
    return response.text();
  }
  return readFile(location, "utf8");
}

const spec = JSON.parse(await load(source));
if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
  console.error(`${source} is not an OpenAPI 3.x document.`);
  process.exit(1);
}

await writeFile(target, `${JSON.stringify(spec, null, 2)}\n`);

const operations = Object.values(spec.paths ?? {}).flatMap((item) =>
  Object.keys(item).filter((key) =>
    ["get", "put", "post", "delete", "patch", "head", "options"].includes(key),
  ),
);
console.log(
  `Wrote ${target} from ${source} (${operations.length} operations). Run \`npm run generate\` next.`,
);
