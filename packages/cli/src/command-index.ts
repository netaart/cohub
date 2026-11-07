import { type Command, Help } from "commander";

type Register = (program: Command) => unknown;
export type RootCommandLine = [term: string, description: string];

export const COMMANDS: ReadonlyArray<{ names: readonly string[]; load: () => Promise<Register> }> = [
  { names: ["auth"], load: async () => (await import("./commands/auth.js")).registerAuth },
  { names: ["boards"], load: async () => (await import("./commands/boards.js")).registerBoards },
  { names: ["profile"], load: async () => (await import("./commands/profile.js")).registerProfile },
  { names: ["me"], load: async () => (await import("./commands/me.js")).registerMe },
  { names: ["prompt", "completion", "decision"], load: async () => (await import("./commands/spaces.js")).registerPrompt },
  { names: ["spaces", "labels"], load: async () => (await import("./commands/spaces.js")).registerSpaces },
  { names: ["runtime"], load: async () => (await import("./commands/runtime.js")).registerRuntime },
  { names: ["channels"], load: async () => (await import("./commands/channels.js")).registerChannels },
  { names: ["generate"], load: async () => (await import("./commands/generations.js")).registerGenerations },
  { names: ["models"], load: async () => (await import("./commands/models.js")).registerModels },
  { names: ["prompts"], load: async () => (await import("./commands/prompts.js")).registerPrompts },
  { names: ["public"], load: async () => (await import("./commands/public.js")).registerPublic },
  { names: ["skills"], load: async () => (await import("./commands/skills.js")).registerSkills },
  { names: ["search"], load: async () => (await import("./commands/search.js")).registerSearch },
  { names: ["references"], load: async () => (await import("./commands/references.js")).registerReferences },
  { names: ["referrals"], load: async () => (await import("./commands/referrals.js")).registerReferrals },
  { names: ["tasks"], load: async () => (await import("./commands/tasks.js")).registerTasks },
  { names: ["cron-jobs"], load: async () => (await import("./commands/cron-jobs.js")).registerCronJobs },
  { names: ["apps", "works"], load: async () => (await import("./commands/apps.js")).registerApps },
  { names: ["rooms"], load: async () => (await import("./commands/rooms.js")).registerRooms },
  { names: ["feedback"], load: async () => (await import("./commands/feedback.js")).registerFeedback },
  { names: ["desktop"], load: async () => (await import("./commands/desktop.js")).registerDesktop },
  { names: ["ui"], load: async () => (await import("./commands/desktop.js")).registerLegacyUi },
  { names: ["host"], load: async () => (await import("./commands/host.js")).registerHost },
  { names: ["version"], load: async () => (await import("./commands/version.js")).registerVersion },
];

export async function registerCommands(program: Command, commands: typeof COMMANDS = COMMANDS) {
  for (const register of await Promise.all(commands.map((command) => command.load()))) register(program);
}

export function describeRootCommands(program: Command): RootCommandLine[] {
  const help = program.createHelp();
  return help.visibleCommands(program)
    .filter((command) => command.name() !== "help")
    .map((command) => [help.subcommandTerm(command), help.subcommandDescription(command)]);
}

export function addRootCommandStubs(program: Command, lines: readonly RootCommandLine[]) {
  const terms = new Map<Command, string>();
  for (const [term, description] of lines) {
    terms.set(program.command(term.split(/[ |]/, 1)[0] ?? term).description(description), term);
  }
  program.configureHelp({
    subcommandTerm(command) {
      return terms.get(command) ?? Help.prototype.subcommandTerm.call(this, command);
    },
  });
}
