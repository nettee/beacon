import { isAbsolute } from "node:path";

export type CliCommand =
  | { command: "serve"; config: string }
  | { command: "doctor"; config: string }
  | { command: "trigger"; config: string; profile: string }
  | { command: "version" }
  | { command: "outcome-submit" };

function usage(): never {
  throw new Error(`Usage:
  beacon serve --config <absolute-path>
  beacon doctor --config <absolute-path>
  beacon trigger --config <absolute-path> --profile <id> --input -
  beacon version`);
}

function configOnly(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) usage();
  if (!isAbsolute(args[1])) throw new Error("Config path must be absolute");
  return args[1];
}

export function parseCli(args: string[]): CliCommand {
  const [command, ...rest] = args;
  if (command === "version") {
    if (rest.length !== 0) usage();
    return { command: "version" };
  }
  if (command === "serve" || command === "doctor") {
    return { command, config: configOnly(rest) };
  }
  if (command === "trigger") {
    if (rest.length !== 6) usage();
    const values = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index];
      const value = rest[index + 1];
      if (!key?.startsWith("--") || !value || values.has(key)) usage();
      values.set(key, value);
    }
    const config = values.get("--config");
    const profile = values.get("--profile");
    if (
      !config ||
      !profile ||
      values.get("--input") !== "-" ||
      values.size !== 3
    )
      usage();
    if (!isAbsolute(config)) throw new Error("Config path must be absolute");
    return { command: "trigger", config, profile };
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
  if (command.command === "outcome-submit") return dependencies.submitOutcome();
  console.log(dependencies.version);
}
