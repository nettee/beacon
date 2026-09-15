import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const defaultConfigPath = join(homedir(), ".beacon", "config.yaml");

export type CliCommand =
  | { command: "serve"; config: string }
  | { command: "doctor"; config: string }
  | { command: "trigger"; config: string; profile: string }
  | {
      command: "schedule-trigger";
      config: string;
      profile: string;
      schedule: string;
    }
  | { command: "version" }
  | { command: "outcome-submit" };

function usage(): never {
  throw new Error(`Usage:
  beacon serve --config <absolute-path>
  beacon doctor [--config <absolute-path>]
  beacon trigger [--config <absolute-path>] --profile <id> --input -
  beacon schedule trigger [--config <absolute-path>] --profile <id> --schedule <id>
  beacon version`);
}

function requiredConfig(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) usage();
  if (!isAbsolute(args[1])) throw new Error("Config path must be absolute");
  return args[1];
}

function options(args: string[]): Map<string, string> {
  if (args.length % 2 !== 0) usage();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) usage();
    values.set(key, value);
  }
  return values;
}

function optionalConfig(values: Map<string, string>): string {
  const config = values.get("--config") ?? defaultConfigPath;
  if (!isAbsolute(config)) throw new Error("Config path must be absolute");
  return config;
}

export function parseCli(args: string[]): CliCommand {
  const [command, ...rest] = args;
  if (command === "version") {
    if (rest.length !== 0) usage();
    return { command: "version" };
  }
  if (command === "serve") {
    return { command, config: requiredConfig(rest) };
  }
  if (command === "doctor") {
    const values = options(rest);
    if ([...values.keys()].some((key) => key !== "--config")) usage();
    return { command, config: optionalConfig(values) };
  }
  if (command === "trigger") {
    const values = options(rest);
    const profile = values.get("--profile");
    if (
      !profile ||
      values.get("--input") !== "-" ||
      [...values.keys()].some(
        (key) => !["--config", "--profile", "--input"].includes(key),
      )
    )
      usage();
    return { command: "trigger", config: optionalConfig(values), profile };
  }
  if (command === "schedule" && rest[0] === "trigger") {
    const values = options(rest.slice(1));
    const profile = values.get("--profile");
    const schedule = values.get("--schedule");
    if (
      !profile ||
      !schedule ||
      [...values.keys()].some(
        (key) => !["--config", "--profile", "--schedule"].includes(key),
      )
    )
      usage();
    return {
      command: "schedule-trigger",
      config: optionalConfig(values),
      profile,
      schedule,
    };
  }
  if (command === "outcome" && rest.length === 1 && rest[0] === "submit") {
    return { command: "outcome-submit" };
  }
  return usage();
}

export type CliDependencies = {
  serve(config: string): Promise<void>;
  doctor(config: string): Promise<void>;
  trigger(config: string, profile: string, input: string): Promise<void>;
  triggerSchedule(
    config: string,
    profile: string,
    schedule: string,
  ): Promise<void>;
  submitOutcome(): Promise<void>;
  version: string;
};

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

export async function runCli(
  command: CliCommand,
  dependencies: CliDependencies,
): Promise<void> {
  if (command.command === "serve") return dependencies.serve(command.config);
  if (command.command === "doctor") return dependencies.doctor(command.config);
  if (command.command === "trigger") {
    return dependencies.trigger(
      command.config,
      command.profile,
      await readStdin(),
    );
  }
  if (command.command === "schedule-trigger") {
    return dependencies.triggerSchedule(
      command.config,
      command.profile,
      command.schedule,
    );
  }
  if (command.command === "outcome-submit") return dependencies.submitOutcome();
  console.log(dependencies.version);
}
