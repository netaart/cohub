import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadGenerationBillingConfig,
  parseGenerationBillingConfig,
  resolveGenerationBillingReserve,
} from "./generation-billing.js";

test("generation billing config parses reserve caps and rejects invalid values", () => {
  const config = parseGenerationBillingConfig(`
schema: cohub.generation.billing.v1
models:
  seedance-2-0:
    reserveUsd: 12.5
  seedance-2-5:
    reserveUsd: 20
`);
  assert.equal(resolveGenerationBillingReserve(config, "seedance-2-0"), 12.5);
  assert.equal(resolveGenerationBillingReserve(config, "seedance-2-5"), 20);
  assert.equal(resolveGenerationBillingReserve(config, "other"), null);
  assert.throws(() => parseGenerationBillingConfig("models: { seedance: { reserveUsd: 0 } }"));
  assert.throws(() => parseGenerationBillingConfig("models: { seedance: { reserveUsd: 'x' } }"));
  assert.equal(parseGenerationBillingConfig("models: {}").reserves.size, 0);
});

test("an invalid generation billing config keeps the last valid whitelist", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-billing-"));
  try {
    const dir = join(root, "platform", ".cohub", "billing");
    await mkdir(dir, { recursive: true });
    const errors: unknown[] = [];
    const load = () => loadGenerationBillingConfig(root, (error) => errors.push(error));
    assert.equal((await load()).reserves.size, 0);

    await writeFile(join(dir, "generation-reserves.yaml"), "models: { seedance-2-0: { reserveUsd: 15 } }");
    assert.equal(resolveGenerationBillingReserve(await load(), "seedance-2-0"), 15);

    await writeFile(join(dir, "generation-reserves.yaml"), "models: { seedance-2-0: { reserveUsd: -1 } }  ");
    assert.equal(resolveGenerationBillingReserve(await load(), "seedance-2-0"), 15);
    assert.equal(errors.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
