import { Resolver } from "node:dns/promises";

export type DomainDnsLookup = {
  /** TXT values at `name`, each record's chunks joined. Empty when absent. */
  txt(name: string): Promise<string[]>;
  /** CNAME targets of `hostname`, lowercased without the trailing dot. */
  cname(hostname: string): Promise<string[]>;
};

const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Queries public resolvers directly so cluster DNS caching cannot delay
 * verification; a record seen by any resolver counts.
 */
export function createPublicDnsLookup(servers = PUBLIC_RESOLVERS): DomainDnsLookup {
  const resolvers = servers.map((server) => {
    const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 });
    resolver.setServers([server]);
    return resolver;
  });

  async function collect(query: (resolver: Resolver) => Promise<string[]>) {
    const results = await Promise.allSettled(resolvers.map(query));
    const values = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") for (const value of result.value) values.add(value);
    }
    return [...values];
  }

  return {
    txt: (name) => collect(async (resolver) => (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""))),
    cname: (hostname) => collect(async (resolver) =>
      (await resolver.resolveCname(hostname)).map((target) => target.toLowerCase().replace(/\.$/, ""))),
  };
}
