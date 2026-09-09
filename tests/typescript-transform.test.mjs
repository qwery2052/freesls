import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SourceMap } from "node:module";
import { createJiti } from "jiti";
import { createTypeScriptTransform } from "../dist/typescript-transform.js";

async function runtime(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-transform-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jiti = createJiti(directory, {
    sourceMaps: true,
    fsCache: false,
    moduleCache: false,
    tryNative: false,
  });
  jiti.options.transform = createTypeScriptTransform(jiti.options.transform);
  return { directory, jiti };
}

test("passes JavaScript and Jiti transform options through unchanged", () => {
  const options = {
    source: "export default 1",
    filename: "handler.js",
    ts: false,
    async: true,
    interopDefault: true,
  };
  const result = { code: "transformed" };
  const transform = createTypeScriptTransform(received => {
    assert.equal(received, options);
    return result;
  });
  assert.equal(transform(options), result);
});

test("composes source maps back to the original decorated TypeScript", async t => {
  const { directory, jiti } = await runtime(t);
  const source = `function dec() { return () => {}; }
export class Dto {
  @dec() message!: string;
  fail() {
    throw new Error('mapped failure');
  }
}`;
  const code = jiti.transform({
    source,
    filename: path.join(directory, "dto.ts"),
    ts: true,
    async: true,
  });
  const encoded = code.match(/sourceMappingURL=data:application\/json[^,]*,([^\s]+)/)?.[1];
  assert.ok(encoded, "inline source map is present");
  const payload = JSON.parse(Buffer.from(encoded, "base64").toString());
  assert.deepEqual(payload.sourcesContent, [source]);
  const lines = code.split("\n");
  const line = lines.findIndex(line => line.includes("throw new Error"));
  const entry = new SourceMap(payload).findEntry(line, lines[line].indexOf("throw"));
  assert.equal(entry.originalLine, 4);
  assert.equal(entry.originalColumn, 4);
  assert.match(entry.originalSource, /dto\.ts$/);
});

test("honors disabled metadata, standard decorators, JSX and config edits", async t => {
  const { directory, jiti } = await runtime(t);
  const config = path.join(directory, "tsconfig.json");
  const filename = path.join(directory, "dto.ts");
  const source =
    "function dec() { return () => {}; } export class Dto { @dec() message!: string; }";
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: false },
    }),
  );
  const withoutMetadata = jiti.transform({ source, filename, ts: true });
  assert.doesNotMatch(withoutMetadata, /design:type/);
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
    }),
  );
  assert.match(jiti.transform({ source, filename, ts: true }), /design:type/);
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        experimentalDecorators: false,
        jsx: "react",
        jsxFactory: "h",
      },
    }),
  );
  await writeFile(
    path.join(directory, "handler.tsx"),
    `
    function field(value, context) { return initial => initial + '-decorated'; }
    class Dto { @field message = 'hello'; }
    function h(tag, props, child) { return { tag, child }; }
    export default <p>{new Dto().message}</p>;
  `,
  );
  assert.deepEqual(await jiti.import(path.join(directory, "handler.tsx"), { default: true }), {
    tag: "p",
    child: "hello-decorated",
  });
});

test("reports invalid configuration and TypeScript syntax rather than running partial output", async t => {
  const { directory, jiti } = await runtime(t);
  const filename = path.join(directory, "dto.ts");
  assert.throws(
    () => jiti.transform({ source: "export const broken = ;", filename, ts: true }),
    /Expression expected/,
  );
  await writeFile(path.join(directory, "tsconfig.json"), '{ "extends": "./missing.json" }');
  assert.throws(
    () => jiti.transform({ source: "export const value = 1;", filename, ts: true }),
    /missing\.json/,
  );
});
