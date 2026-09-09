import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, normalizeBasePath, combinePaths } from "../dist/server.js";

async function fixture(t, files, definitions, defaultServerOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files))
    await writeFile(path.join(directory, name), source);
  const servers = [];
  t.after(async () => {
    await Promise.all(
      servers.map(
        server =>
          new Promise((resolve, reject) =>
            server.close(error => (error ? reject(error) : resolve())),
          ),
      ),
    );
  });
  async function listen(routes = definitions, serverOptions = defaultServerOptions) {
    const server = await startServer(
      routes.map(route => ({ functionName: "test", method: "any", environment: {}, ...route })),
      0,
      directory,
      serverOptions,
    );
    servers.push(server);
    return (url, options = {}) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: url,
            agent: false,
            ...options,
          },
          response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
                json: () => JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(options.body);
      });
  }
  return { request: await listen(), listen, directory };
}

test("circular controllers and services share instances and reload between requests", async t => {
  const service = value => `import { controller } from './app.module';
    export class Service {
      value = '${value}';
      loaded = process.env.FREESLS_CIRCULAR_ENV;
      same(instance) { return controller === instance; }
    }`;
  const { request, directory } = await fixture(
    t,
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          target: "ES2020",
          experimentalDecorators: true,
          paths: { "@app/*": ["./*"] },
        },
      }),
      "handler.ts": `import { controller } from 'app.module';
      import { service } from '@app/app.module';
      export async function run(event) {
        return { body: JSON.stringify({ ...(await controller.run(event)), same: service.same(controller), loaded: service.loaded }) };
      }`,
      "app.module.ts": `import { Controller } from './controller';
      import { Service } from './service';
      export const controller = new Controller();
      export const service = new Service();`,
      "controller.ts": `import { service } from './app.module';
      import { Body } from './body';
      class Dto { message!: string; }
      export class Controller {
        @Body(Dto)
        async run(event) { return { value: service.value, message: event.body.message }; }
      }`,
      "body.ts": `export const Body = dto => (_target, _key, descriptor) => {
      const original = descriptor.value;
      descriptor.value = function(event) {
        event.body = Object.assign(new dto(), JSON.parse(event.body));
        return original.call(this, event);
      };
      return descriptor;
    };`,
      "service.ts": service("first"),
    },
    ["first", "second"].map(value => ({
      path: `/${value}`,
      handler: "handler.run",
      environment: { FREESLS_CIRCULAR_ENV: value },
    })),
  );
  for (const value of ["first", "second"]) {
    await writeFile(path.join(directory, "service.ts"), service(value));
    const response = await request(`/${value}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"message":"hello"}',
    });
    assert.equal(response.status, 200, response.body.toString());
    assert.deepEqual(response.json(), { value, message: "hello", same: true, loaded: value });
  }
  await writeFile(
    path.join(directory, "service.ts"),
    "throw new Error('load failed'); export class Service {}",
  );
  assert.equal((await request("/first")).json().errorMessage, "load failed");
  await writeFile(path.join(directory, "service.ts"), service("recovered"));
  const recovered = await request("/first", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"message":"hello"}',
  });
  assert.equal(recovered.status, 200, recovered.body.toString());
  assert.deepEqual(recovered.json(), {
    value: "recovered",
    message: "hello",
    same: true,
    loaded: "first",
  });
});

test(
  "serializes import/invocation/restoration globally, including failures",
  { concurrency: false },
  async t => {
    const key = "FREESLS_SERVER_TEST_ENV";
    const original = process.env[key];
    process.env[key] = "host";
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
    const { request, listen } = await fixture(
      t,
      {
        "handler.ts": `const loaded = process.env.${key};
      export async function run() {
        const before = process.env.${key};
        await new Promise(resolve => setTimeout(resolve, 25));
        const after = process.env.${key};
        process.env.FREESLS_SERVER_TEST_ADDED = 'temporary';
        return { statusCode: 200, body: JSON.stringify({ loaded, before, after }) };
      }
      export function fail() { throw null; }`,
      },
      [
        { path: "/a", handler: "handler.run", environment: { [key]: "a" } },
        { path: "/fail", handler: "handler.fail", environment: { [key]: "failure" } },
      ],
    );
    const other = await listen([
      { path: "/b", handler: "handler.run", environment: { [key]: "b" } },
    ]);
    const results = await Promise.all([
      request("/a"),
      other("/b"),
      request("/fail"),
      request("/a"),
    ]);
    for (const [index, expected] of [
      [0, "a"],
      [1, "b"],
      [3, "a"],
    ])
      assert.deepEqual(results[index].json(), {
        loaded: expected,
        before: expected,
        after: expected,
      });
    assert.equal(results[2].status, 500);
    assert.equal(results[2].json().errorMessage, "null");
    assert.equal(process.env[key], "host");
    assert.equal(process.env.FREESLS_SERVER_TEST_ADDED, undefined);
  },
);

test(
  "native shared modules retain first import-time environment snapshots",
  { concurrency: false },
  async t => {
    for (const extension of ["mjs", "cjs"]) {
      const declaration = extension === "mjs" ? "export function run" : "exports.run = function";
      const { request } = await fixture(
        t,
        {
          [`handler.${extension}`]: `const loaded = process.env.FREESLS_NATIVE_TEST; ${declaration}() { return { statusCode: 200, body: JSON.stringify({ loaded, current: process.env.FREESLS_NATIVE_TEST }) }; }`,
        },
        [
          { path: "/a", handler: "handler.run", environment: { FREESLS_NATIVE_TEST: "a" } },
          { path: "/b", handler: "handler.run", environment: { FREESLS_NATIVE_TEST: "b" } },
        ],
      );
      assert.deepEqual((await request("/a")).json(), { loaded: "a", current: "a" });
      assert.deepEqual((await request("/b")).json(), { loaded: "a", current: "b" });
    }
  },
);

test("instantiates decorated DTOs with inherited tsconfig, aliases and metadata", async t => {
  const originalMetadata = Reflect.metadata;
  const metadata = new WeakMap();
  Reflect.metadata = (key, value) => (target, property) => {
    if (!metadata.has(target)) metadata.set(target, {});
    (metadata.get(target)[property ?? "class"] ??= {})[key] = value;
  };
  t.after(() => {
    if (originalMetadata === undefined) delete Reflect.metadata;
    else Reflect.metadata = originalMetadata;
  });
  // A minimal metadata consumer keeps this fixture independent of external packages.
  globalThis.__freeslsReadMetadata = (target, property, key) => {
    for (; target; target = Object.getPrototypeOf(target)) {
      const value = metadata.get(target)?.[property ?? "class"]?.[key];
      if (value) return Array.isArray(value) ? value.map(type => type.name) : value.name;
    }
    return null;
  };
  t.after(() => delete globalThis.__freeslsReadMetadata);
  for (const useDefineForClassFields of [true, false]) {
    const { request } = await fixture(
      t,
      {
        "base.json": JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "CommonJS",
            strict: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            useDefineForClassFields,
            baseUrl: ".",
            paths: { "@dto/*": ["./*"] },
            noEmit: true,
            importHelpers: true,
          },
        }),
        "tsconfig.json": '{ "extends": "./base.json" }',
        "dependency.mjs": 'await Promise.resolve(); export default "async-esm";',
        "common.cjs": 'module.exports = { value: "commonjs" };',
        "model.ts": "export class Model {}",
        "dto.ts": `import { Model } from '@dto/model';
        function dec(...args: unknown[]) { return (...args: unknown[]) => {}; }
        class Base { @dec() inherited: string = 'base'; }
        @dec()
        export class Dto extends Base {
          @dec() message!: string;
          @dec() optional?: number;
          @dec() initialized: string = 'ready';
          @dec() model!: Model;
          constructor(@dec() model: Model) { super(); this.model = model; this.message = 'hello'; }
          @dec() method(@dec() value: number): string { return String(value); }
        }`,
        "handler.ts": `import { Dto } from '@dto/dto';
        import { Model } from '@dto/model';
        import esm from './dependency.mjs';
        import common from './common.cjs';
        const loaded = await Promise.resolve(esm);
        export default { run() {
          const dto = new Dto(new Model());
          const read = globalThis.__freeslsReadMetadata;
          return { statusCode: 200, body: JSON.stringify({
            message: dto.message, optional: dto.optional ?? null, initialized: dto.initialized,
            inherited: dto.inherited, ownOptional: Object.hasOwn(dto, 'optional'),
            metadata: ['message', 'optional', 'initialized', 'inherited', 'model'].map(
              key => read(Dto.prototype, key, 'design:type')),
            params: read(Dto, undefined, 'design:paramtypes'),
            methodParams: read(Dto.prototype, 'method', 'design:paramtypes'),
            returns: read(Dto.prototype, 'method', 'design:returntype'),
            loaded, common: common.value, url: import.meta.url.endsWith('/handler.ts')
          }) };
        } };`,
      },
      [{ path: "/dto", handler: "handler.run" }],
    );
    for (let invocation = 0; invocation < 2; invocation++) {
      const response = await request("/dto");
      assert.equal(response.status, 200, response.body.toString());
      assert.deepEqual(response.json(), {
        message: "hello",
        optional: null,
        initialized: "ready",
        inherited: "base",
        ownOptional: useDefineForClassFields,
        metadata: ["String", "Number", "String", "String", "Model"],
        params: ["Model"],
        methodParams: ["Number"],
        returns: "String",
        loaded: "async-esm",
        common: "commonjs",
        url: true,
      });
    }
  }
});

test("legacy decorated required and optional DTO fields work without tsconfig", async t => {
  const { request } = await fixture(
    t,
    {
      "handler.ts": `function dec() { return () => {}; }
      class Dto { @dec() message!: string; @dec() optional?: string; }
      export function run() { const dto = new Dto(); dto.message = 'ok'; return { body: dto.message }; }`,
    },
    [{ path: "/", handler: "handler.run" }],
  );
  const response = await request("/");
  assert.equal(response.status, 200, response.body.toString());
  assert.equal(response.body.toString(), "ok");
});

test(
  "callback, context, promise and sync completion do not depend on arity",
  { concurrency: false },
  async t => {
    const { request } = await fixture(
      t,
      {
        "handler.ts": `
    const result = { statusCode: 201, body: 'ok' };
    export function callback(event, context, cb = () => {}) { setTimeout(() => cb(null, result), 5); }
    export function rest(...args) { setTimeout(() => args[2](null, result), 5); }
    export function done(event, context) { setTimeout(() => context.done(null, result), 5); }
    export function succeed(event, context) { context.succeed(result); }
    export function fail(event, context) { context.fail('failed'); }
    export async function promise() { return result; }
    export function sync() { return result; }
    export function race(event, context, cb) { cb(null, result); cb('ignored'); return Promise.reject('ignored'); }
    export function error() { throw { reason: 'broken' }; }
    export async function empty() {}
  `,
      },
      [
        "callback",
        "rest",
        "done",
        "succeed",
        "fail",
        "promise",
        "sync",
        "race",
        "error",
        "empty",
      ].map(name => ({ path: `/${name}`, handler: `handler.${name}` })),
    );
    for (const name of ["callback", "rest", "done", "succeed", "promise", "sync", "race"]) {
      const response = await request(`/${name}`);
      assert.equal(response.status, 201, name);
      assert.equal(response.body.toString(), "ok");
    }
    assert.equal((await request("/fail")).json().errorMessage, "failed");
    assert.equal((await request("/error")).json().errorMessage, '{"reason":"broken"}');
    assert.equal((await request("/empty")).body.length, 0);
  },
);

test(
  "v1/v2 events preserve binary data, repeated headers, queries and quoted params",
  { concurrency: false },
  async t => {
    const { request } = await fixture(
      t,
      {
        "handler.ts":
          "export function run(event) { return { statusCode: 200, body: JSON.stringify(event) }; }",
      },
      [
        { path: "/v1/{user-id}/{1name}", handler: "handler.run" },
        { path: "/v2/{proxy-name+}", handler: "handler.run", payloadVersion: "2.0" },
      ],
    );
    const options = {
      method: "POST",
      headers: [
        "Host",
        "localhost",
        "X-Test",
        "one",
        "X-Test",
        "two",
        "Cookie",
        "a=1; b=2",
        "Content-Type",
        "application/octet-stream",
        "Content-Length",
        "3",
      ],
      body: Buffer.from([0, 255, 128]),
    };
    const v1 = (await request("/v1/abc/xyz?q=one&q=two&x[y]=z", options)).json();
    assert.equal(v1.version, undefined);
    assert.equal(v1.httpMethod, "POST");
    assert.equal(v1.requestContext.protocol, "HTTP/1.1");
    assert.deepEqual(v1.pathParameters, { "user-id": "abc", "1name": "xyz" });
    assert.deepEqual(v1.multiValueHeaders["x-test"], ["one", "two"]);
    assert.equal(v1.headers["x-test"], "two");
    assert.deepEqual(v1.multiValueQueryStringParameters.q, ["one", "two"]);
    assert.equal(v1.queryStringParameters["x[y]"], "z");
    assert.equal(v1.body, options.body.toString("base64"));
    assert.equal(v1.isBase64Encoded, true);
    const v2 = (await request("/v2/a/b?q=one&q=two", options)).json();
    assert.equal(v2.version, "2.0");
    assert.equal(v2.rawPath, "/v2/a/b");
    assert.equal(v2.rawQueryString, "q=one&q=two");
    assert.deepEqual(v2.pathParameters, { "proxy-name": "a/b" });
    assert.deepEqual(v2.cookies, ["a=1", "b=2"]);
    assert.equal(v2.headers.cookie, undefined);
    assert.equal(v2.headers["x-test"], "one,two");
    assert.equal(v2.queryStringParameters.q, "one,two");
    assert.equal(v2.multiValueHeaders, undefined);
    assert.equal(v2.httpMethod, undefined);
    assert.equal(v2.requestContext.http.method, "POST");
    assert.equal(v2.body, v1.body);
    const text = (
      await request("/v2/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      })
    ).json();
    assert.equal(text.isBase64Encoded, false);
    assert.equal(text.body, '{"hello":"world"}');
  },
);

test(
  "responses support cookies, multi-value precedence, binary and v2 inference; CORS is valid",
  { concurrency: false },
  async t => {
    const { request } = await fixture(
      t,
      {
        "handler.ts": `
    export function proxy() { return { statusCode: 202, headers: { 'x-test': 'single' }, multiValueHeaders: { 'X-Test': ['one', 'two'], 'set-cookie': ['a=1', 'b=2'] }, cookies: ['c=3', 'd=4'], body: 'AP+A', isBase64Encoded: true }; }
    export function inferred() { return { hello: 'world' }; }
    export function string() { return 'hello'; }
    export function empty() { return { statusCode: 204 }; }
  `,
      },
      [
        { path: "/v1", handler: "handler.proxy" },
        { path: "/v2", handler: "handler.proxy", payloadVersion: "2.0" },
        { path: "/inferred", handler: "handler.inferred", payloadVersion: "2.0" },
        { path: "/string", handler: "handler.string", payloadVersion: "2.0" },
        { path: "/empty", handler: "handler.empty" },
      ],
    );
    const v1 = await request("/v1");
    assert.equal(v1.status, 202);
    assert.equal(v1.headers["x-test"], "one, two");
    assert.deepEqual(v1.headers["set-cookie"], ["a=1", "b=2"]);
    assert.deepEqual(v1.body, Buffer.from([0, 255, 128]));
    const v2 = await request("/v2");
    assert.deepEqual(v2.headers["set-cookie"], ["c=3", "d=4"]);
    assert.equal(v2.headers["x-test"], "single");
    assert.deepEqual((await request("/inferred")).json(), { hello: "world" });
    assert.equal((await request("/string")).json(), "hello");
    assert.equal((await request("/empty")).body.length, 0);
    const cors = await request("/v1", { method: "OPTIONS" });
    assert.equal(cors.status, 204);
    assert.equal(cors.headers["access-control-allow-origin"], "*");
    assert.equal(cors.headers["access-control-allow-credentials"], undefined);
  },
);

test(
  "omitted Content-Type infers application/json for JSON body and text/plain for text",
  { concurrency: false },
  async t => {
    const { request } = await fixture(
      t,
      {
        "handler.ts": `
    export function jsonString() { return { statusCode: 200, body: JSON.stringify({ token: "abc", count: 123 }) }; }
    export function textString() { return { statusCode: 200, body: "plain text message" }; }
    export function explicitHtml() { return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: "<h1>Hi</h1>" }; }
  `,
      },
      [
        { path: "/json", handler: "handler.jsonString" },
        { path: "/text", handler: "handler.textString" },
        { path: "/html", handler: "handler.explicitHtml" },
      ],
    );
    const jsonRes = await request("/json");
    assert.equal(jsonRes.status, 200);
    assert.match(jsonRes.headers["content-type"], /^application\/json/);
    assert.deepEqual(jsonRes.json(), { token: "abc", count: 123 });

    const textRes = await request("/text");
    assert.equal(textRes.status, 200);
    assert.match(textRes.headers["content-type"], /^text\/plain/);
    assert.equal(textRes.body.toString(), "plain text message");

    const htmlRes = await request("/html");
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(htmlRes.body.toString(), "<h1>Hi</h1>");
  },
);

test("normalizeBasePath and combinePaths format paths properly", () => {
  assert.equal(normalizeBasePath(undefined), "");
  assert.equal(normalizeBasePath(""), "");
  assert.equal(normalizeBasePath("/"), "");
  assert.equal(normalizeBasePath("///"), "");
  assert.equal(normalizeBasePath("medical-history-app"), "/medical-history-app");
  assert.equal(normalizeBasePath("/medical-history-app"), "/medical-history-app");
  assert.equal(normalizeBasePath("/medical-history-app/"), "/medical-history-app");
  assert.equal(normalizeBasePath("api/v1/"), "/api/v1");

  assert.equal(combinePaths("", "/test"), "/test");
  assert.equal(combinePaths("", "test"), "/test");
  assert.equal(
    combinePaths("medical-history-app", "/request-medical-history"),
    "/medical-history-app/request-medical-history",
  );
  assert.equal(
    combinePaths("/medical-history-app/", "request-medical-history"),
    "/medical-history-app/request-medical-history",
  );
  assert.equal(combinePaths("/medical-history-app", "/"), "/medical-history-app");
  assert.equal(combinePaths("/medical-history-app", ""), "/medical-history-app");
});

test(
  "server routes requests with basePath prefix and exposes full path in event",
  { concurrency: false },
  async t => {
    const { request } = await fixture(
      t,
      {
        "handler.ts": `
    export function echo(event: any) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          path: event.path,
          rawPath: event.rawPath,
          resource: event.resource,
          params: event.pathParameters,
        }),
      };
    }
  `,
      },
      [
        { path: "/request-medical-history", handler: "handler.echo" },
        { path: "/users/{id}", handler: "handler.echo" },
      ],
      { basePath: "medical-history-app" },
    );

    // Matches with prefix
    const prefixedRes = await request("/medical-history-app/request-medical-history");
    assert.equal(prefixedRes.status, 200);
    const prefixedData = prefixedRes.json();
    assert.equal(prefixedData.path, "/medical-history-app/request-medical-history");
    assert.equal(prefixedData.resource, "/request-medical-history");

    // Path parameters under basePath
    const paramRes = await request("/medical-history-app/users/user-456");
    assert.equal(paramRes.status, 200);
    const paramData = paramRes.json();
    assert.equal(paramData.path, "/medical-history-app/users/user-456");
    assert.deepEqual(paramData.params, { id: "user-456" });

    // Requests without prefix return 404
    const unprefixedRes = await request("/request-medical-history");
    assert.equal(unprefixedRes.status, 404);
  },
);
