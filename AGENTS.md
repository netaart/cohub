1. Data is paramount — never compromise data safety or integrity
2. For interaction and UI analysis or changes, study and apply the design skills
3. Deliver features end-to-end: server, SDK, CLI, and web (desktop and mobile)
4. First-screen experience is critical — prioritize local data caching
5. Stay elegant and concise, keep overall consistency; prefer extra refactoring over leaving things messy
6. Performance matters everywhere: DB, server, and frontend
7. IndexedDB data always comes from reliable server data
8. Default data loading strategy: prefer local data for interaction, silently fetch related server data to refresh cache and UI, minimize layout-disrupting loading states, and avoid render thrashing or layout jumps
9. Care about multi-client sync experience; design elegant and efficient real-time events
10. Web UI copy uses the existing i18n/Paraglide messages and renders exactly one locale at a time. CLI output, logs, server/API/SDK errors, tests, and developer tooling use concise English only; localized product documentation and locale files are the exceptions.

## Git commit

Add `Cohub Session: https://cohub.live/spaces/${COHUB_SPACE_ID}/sessions/${COHUB_SESSION_ID}` as a footer, if the environment variables are set.

## Release Workflow

```bash
# 1. Publish npm packages: merge the "Version Packages" PR opened by CI

# 2. Generate changelog and create project tag
pnpm changelog:release v1.99.0

# 3. Push
git push && git push origin v1.99.0
```

See `scripts/changelog/README.md` for details.
