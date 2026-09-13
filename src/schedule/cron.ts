import { CronExpressionParser } from "cron-parser";

export function occurrencesBetween(
  cron: string,
  timezone: string,
  afterExclusive: Date,
  throughInclusive: Date,
  limit: number,
): Date[] {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error("Schedule cron must contain exactly five fields");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Occurrence limit must be a positive integer");
  }
  const expression = CronExpressionParser.parse(`0 ${cron}`, {
    currentDate: afterExclusive,
    endDate: throughInclusive,
    tz: timezone,
    strict: true,
  });
  const occurrences: Date[] = [];
  while (true) {
    let next: Date;
    try {
      next = expression.next().toDate();
    } catch (error) {
      if (error instanceof Error && /Out of the time span range|No more executions/.test(error.message)) {
        break;
      }
      throw error;
    }
    if (next > throughInclusive) break;
    occurrences.push(next);
    if (occurrences.length > limit) {
      throw new Error(`Schedule occurrence enumeration exceeds limit ${limit}`);
    }
  }
  return occurrences;
}

export function nextOccurrence(cron: string, timezone: string, afterExclusive: Date): Date {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error("Schedule cron must contain exactly five fields");
  }
  return CronExpressionParser.parse(`0 ${cron}`, {
    currentDate: afterExclusive,
    tz: timezone,
    strict: true,
  })
    .next()
    .toDate();
}
