import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../dist/server.js";

async function fixture(t, files, definitions) {
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
  async function listen(routes = definitions) {
    const server = await startServer(
      routes.map(route => ({ functionName: "test", method: "any", environment: {}, ...route })),
      0,
      directory,
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
  return { request: await listen(), listen };
}

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
