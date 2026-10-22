import { normalizeAppDomainHostname, type AppDomainRecord, type CohubHttpClient } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { getAppByRef } from "../app-ref.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";

async function confirm(question: string, opts: { yes?: boolean }, hint: string): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return error("Confirmation required", hint);
  process.stdout.write(`${question} [y/N] `);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

async function findDomain(client: CohubHttpClient, appId: string, ref: string): Promise<AppDomainRecord> {
  const { domains } = await client.apps.listDomains(appId);
  const target = normalizeAppDomainHostname(ref) ?? ref.trim().toLowerCase();
  const domain = domains.find((item) => item.id === ref || item.hostname === target);
  return domain ?? error(`Domain not found: ${ref}`, "Run `cohub apps domains ls <app>` to see the App's domains.");
}

const info = (message: string) => console.log(message);

function printDomain(domain: AppDomainRecord): void {
  table([{
    hostname: domain.hostname,
    status: domain.status,
    certificate: domain.certificateStatus ?? "-",
    error: domain.error?.message ?? "",
  }], [
    { key: "hostname", label: "Hostname" },
    { key: "status", label: "Status" },
    { key: "certificate", label: "Certificate" },
    { key: "error", label: "Error" },
  ]);
  if (domain.status === "active") return;
  info("Add these DNS records at your DNS provider:");
  table(domain.dnsRecords.map((record) => ({
    ...record,
    state: record.satisfied === true ? "ok" : record.satisfied === false ? "missing" : "-",
  })), [
    { key: "type", label: "Type" },
    { key: "name", label: "Name" },
    { key: "value", label: "Value" },
    { key: "state", label: "State" },
  ]);
}

export function registerAppDomains(appsCmd: Command): void {
  const domainsCmd = appsCmd.command("domains").description("Custom domains for published Apps");

  domainsCmd
    .command("list <app>")
    .alias("ls")
    .description("List the App's custom domains")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const result = await client.apps.listDomains(detail.app.id);
        if (jsonRequested(opts)) return outJson(result);
        if (!result.enabled && result.domains.length === 0) return info("Custom domains are not enabled on this deployment.");
        if (result.domains.length === 0) return info(`No custom domain. Add one with \`cohub apps domains add ${appRef} <hostname>\` ($${result.priceUsd}, one-time).`);
        result.domains.forEach(printDomain);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  domainsCmd
    .command("add <app> <hostname>")
    .description("Bind a custom domain; charged once when it goes live")
    .option("-y, --yes", "Confirm the one-time charge")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, hostname: string, opts: { yes?: boolean; json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const { priceUsd } = await client.apps.listDomains(detail.app.id);
        await confirm(
          `Binding ${hostname} costs $${priceUsd}, charged once when the domain goes live. Continue?`,
          opts,
          `Pass --yes to accept the one-time $${priceUsd} charge.`,
        );
        const { domain } = await client.apps.addDomain(detail.app.id, hostname);
        if (jsonRequested(opts)) return outJson(domain);
        ok(`Domain added: ${domain.hostname}`);
        printDomain(domain);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  domainsCmd
    .command("check <app> <domain>")
    .description("Check DNS and certificate status now")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, domainRef: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const target = await findDomain(client, detail.app.id, domainRef);
        const { domain } = await client.apps.checkDomain(detail.app.id, target.id);
        if (jsonRequested(opts)) return outJson(domain);
        printDomain(domain);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  domainsCmd
    .command("rm <app> <domain>")
    .alias("remove")
    .description("Remove a custom domain")
    .option("-y, --yes", "Confirm removal")
    .action(async (appRef: string, domainRef: string, opts: { yes?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const target = await findDomain(client, detail.app.id, domainRef);
        await confirm(`Remove ${target.hostname}? The one-time charge is not refunded.`, opts, "Pass --yes to remove the domain.");
        const result = await client.apps.removeDomain(detail.app.id, target.id);
        ok(result.domain ? `Removing ${target.hostname}; its certificate is being released` : `Domain removed: ${target.hostname}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
