import { readFileSync } from "node:fs";

import { defineConfig } from "@hey-api/openapi-ts";

const inputPath = process.env.IZAP_OPENAPI_INPUT ?? "openapi/izap-public.json";
const outputPath = process.env.IZAP_OPENAPI_OUTPUT ?? "src/generated";

type Parameter = { in?: string; name?: string; required?: boolean };
type Operation = { parameters?: Parameter[] };

// The client sends `business-id` from createClient({ businessId }), so callers
// must not be forced to repeat it on every operation.
function makeBusinessIdHeaderOptional(spec: {
  paths?: Record<string, Record<string, unknown>>;
  components?: { parameters?: Record<string, Parameter> };
}): void {
  const relax = (parameter: Parameter | undefined) => {
    if (
      parameter?.in === "header" &&
      parameter.name?.toLowerCase() === "business-id"
    ) {
      parameter.required = false;
    }
  };
  Object.values(spec.components?.parameters ?? {}).forEach(relax);
  for (const item of Object.values(spec.paths ?? {})) {
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) value.forEach(relax);
      else (value as Operation | undefined)?.parameters?.forEach(relax);
    }
  }
}

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
];

// Path forms that template an undeclared `{business_id}` are left out; the business-id header scopes requests (GOG-4065).
function dropUndeclaredPathForms(spec: {
  paths?: Record<string, Record<string, unknown>>;
}): void {
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const shared = (item.parameters as Parameter[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const operation = item[method] as Operation | undefined;
      if (!operation) continue;
      const declared = new Set(
        [...shared, ...(operation.parameters ?? [])]
          .filter((p) => p.in === "path")
          .map((p) => p.name),
      );
      if (templated.some((name) => !declared.has(name))) delete item[method];
    }
    if (!HTTP_METHODS.some((method) => method in item))
      delete spec.paths![path];
  }
}

const spec = JSON.parse(readFileSync(inputPath, "utf8"));
makeBusinessIdHeaderOptional(spec);
dropUndeclaredPathForms(spec);

export default defineConfig({
  input: spec,
  output: {
    path: outputPath,
    module: { extension: ".js" },
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/client-fetch",
      baseUrl: false,
      throwOnError: true,
    },
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "single",
        containerName: "IzapApi",
      },
    },
  ],
});
