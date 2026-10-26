/**
 * AWS EventBridge cron and rate expression parsing.
 *
 * Cron expressions use six fields: minutes, hours, day-of-month, month,
 * day-of-week and year. Exactly one of the two day fields must be `?`.
 * See https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
 */

import { createHash } from "node:crypto";

export class ScheduleExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleExpressionError";
  }
}

/** Keep generated rule/schedule names within the AWS 64-character limit. */
export function boundedScheduleName(value: string): string {
  if (value.length <= 64) return value;
  return `${value.slice(0, 55)}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

/** Validate the shared rule/schedule name pattern used by EventBridge and Scheduler. */
export function validateScheduleName(value: string, field: string): string {
  if (!/^[.\-_A-Za-z0-9]{1,64}$/.test(value))
    throw new Error(`${field} must contain 1-64 letters, digits, dots, underscores or hyphens.`);
  return value;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type DayOfMonthMatcher =
  | { kind: "any" }
  | { kind: "values"; values: Set<number> }
  | { kind: "last" }
  | { kind: "lastWeekday" }
  | { kind: "nearestWeekday"; day: number };

type DayOfWeekMatcher =
  | { kind: "any" }
  | { kind: "values"; values: Set<number> }
  | { kind: "lastDayOfWeek" }
  | { kind: "lastWeekdayOfMonth"; day: number }
  | { kind: "nthWeekday"; day: number; nth: number };

export interface ParsedCronExpression {
  kind: "cron";
  raw: string;
  timezone: string;
  minutes: number[];
  hours: number[];
  dayOfMonth: DayOfMonthMatcher | null;
  months: Set<number>;
  dayOfWeek: DayOfWeekMatcher | null;
  years: Set<number>;
  maxYear: number;
  times: Array<{ hour: number; minute: number }>;
}

export interface ParsedRateExpression {
  kind: "rate";
  raw: string;
  timezone: string;
  intervalMs: number;
}

export type ParsedRecurringExpression = ParsedCronExpression | ParsedRateExpression;

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

// AWS uses 1 = Sunday through 7 = Saturday.
const DAY_NAMES: Record<string, number> = {
  SUN: 1,
  MON: 2,
  TUE: 3,
  WED: 4,
  THU: 5,
  FRI: 6,
  SAT: 7,
};

const UNSUPPORTED_CRON_EXAMPLE =
  "AWS cron requires six fields: cron(minutes hours day-of-month month day-of-week year). " +
  "The five-field form (for example 0 12 * * 0-5) is Unix cron, not EventBridge cron.";

/**
 * Build a reusable IANA formatter. Throws for unknown time zones.
 */
export function createTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function wallClockParts(instant: number, formatter: Intl.DateTimeFormat): WallClock {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map(part => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Return every UTC instant that represents the given wall-clock time.
 * Empty during a DST gap; two entries during a DST overlap.
 */
export function wallClockCandidates(wall: WallClock, formatter: Intl.DateTimeFormat): number[] {
  const utcGuess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );

  const localEpoch = (time: number) => {
    const parts = wallClockParts(time, formatter);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  };

  const candidates = new Set<number>();
  for (const delta of [-172800000, -86400000, 0, 86400000, 172800000]) {
    const probe = utcGuess + delta;
    const candidate = utcGuess - (localEpoch(probe) - probe);
    if (localEpoch(candidate) === utcGuess) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left - right);
}

function parseNameOrNumber(
  value: string,
  names: Record<string, number> | undefined,
  min: number,
  max: number,
  field: string,
): number {
  const upper = value.toUpperCase();
  const named = names?.[upper];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(value)) {
    throw new ScheduleExpressionError(`${field} contains an invalid value: ${value}.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ScheduleExpressionError(`${field} values must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseNumberField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>,
): number[] {
  if (!field) throw new ScheduleExpressionError(`${label} cannot be empty.`);
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (!part) throw new ScheduleExpressionError(`${label} contains an empty list item.`);

    const [base, rawStep, ...extra] = part.split("/");
    if (extra.length > 0) {
      throw new ScheduleExpressionError(`${label} contains an invalid step expression: ${part}.`);
    }
    let step = 1;
    if (rawStep !== undefined) {
      if (!/^\d+$/.test(rawStep) || Number(rawStep) < 1) {
        throw new ScheduleExpressionError(`${label} step must be a positive integer.`);
      }
      step = Number(rawStep);
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const [rawStart, rawEnd, ...rangeExtra] = base.split("-");
      if (rangeExtra.length > 0 || rawStart === "" || rawEnd === "") {
        throw new ScheduleExpressionError(`${label} contains an invalid range: ${part}.`);
      }
      start = parseNameOrNumber(rawStart, names, min, max, label);
      end = parseNameOrNumber(rawEnd, names, min, max, label);
      if (start > end) {
        throw new ScheduleExpressionError(`${label} range start must not exceed its end.`);
      }
    } else {
      start = parseNameOrNumber(base, names, min, max, label);
      end = rawStep === undefined ? start : max;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return [...values].sort((left, right) => left - right);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function lastWeekdayOfMonth(year: number, month: number): number {
  let day = daysInMonth(year, month);
  while (true) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return day;
    day--;
  }
}

function nearestWeekday(year: number, month: number, targetDay: number): number | null {
  const lastDay = daysInMonth(year, month);
  // AWS skips months that do not contain the requested day (for example 31W in February).
  if (targetDay > lastDay) return null;
  const weekday = new Date(Date.UTC(year, month - 1, targetDay)).getUTCDay();

  if (weekday === 6) return targetDay > 1 ? targetDay - 1 : targetDay + 2;
  if (weekday === 0) return targetDay < lastDay ? targetDay + 1 : targetDay - 2;
  return targetDay;
}

function parseDayOfMonth(field: string): DayOfMonthMatcher | null {
  if (field === "?") return null;
  if (field === "*") return { kind: "any" };
  if (field.toUpperCase() === "L") return { kind: "last" };
  if (field.toUpperCase() === "LW") return { kind: "lastWeekday" };
  const nearest = /^(\d{1,2})W$/i.exec(field);
  if (nearest) {
    const day = Number(nearest[1]);
    if (day < 1 || day > 31) {
      throw new ScheduleExpressionError("Day-of-month nW values must be between 1 and 31.");
    }
    return { kind: "nearestWeekday", day };
  }
  if (/[LW]/i.test(field)) {
    throw new ScheduleExpressionError(
      "Day-of-month accepts L or nW only as standalone values, not inside lists or ranges.",
    );
  }
  return { kind: "values", values: new Set(parseNumberField(field, 1, 31, "Day-of-month")) };
}

function parseDayOfWeek(field: string): DayOfWeekMatcher | null {
  if (field === "?") return null;
  if (field === "*") return { kind: "any" };

  const upper = field.toUpperCase();
  if (upper === "L") return { kind: "lastDayOfWeek" };

  if (upper.includes("#")) {
    if (field.includes(",")) {
      throw new ScheduleExpressionError(
        "Day-of-week accepts only one n#k expression; lists with # are not valid.",
      );
    }
    const nth = /^([A-Z0-9]+)#(\d+)$/i.exec(field);
    if (!nth) {
      throw new ScheduleExpressionError(
        "Day-of-week nth-weekday expressions must use n#k, for example 3#2.",
      );
    }
    const day = parseNameOrNumber(nth[1], DAY_NAMES, 1, 7, "Day-of-week");
    const occurrence = Number(nth[2]);
    if (occurrence < 1 || occurrence > 5) {
      throw new ScheduleExpressionError("Day-of-week nth values must be between 1 and 5.");
    }
    return { kind: "nthWeekday", day, nth: occurrence };
  }

  const last = /^([A-Z0-9]+)L$/i.exec(field);
  if (last) {
    const day = parseNameOrNumber(last[1], DAY_NAMES, 1, 7, "Day-of-week");
    return { kind: "lastWeekdayOfMonth", day };
  }
  if (upper.includes("L")) {
    throw new ScheduleExpressionError(
      "Day-of-week accepts L or nL only as standalone values, not inside lists or ranges.",
    );
  }
  return {
    kind: "values",
    values: new Set(parseNumberField(field, 1, 7, "Day-of-week", DAY_NAMES)),
  };
}

function parseCron(expression: string, timezone: string): ParsedCronExpression {
  if (!expression.startsWith("cron(") || !expression.endsWith(")")) {
    throw new ScheduleExpressionError(
      "Cron expressions must use cron(minutes hours day-of-month month day-of-week year).",
    );
  }

  const fields = expression.slice(5, -1).trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 6) {
    throw new ScheduleExpressionError(
      `Cron expressions require exactly 6 fields; received ${fields.length}. ${UNSUPPORTED_CRON_EXAMPLE}`,
    );
  }

  const [minutesField, hoursField, dayOfMonthField, monthField, dayOfWeekField, yearField] = fields;
  const minutes = parseNumberField(minutesField, 0, 59, "Minutes");
  const hours = parseNumberField(hoursField, 0, 23, "Hours");
  const months = new Set(parseNumberField(monthField, 1, 12, "Month", MONTH_NAMES));
  const dayOfMonth = parseDayOfMonth(dayOfMonthField);
  const dayOfWeek = parseDayOfWeek(dayOfWeekField);
  const years = parseNumberField(yearField, 1970, 2199, "Year");

  if ((dayOfMonth === null) === (dayOfWeek === null)) {
    throw new ScheduleExpressionError(
      "Cron expressions must use ? in exactly one of day-of-month and day-of-week.",
    );
  }

  const times: Array<{ hour: number; minute: number }> = [];
  for (const hour of hours) for (const minute of minutes) times.push({ hour, minute });
  times.sort((left, right) => left.hour - right.hour || left.minute - right.minute);

  return {
    kind: "cron",
    raw: expression,
    timezone,
    minutes,
    hours,
    dayOfMonth,
    months,
    dayOfWeek,
    years: new Set(years),
    maxYear: Math.max(...years),
    times,
  };
}

function parseRate(expression: string, timezone: string): ParsedRateExpression {
  if (!expression.startsWith("rate(") || !expression.endsWith(")")) {
    throw new ScheduleExpressionError("Rate expressions must use rate(value unit).");
  }

  const fields = expression.slice(5, -1).trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 2) {
    throw new ScheduleExpressionError("Rate expressions require a value and a unit.");
  }

  const [rawValue, rawUnit] = fields;
  if (!/^\d+$/.test(rawValue) || Number(rawValue) < 1) {
    throw new ScheduleExpressionError(
      "Rate value must be a positive integer, for example rate(5 minutes).",
    );
  }
  const value = Number(rawValue);
  const unit = rawUnit.toLowerCase();
  const singular = value === 1;
  const validUnits = singular ? ["minute", "hour", "day"] : ["minutes", "hours", "days"];
  if (!validUnits.includes(unit)) {
    throw new ScheduleExpressionError(
      singular
        ? "rate(1 ...) requires a singular unit: minute, hour or day."
        : `rate(${value} ...) requires a plural unit: minutes, hours or days.`,
    );
  }

  const unitMilliseconds = unit.startsWith("minute")
    ? 60000
    : unit.startsWith("hour")
      ? 3600000
      : 86400000;

  return {
    kind: "rate",
    raw: expression,
    timezone,
    intervalMs: value * unitMilliseconds,
  };
}

/**
 * Parse and validate an EventBridge cron/rate expression. Time zones are
 * validated even for rate expressions so configuration errors fail early.
 */
export function parseRecurringExpression(
  expression: unknown,
  timezone: unknown = "UTC",
): ParsedRecurringExpression {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new ScheduleExpressionError(
      "ScheduleExpression must be a non-empty cron(...) or rate(...) string.",
    );
  }
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new ScheduleExpressionError(
      "ScheduleExpressionTimezone must be a non-empty IANA time zone.",
    );
  }

  const normalized = expression.trim();
  const normalizedTimezone = timezone.trim();
  if (normalized.length > 256) {
    throw new ScheduleExpressionError("ScheduleExpression must be at most 256 characters.");
  }
  if (normalizedTimezone.length > 50) {
    throw new ScheduleExpressionError("ScheduleExpressionTimezone must be at most 50 characters.");
  }
  try {
    createTimeZoneFormatter(normalizedTimezone);
  } catch {
    throw new ScheduleExpressionError(
      `Unknown ScheduleExpressionTimezone "${normalizedTimezone}". Use an IANA time zone such as America/Bogota or UTC.`,
    );
  }

  if (normalized.startsWith("cron(")) return parseCron(normalized, normalizedTimezone);
  if (normalized.startsWith("rate(")) return parseRate(normalized, normalizedTimezone);
  if (normalized.startsWith("at(")) {
    throw new ScheduleExpressionError(
      "at(...) is a one-time Scheduler expression and is not supported for declared schedule events. Use cron(...) or rate(...), or create a one-time schedule with --scheduler.",
    );
  }
  throw new ScheduleExpressionError(
    `Unsupported schedule expression. Use cron(...) or rate(...). ${UNSUPPORTED_CRON_EXAMPLE}`,
  );
}

function matchesDay(
  parsed: ParsedCronExpression,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!parsed.months.has(month) || !parsed.years.has(year)) return false;

  if (parsed.dayOfMonth) {
    const matcher = parsed.dayOfMonth;
    if (matcher.kind === "any") return true;
    if (matcher.kind === "values") return matcher.values.has(day);
    if (matcher.kind === "last") return day === daysInMonth(year, month);
    if (matcher.kind === "lastWeekday") return day === lastWeekdayOfMonth(year, month);
    const nearest = nearestWeekday(year, month, matcher.day);
    return nearest !== null && day === nearest;
  }

  const matcher = parsed.dayOfWeek;
  if (!matcher) return false;
  if (matcher.kind === "any") return true;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1;
  if (matcher.kind === "values") return matcher.values.has(weekday);
  if (matcher.kind === "lastDayOfWeek") return weekday === 7;
  if (matcher.kind === "lastWeekdayOfMonth")
    return weekday === matcher.day && day + 7 > daysInMonth(year, month);
  return weekday === matcher.day && Math.floor((day - 1) / 7) + 1 === matcher.nth;
}

/**
 * Find the first occurrence strictly after `after`.
 * Returns null when the expression has no future occurrence (for example a
 * cron with a finite year range that has already ended).
 */
export function nextCronInstant(parsed: ParsedCronExpression, after: number): number | null {
  const formatter = createTimeZoneFormatter(parsed.timezone);
  const start = wallClockParts(after, formatter);
  const afterWall = Date.UTC(
    start.year,
    start.month - 1,
    start.day,
    start.hour,
    start.minute,
    start.second,
  );

  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let scannedDays = 0; scannedDays < 100000; scannedDays++) {
    const year = new Date(cursor).getUTCFullYear();
    if (year > 2199 || year > parsed.maxYear) return null;
    const month = new Date(cursor).getUTCMonth() + 1;
    const day = new Date(cursor).getUTCDate();

    if (matchesDay(parsed, year, month, day)) {
      const sameDay = year === start.year && month === start.month && day === start.day;
      let timeIndex = 0;
      if (sameDay) {
        while (timeIndex < parsed.times.length) {
          const time = parsed.times[timeIndex];
          if (Date.UTC(year, month - 1, day, time.hour, time.minute) > afterWall) break;
          timeIndex++;
        }
      }

      for (let index = timeIndex; index < parsed.times.length; index++) {
        const time = parsed.times[index];
        const candidates = wallClockCandidates(
          { year, month, day, hour: time.hour, minute: time.minute, second: 0 },
          formatter,
        );
        // A gap during spring-forward has no candidate. An overlap has two;
        // AWS runs once, so only the earliest occurrence is considered.
        if (candidates.length > 0 && candidates[0] > after) return candidates[0];
      }
    }

    cursor += 86400000;
  }

  return null;
}
