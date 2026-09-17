let body = "";
for await (const chunk of process.stdin) body += chunk;

const input = body.trim() ? JSON.parse(body) : null;
const output = {
  ok: true,
  action: "inspect-ts",
  runner: "node",
  spaceId: process.env.COHUB_SPACE_ID ?? null,
  input,
};

process.stdout.write(JSON.stringify(output));
