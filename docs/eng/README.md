# Workoholic

Applies for jobs on your behalf at StudentConsulting, at most ten per calendar month, and collects them in a text file. The app is a Cloudflare Worker with D1, R2, Workflows and Browser Rendering, organised as a pnpm workspace: `apps/web`, `packages/core` and `packages/studentconsulting`.

All settings are `__NAME__` placeholders, and secrets are stored encrypted in the app.

## Getting started

```sh
pnpm install
pnpm test
pnpm typecheck
```

Run your own copy:

```sh
cp cloudflare.example.env my-values.env
node tools/render.mjs my-values.env build
(cd build && npx wrangler dev)
```

Secrets such as `ADMIN_PASSWORD` and `SMTP_PASSWORD` do not belong in the values file. The database is created by the files in `migrations/`. Sign-in goes through Cloudflare Access.

`docker/entrypoint.sh` renders and starts the app from environment variables in a container, with data in `/data`.
