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

## Set up on Cloudflare

All you need is a temporary token and your domain name. A script creates the resources, fills in the configuration and deploys.

1. **Enable R2** once in the Cloudflare dashboard (R2). It cannot be done through the API.
2. **Create a temporary token** with [this prefilled link](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&name=Workoholic%20setup%20(temporary)). The link only fills in the form. Add **Secrets Store: Edit**, **Workers CI: Edit** (so the script can set the build commands) and, for a custom domain, **Workers Routes: Edit** (zone) yourself, choose the whole account as scope and submit the form.
3. Run:

   ```sh
   cp setup.example.env setup.env      # fill in CLOUDFLARE_API_TOKEN and PUBLIC_HOST
   pnpm install
   pnpm setup:cloudflare --check       # shows what would be created, changes nothing
   pnpm setup:cloudflare               # creates D1, R2 and the key, migrates and deploys
   ```

4. A generated sign-in password is written to `.setup-secrets` (readable by the owner only). Save it and delete the file. **Then delete the temporary token** in the dashboard.
5. Connect the repo under Workers & Pages → workoholic → Settings → Builds and run `pnpm setup:cloudflare` again. The script then sets the build and deploy commands and build variables itself (no secrets). Without the **Workers CI: Edit** permission it prints exactly what to fill in by hand instead.

The script is safe to run again: existing resources are reused, and the encryption key `WORKOHOLIC_CONFIG_KEY` is never replaced. Further secrets, for example `STUDENTCONSULTING_EMAIL` and `STUDENTCONSULTING_PASSWORD`, go in a file of `NAME=value` lines and are sent with `pnpm secrets:push file`. Only the names are printed. Cloudflare Access is set up later with `AUTH=access` plus `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `setup.env`.

`docker/entrypoint.sh` renders and starts the app from environment variables in a container, with data in `/data`.
