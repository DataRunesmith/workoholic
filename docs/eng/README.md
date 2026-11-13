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
2. **Create a temporary token** with [this prefilled link](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Workoholic%20setup%20(temporary)). It must be a **user token** (under My Profile). The Workers Builds API does not accept account-owned tokens, so with one the script cannot set the build commands. The link only fills in the form, and entries that are not recognised are dropped without an error, so check that D1, R2, Workers Scripts and Workers KV Storage show up. Add **Secrets Store: Edit**, **Workers CI: Edit** (so the script can set the build commands) and, for a custom domain, **Workers Routes: Edit** (zone) yourself. The link sets the scope to all accounts and all zones. Under Account Resources, select only the account you use for Workoholic, then submit the form.
3. Run:

   ```sh
   cp setup.example.env setup.env      # fill in CLOUDFLARE_API_TOKEN and PUBLIC_HOST
   pnpm install
   pnpm setup:cloudflare --check       # shows what would be created, changes nothing
   pnpm setup:cloudflare               # creates D1, R2 and the key, migrates and deploys
   ```

4. A generated sign-in password is written to `.setup-secrets` (readable by the owner only). Save it and delete the file.
5. Connect the repo under Workers & Pages → workoholic → Settings → Builds and run `pnpm setup:cloudflare` again (the token is still needed). The script then sets the build and deploy commands itself. The settings (no secrets) are stored in a KV namespace, `workoholic-config`, and the build reads them from there, so no build variables are needed. Without the **Workers CI: Edit** permission the script prints the two commands to fill in by hand instead. If the build cannot read KV, the same output has a fallback with build variables. **Delete the temporary token** in the dashboard only once this step is done.

The script is safe to run again: existing resources are reused, and the encryption key `WORKOHOLIC_CONFIG_KEY` is never replaced. It is meant for the first setup and for changing settings. Code changes and new migrations on a running installation go through Workers Builds, and only one run at a time is allowed (`.setup-lock`). If the build stops at the migration step, the default Workers Builds token may lack D1 access. Pick your own token with D1: Edit, Workers Scripts: Edit and Workers KV Storage: Read (the build reads the settings from KV) under Settings → Builds → API token. The temporary setup token is deleted by then, so for `secrets:push` create a new token with Workers Scripts: Edit and put it in `setup.env` as `CLOUDFLARE_API_TOKEN`. Further secrets, for example `STUDENTCONSULTING_EMAIL` and `STUDENTCONSULTING_PASSWORD`, go in the file `secrets.env` (`NAME=value` lines, git-ignored) and are sent with `pnpm secrets:push`. Only the names are printed. Node loads `setup.env` itself (`--env-file-if-exists`, needs Node 22.9 or newer). The scripts need macOS, Linux or WSL and do not run directly on Windows. Cloudflare Access is set up later with `AUTH=access` plus `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `setup.env`.

`docker/entrypoint.sh` renders and starts the app from environment variables in a container, with data in `/data`.
