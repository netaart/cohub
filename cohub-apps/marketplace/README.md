# Marketplace

A standalone first-party Cohub App for discovering and installing Apps.

The App uses `cohub.context()` and takes `invocation.spaceId` as its initial Space. It requests the existing `file.view` and `file.edit` scopes for that Space with `cohub.auth.authorize()`, reads `.cohub/apps.json`, and writes validated marketplace entries back with the current file revision. It does not introduce a separate App-management permission.

## Develop

```bash
cd cohub-apps/marketplace
npm install
npm run dev
```

Runtime context and authorization are only available inside a published Cohub App. Build and test locally with:

```bash
npm run check
```

## Publish

```bash
npm run build
cohub apps publish marketplace \
  --dir dist \
  --app-scope file.view \
  --app-scope file.edit \
  --hide-cohub-bar
```

The catalog source is baked in at build time and defaults to the production catalog. Point a build at a different catalog with the `CATALOG_URL` environment variable (shell env or `.env` file):

```bash
CATALOG_URL=https://example.com/catalog.dev.v1.json npm run build
```
