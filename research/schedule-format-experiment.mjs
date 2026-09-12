import { CronExpressionParser } from "cron-parser";
import { Cron } from "croner";
import cron from "node-cron";

function parseFiveField(expression, timezone, currentDate) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Beacon cron must have exactly 5 fields; got ${fields.length}`);
  }

  return CronExpressionParser.parse(`0 ${fields.join(" ")}`, {
    currentDate,
    tz: timezone,
    strict: true,
  });
}

function isoDates(iterator, count) {
  return iterator.take(count).map((date) => date.toISOString());
}

function cronerDates(expression, timezone, currentDate, count) {
  return new Cron(expression, { timezone, paused: true })
    .nextRuns(count, new Date(currentDate))
    .map((date) => date.toISOString());
}

const results = {
  dailyShanghai: isoDates(
    parseFiveField("0 9 * * *", "Asia/Shanghai", "2026-09-12T00:30:00Z"),
    3,
  ),
  springGapNewYork: isoDates(
    parseFiveField("30 2 * * *", "America/New_York", "2025-03-08T06:00:00Z"),
    3,
  ),
  fallFoldNewYork: isoDates(
    parseFiveField("30 1 * * *", "America/New_York", "2025-11-01T04:00:00Z"),
    3,
  ),
  missedWindow: isoDates(
    parseFiveField("0 9 * * *", "Asia/Shanghai", "2026-09-10T01:00:00Z"),
    4,
  ).filter((instant) => instant <= "2026-09-12T02:00:00.000Z"),
  validation: {},
  librarySurface: {
    nodeCronExports: Object.keys(cron).sort(),
    cronerNextRuns: new Cron("0 9 * * *", {
      timezone: "Asia/Shanghai",
      paused: true,
    })
      .nextRuns(2, new Date("2026-09-12T00:30:00Z"))
      .map((date) => date.toISOString()),
    cronerSpringGap: cronerDates(
      "30 2 * * *",
      "America/New_York",
      "2025-03-08T06:00:00Z",
      3,
    ),
    cronerFallFold: cronerDates(
      "30 1 * * *",
      "America/New_York",
      "2025-11-01T04:00:00Z",
      3,
    ),
  },
};

for (const [name, expression, timezone] of [
  ["sixFields", "0 0 9 * * *", "Asia/Shanghai"],
  ["invalidMinute", "60 9 * * *", "Asia/Shanghai"],
  ["ambiguousDomDow", "0 9 1 * 1", "Asia/Shanghai"],
  ["invalidTimezone", "0 9 * * *", "Mars/Olympus"],
]) {
  try {
    parseFiveField(expression, timezone, "2026-09-12T00:30:00Z").next();
    results.validation[name] = "accepted";
  } catch (error) {
    results.validation[name] = String(error.message);
  }
}

console.log(JSON.stringify(results, null, 2));
