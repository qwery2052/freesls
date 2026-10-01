import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PACKAGE_NAME = "freesls";
export const UPDATE_CACHE_FILE = join(tmpdir(), `${PACKAGE_NAME}-update-check.json`);

const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
const STABLE_TAG = "latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;
const OPT_OUT_ENV_VARS = ["FREESLS_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"];

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type DistTags = Record<string, string>;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

interface UpdateCache {
  checkedAt: number;
  distTags: DistTags;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease
      ? prerelease
          .split(".")
          .map(identifier => (/^\d+$/.test(identifier) ? Number(identifier) : identifier))
      : [],
  };
}

function comparePrerelease(left: (string | number)[], right: (string | number)[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = typeof leftIdentifier === "number";
    const rightNumeric = typeof rightIdentifier === "number";
    if (leftNumeric && rightNumeric) return leftIdentifier < rightIdentifier ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return 0;

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] < rightVersion[key] ? -1 : 1;
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

/**
 * Highest published version relevant to the current release channel.
 * Pre-releases track their own channel plus stable; stable only tracks `latest`.
 */
export function selectLatestVersion(currentVersion: string, distTags: DistTags): string | null {
  const current = parseVersion(currentVersion);
  const channel = current?.prerelease.length ? String(current.prerelease[0]) : null;
  const channelTags = [
    ...new Set([channel, STABLE_TAG].filter((tag): tag is string => Boolean(tag))),
  ];

  let latest: string | null = null;
  for (const tag of channelTags) {
    const candidate = distTags[tag];
    if (!candidate || !parseVersion(candidate)) continue;
    if (!latest || compareVersions(candidate, latest) > 0) latest = candidate;
  }

  return latest;
}

export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return OPT_OUT_ENV_VARS.some(name => Boolean(env[name]));
}

async function fetchDistTags(): Promise<DistTags | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(DIST_TAGS_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;

    const distTags = Object.fromEntries(
      Object.entries(body).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return Object.keys(distTags).length > 0 ? distTags : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const cache = JSON.parse(await readFile(UPDATE_CACHE_FILE, "utf8")) as UpdateCache;
    if (typeof cache.checkedAt !== "number" || !cache.distTags) return null;
    return Date.now() - cache.checkedAt > CACHE_TTL_MS ? null : cache;
  } catch {
    return null;
  }
}

async function readDistTags(): Promise<DistTags | null> {
  const cached = await readCache();
  if (cached) return cached.distTags;

  const distTags = await fetchDistTags();
  if (distTags) {
    await writeFile(UPDATE_CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), distTags })).catch(
      () => {},
    );
  }
  return distTags;
}

/**
 * Resolve the newest version available for the current channel, or `null`.
 * Never throws and never blocks: offline or registry failures stay silent.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const distTags = await readDistTags();
    if (!distTags) return null;

    const latest = selectLatestVersion(currentVersion, distTags);
    return latest && compareVersions(latest, currentVersion) > 0 ? latest : null;
  } catch {
    return null;
  }
}
