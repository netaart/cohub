# Contributing

Thanks for contributing to Cohub.

## Development

```bash
pnpm install
pnpm dev
```

Quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Guidelines

- Prefer small, focused changes.
- Keep UI copy in English.
- Do not commit secrets, real deploy values, or private registry tokens.
- Copy `deploy/**/values.example.yaml` to `values.yaml` for local deploy experiments.
- Billing is optional. Leave `TALESOFAI_BILLING_*` unset to run with billing disabled.

## Changes

This repository ships directly on `main` (no long-lived feature branches).

1. Keep changes small and focused.
2. Describe the problem and the approach in the commit message.
3. Ensure lint and typecheck pass before pushing.
4. Changesets that touch Board end with a `Hosts:` line: what an app embedding the
   Board must change, with the code, or `Hosts: no action`.
