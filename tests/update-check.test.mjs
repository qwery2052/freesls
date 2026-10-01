import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import {
  UPDATE_CACHE_FILE,
  checkForUpdate,
  compareVersions,
  isUpdateCheckDisabled,
  selectLatestVersion,
} from "../dist/update-check.js";

const DIST_TAGS = { latest: "0.4.1", beta: "0.5.0-beta.3", rc: "0.5.0-rc.1" };

test("compareVersions orders stable above pre-release and compares identifiers", () => {
  assert.ok(compareVersions("0.5.0", "0.5.0-beta.1") > 0);
  assert.ok(compareVersions("0.5.0-beta.2", "0.5.0-beta.1") > 0);
  assert.ok(compareVersions("0.5.0-beta.1", "0.5.0-beta") > 0);
  assert.ok(compareVersions("0.5.0-beta.2", "0.5.0-alpha.9") > 0);
  assert.ok(compareVersions("0.5.1", "0.5.0") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("selectLatestVersion follows the current release channel", () => {
  assert.equal(selectLatestVersion("0.4.0", DIST_TAGS), "0.4.1");
  assert.equal(selectLatestVersion("0.5.0-beta.1", DIST_TAGS), "0.5.0-beta.3");
  assert.equal(selectLatestVersion("0.5.0-rc.1", DIST_TAGS), "0.5.0-rc.1");
});

test("isUpdateCheckDisabled honours opt-out environment variables", () => {
  assert.equal(isUpdateCheckDisabled({}), false);
  assert.equal(isUpdateCheckDisabled({ CI: "1" }), true);
  assert.equal(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
  assert.equal(isUpdateCheckDisabled({ FREESLS_NO_UPDATE_CHECK: "1" }), true);
});

test("checkForUpdate reports only a strictly newer channel version", async t => {
  await rm(UPDATE_CACHE_FILE, { force: true });
  t.after(() => rm(UPDATE_CACHE_FILE, { force: true }));
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => DIST_TAGS }));

  assert.equal(await checkForUpdate("0.5.0-beta.2"), "0.5.0-beta.3");
  assert.equal(await checkForUpdate("0.5.0-beta.3"), null);
  assert.equal(await checkForUpdate("0.4.1"), null);
});

test("checkForUpdate stays silent when the registry is unreachable", async t => {
  await rm(UPDATE_CACHE_FILE, { force: true });
  t.after(() => rm(UPDATE_CACHE_FILE, { force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });

  assert.equal(await checkForUpdate("0.4.1"), null);
});
