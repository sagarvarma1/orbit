import { z } from "zod";

/**
 * Cron jobs from `vercel.json`, with Vercel's semantics:
 *
 *   { "crons": [{ "path": "/api/cleanup", "schedule": "0 5 * * *" }] }
 *
 * - Schedules have five fields (minute, hour, day of month, month, day of week) and are in UTC.
 * - Each field is `*`, a number, a range `1-5`, a step `*\/15` or `10-40/10`, or a list of those.
 * - Like Vercel, names (`MON`, `JAN`) and the `L`/`W`/`#`/`?` extensions aren't supported, and
 *   day of month and day of week can't both be set: when one has a value the other must be `*`.
 * - Jobs only run for the production deployment, as a GET request to `path`.
 */

export interface CronJob {
  /** Path on the production deployment, e.g. "/api/cleanup" (a query string is allowed). */
  path: string;
  /** Five-field cron expression, UTC. */
  schedule: string;
}

/** Vercel's limit per project. */
export const MAX_CRON_JOBS = 100;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 6 },
];

/** A parsed schedule: for each field, which values match. */
export interface Schedule {
  minute: boolean[];
  hour: boolean[];
  dayOfMonth: boolean[];
  month: boolean[];
  dayOfWeek: boolean[];
}

const PART_RE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

function parseField(text: string, spec: FieldSpec): { values: boolean[]; any: boolean } {
  const values = new Array<boolean>(spec.max + 1).fill(false);
  for (const part of text.split(",")) {
    const m = PART_RE.exec(part);
    if (!m) {
      const hint = /[a-z]/i.test(part) ? " (names like MON or JAN aren't supported; use numbers)" : "";
      throw new Error(`invalid ${spec.name} "${part}"${hint}`);
    }
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = spec.min;
      hi = spec.max;
    } else {
      const [a, b] = m[1]!.split("-").map(Number) as [number, number | undefined];
      lo = a;
      // "5/15" means "from 5, every 15", like most cron implementations.
      hi = b ?? (m[2] ? spec.max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < spec.min || hi > spec.max)
      throw new Error(`${spec.name} must be between ${spec.min} and ${spec.max}, got "${part}"`);
    if (lo > hi) throw new Error(`invalid ${spec.name} range "${part}"`);
    if (step < 1) throw new Error(`invalid ${spec.name} step "${part}"`);
    for (let v = lo; v <= hi; v += step) values[v] = true;
  }
  return { values, any: text === "*" };
}

/** Parses a five-field cron expression. Throws a readable Error. */
export function parseSchedule(expression: string): Schedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseField(f, FIELDS[i]!));
  if (!dayOfMonth!.any && !dayOfWeek!.any) {
    throw new Error("day of month and day of week can't both be set; make one of them *");
  }
  return {
    minute: minute!.values,
    hour: hour!.values,
    dayOfMonth: dayOfMonth!.values,
    month: month!.values,
    dayOfWeek: dayOfWeek!.values,
  };
}

/** Whether the schedule fires in the UTC minute containing `time`. */
export function matches(schedule: Schedule, time: number): boolean {
  const d = new Date(time);
  return (
    schedule.minute[d.getUTCMinutes()]! &&
    schedule.hour[d.getUTCHours()]! &&
    schedule.dayOfMonth[d.getUTCDate()]! &&
    schedule.month[d.getUTCMonth() + 1]! &&
    schedule.dayOfWeek[d.getUTCDay()]!
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Start of the UTC minute containing `time`. */
export const minuteOf = (time: number) => Math.floor(time / MINUTE) * MINUTE;

/**
 * The first minute strictly after `after` at which the schedule fires, or null if it never does
 * within `horizonDays` (e.g. "0 0 31 2 *").
 */
export function nextRun(schedule: Schedule, after: number, horizonDays = 366 * 4): number | null {
  let t = minuteOf(after) + MINUTE;
  const end = t + horizonDays * DAY;
  while (t < end) {
    const d = new Date(t);
    if (!schedule.month[d.getUTCMonth() + 1]) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else if (!schedule.dayOfMonth[d.getUTCDate()] || !schedule.dayOfWeek[d.getUTCDay()]) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    } else if (!schedule.hour[d.getUTCHours()]) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    } else if (!schedule.minute[d.getUTCMinutes()]) {
      t += MINUTE;
    } else {
      return t;
    }
  }
  return null;
}

const cronJobSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .startsWith("/", "must start with /")
    .refine((p) => !/[\s#]/.test(p), "can't contain spaces or #"),
  schedule: z.string().min(1).max(256),
});

const cronsSchema = z.array(cronJobSchema).max(MAX_CRON_JOBS, `at most ${MAX_CRON_JOBS} cron jobs per project`);

/** Validates the `crons` key of a parsed vercel.json (undefined when absent). Throws a readable Error. */
export function parseCronsConfig(json: unknown): CronJob[] | undefined {
  if (!json || typeof json !== "object" || !("crons" in json)) return undefined;
  const result = cronsSchema.safeParse((json as { crons: unknown }).crons);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`crons${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
  }
  const seen = new Set<string>();
  return result.data.map((job, i) => {
    const schedule = job.schedule.trim().replace(/\s+/g, " ");
    let parsed: Schedule;
    try {
      parsed = parseSchedule(schedule);
    } catch (err) {
      throw new Error(`crons.${i}.schedule "${job.schedule}": ${(err as Error).message}`);
    }
    if (nextRun(parsed, Date.now()) === null) throw new Error(`crons.${i}.schedule "${job.schedule}" never runs`);
    const key = `${job.path} ${schedule}`;
    if (seen.has(key)) throw new Error(`crons.${i}: duplicate job (${job.path} at "${schedule}")`);
    seen.add(key);
    return { path: job.path, schedule };
  });
}
