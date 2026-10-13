import type { Command, Option } from "commander";

export type HelpResolution =
  | { kind: "passthrough" }
  | { kind: "help"; command: Command }
  | { kind: "run-help" }
  | { kind: "unknown"; token: string; tryCommand?: string; suggestion?: string };

type Walk = {
  command: Command;
  path: string[];
  helpRequested: boolean;
  unknown: string | null;
};

function isHelpFlag(token: string): boolean {
  return token === "-h" || token === "--help";
}

function findChild(command: Command, name: string): Command | undefined {
  return command.commands.find((child) => {
    if (child.name() === "help") return false;
    return child.name() === name || child.aliases().includes(name);
  });
}

function hasSubcommands(command: Command): boolean {
  return command.commands.some((child) => child.name() !== "help");
}

function knownOptions(command: Command): Option[] {
  const options: Option[] = [];
  let current: Command | null = command;
  while (current) {
    options.push(...current.options);
    current = current.parent;
  }
  return options;
}

function matchOption(command: Command, token: string): { option: Option; inline: boolean } | undefined {
  if (!token.startsWith("-") || token === "-") return undefined;
  const eq = token.indexOf("=");
  const inline = eq >= 0;
  const flag = inline ? token.slice(0, eq) : token;
  for (const option of knownOptions(command)) {
    if (option.short === flag || option.long === flag) return { option, inline };
  }
  return undefined;
}

function skipOption(command: Command, argv: string[], index: number): number {
  const token = argv[index] ?? "";
  const matched = matchOption(command, token);
  const next = index + 1;
  if (matched?.inline) return next;
  const value = argv[next];
  if (!value) return next;
  if (matched?.option.required) return next + 1;
  if (matched?.option.optional && !value.startsWith("-")) return next + 1;
  return next;
}

function remainderRequestsHelp(command: Command, argv: string[]): boolean {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (isHelpFlag(token)) return true;
    if (token.startsWith("-")) {
      index = skipOption(command, argv, index);
      continue;
    }
    index += 1;
  }
  return false;
}

/** Match `run.ts`: Cohub flags first, then the rest is the shell command. */
function runRemainderRequestsHelp(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") return false;
    if (isHelpFlag(token)) return true;
    if (token === "--async" || token === "--json") continue;
    if (token === "-c" || token === "--command" || token === "--base-url") {
      index += 1;
      continue;
    }
    if (token.startsWith("--command=") || token.startsWith("--base-url=")) continue;
    return false;
  }
  return false;
}

function walkCommandPath(program: Command, argv: string[]): Walk {
  let command = program;
  const path: string[] = [];
  let helpRequested = false;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (isHelpFlag(token)) {
      helpRequested = true;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index = skipOption(command, argv, index);
      continue;
    }
    if (token === "help" && hasSubcommands(command)) {
      helpRequested = true;
      index += 1;
      continue;
    }
    const child = findChild(command, token);
    if (child) {
      command = child;
      path.push(child.name());
      index += 1;
      continue;
    }
    if (hasSubcommands(command)) {
      const remainder = argv.slice(index + 1);
      const helpAfter = token === "run" && path.length === 0
        ? runRemainderRequestsHelp(remainder)
        : remainderRequestsHelp(command, remainder);
      return {
        command,
        path,
        helpRequested: helpRequested || helpAfter,
        unknown: token,
      };
    }
    index += 1;
  }

  return { command, path, helpRequested, unknown: null };
}

function stripRootCommand(program: Command, argv: string[], name: string): string[] | undefined {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") return undefined;
    if (isHelpFlag(token) || token === "help") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index = skipOption(program, argv, index);
      continue;
    }
    if (token !== name) return undefined;
    return [...argv.slice(0, index), ...argv.slice(index + 1)];
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const previous = Array.from({ length: cols }, (_, index) => index);
  const current = new Array<number>(cols);
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < cols; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function suggestCommand(command: Command, token: string): string | undefined {
  const names = [...new Set(
    command.commands.flatMap((child) => {
      if (child.name() === "help" || child.name().length <= 1) return [];
      return [child.name(), ...child.aliases().filter((alias) => alias.length > 1)];
    }),
  )];
  let best: string | undefined;
  let bestDistance = 3;
  for (const name of names) {
    const distance = editDistance(token, name);
    const length = Math.max(token.length, name.length);
    if (distance >= bestDistance || (length - distance) / length <= 0.4) continue;
    bestDistance = distance;
    best = name;
  }
  return best;
}

export function resolveHelpPath(program: Command, argv: string[]): HelpResolution {
  const walk = walkCommandPath(program, argv);
  const cliAtRoot = walk.unknown === "cli" && walk.path.length === 0;

  if (cliAtRoot) {
    const stripped = stripRootCommand(program, argv, "cli");
    return {
      kind: "unknown",
      token: "cli",
      tryCommand: stripped && stripped.length > 0 ? stripped.join(" ") : undefined,
    };
  }

  if (!walk.helpRequested) return { kind: "passthrough" };

  if (walk.unknown === "run" && walk.path.length === 0) return { kind: "run-help" };

  if (walk.unknown) {
    return {
      kind: "unknown",
      token: walk.unknown,
      suggestion: suggestCommand(walk.command, walk.unknown),
    };
  }

  return { kind: "help", command: walk.command };
}

export function formatUnknownCommandError(result: Extract<HelpResolution, { kind: "unknown" }>): string {
  const lines = [`error: unknown command '${result.token}'`];
  if (result.tryCommand) lines.push(`Try: cohub ${result.tryCommand}`);
  else if (result.token === "cli") lines.push(`cohub has no "cli" subcommand. See cohub --help`);
  else if (result.suggestion) lines.push(`(Did you mean ${result.suggestion}?)`);
  return `${lines.join("\n")}\n`;
}
