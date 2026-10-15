#!/usr/bin/env node
// Fails when src/generated/ is not exactly what `npm run generate` produces from the
// vendored schema. Generates into a temp dir so the check never touches the tree.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committed = join(root, "src/generated");
const fresh = mkdtempSync(join(tmpdir(), "izap-sdk-generated-"));

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => statSync(join(dir, file)).isFile())
    .sort();
}

try {
  const result = spawnSync("npm", ["run", "--silent", "generate"], {
    cwd: root,
    env: { ...process.env, IZAP_OPENAPI_OUTPUT: fresh },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const expected = listFiles(fresh);
  const actual = listFiles(committed);
  const drift = [
    ...expected
      .filter((file) => !actual.includes(file))
      .map((file) => `missing   ${file}`),
    ...actual
      .filter((file) => !expected.includes(file))
      .map((file) => `extra     ${file}`),
    ...expected
      .filter((file) => actual.includes(file))
      .filter(
        (file) =>
          readFileSync(join(fresh, file), "utf8") !==
          readFileSync(join(committed, file), "utf8"),
      )
      .map((file) => `modified  ${file}`),
  ];

  if (drift.length > 0) {
    console.error(
      "src/generated/ is out of date with openapi/izap-public.json:",
    );
    drift.forEach((line) => console.error(`  ${line}`));
    console.error("Run `npm run generate` and commit the result.");
    process.exit(1);
  }
  console.log(`src/generated/ is up to date (${expected.length} files).`);
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
