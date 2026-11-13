# Workoholic

Applies for jobs on your behalf at StudentConsulting, at most ten per calendar month, and collects them in a text file. The app is a Cloudflare Worker with D1, R2, Workflows and Browser Rendering, organised as a pnpm workspace: `apps/web`, `packages/core` and `packages/studentconsulting`.

All settings are `__NAME__` placeholders, so nothing specific to an environment is committed: your own values stay in a file git ignores, in GitHub Actions secrets or in Cloudflare build variables. Your StudentConsulting sign-in and the other secrets are entered in the app and stored encrypted.

## Run your own copy

There are four ways, and they all end in the same app. Pick one.

| Way | You need | Runs on |
|---|---|---|
| [Docker](#docker) | Docker | Your own machine or server |
| [From your computer](#from-your-computer) | Node.js 24, a Cloudflare account | Cloudflare |
| [GitHub Actions](#github-actions) | A GitHub account, a Cloudflare account | Cloudflare, on every push to `main` |
| [Cloudflare Workers Builds](#cloudflare-workers-builds) | A GitHub or GitLab account, a Cloudflare account | Cloudflare, on every push to `main` |

A GitHub account is only needed for the last two. For the first two, download the source as a ZIP file or clone it.

### Docker

```sh
ADMIN_PASSWORD='at-least-8-characters' docker compose up -d
```

Choose a password of your own in place of the example. Open <http://localhost:8787>, sign in with the password and fill in the settings. All data, including a generated encryption key, is kept in the `data` volume, so back that volume up. The job site is visited with a Chrome that the container downloads the first time it is needed; `compose.yaml` adds the `SYS_ADMIN` capability so that Chrome can run in its own sandbox. Set `PUBLIC_URL` if the app is reached on another address. Instead of typing the values on the command line you can put them in a file named `.env` next to `compose.yaml`; git ignores it.

The port is published on this machine only. To reach the app from other machines, put a reverse proxy with HTTPS in front of it; `BIND_ADDRESS=0.0.0.0` publishes the port on every network interface without encryption, so use that on a trusted network only. Use Docker Engine 28.3.3 or later; older versions let other hosts on the same network reach ports published on 127.0.0.1.

### Your values on Cloudflare

The three Cloudflare ways use the same values. They are listed in `cloudflare.example.env`:

| Name | Value |
|---|---|
| `PUBLIC_HOST` | The host name the app is served on, for example `app.example.com`. The domain must be in your Cloudflare account. |
| `CF_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access team domain, `your-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | The Application Audience (AUD) tag of the Access application in front of the app. Without it nobody can sign in, so `tools/deploy.sh` refuses to deploy while it is empty. |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | Name and ID of your D1 database. |
| `SECRETS_STORE_ID` | ID of your Secrets Store, which holds the key that encrypts the stored settings. |
| `CONFIG_NAMESPACE` | A name that is mixed into that encryption. Choose it once and never change it. |
| `THEME_KEY_PREFIX` | Name used for the theme setting in the browser, for example `workoholic`. |
| `THEME_COOKIE_DOMAIN` | Optional. A parent domain to share the theme setting with your other sites. |
| `SITE_FAMILY` | Name shown for the default theme. |

The commands below need Node.js; each step can also be done in the Cloudflare dashboard.

Do this once, before the first deploy. The first and the third command print the IDs for the table above; an account has one Secrets Store, so if you already have one, use its ID from `npx wrangler secrets-store store list --remote` instead of creating it:

```sh
npx wrangler d1 create workoholic
```

```sh
npx wrangler r2 bucket create workoholic-evidence
```

```sh
npx wrangler secrets-store store create workoholic --remote
```

Create the encryption key in the store. The command asks for the value; use the output of `openssl rand -base64 32`, keep a copy and never change it:

```sh
npx wrangler secrets-store secret create YOUR_STORE_ID --name WORKOHOLIC_CONFIG_KEY --scopes workers --remote
```

Also add a self-hosted Access application for `PUBLIC_HOST` under Zero Trust → Access → Applications and copy its AUD tag, turn on Email Routing for the domain (the Worker has a `send_email` binding), and create an API token for deploying from the "Edit Cloudflare Workers" template with the permissions Account: D1: Edit and Account: Secrets Store: Edit added. The token is the value of `CLOUDFLARE_API_TOKEN` below.

After the first deploy, open the app and fill in the settings. The tables are created and updated by the files in `migrations/` on every deploy.

### From your computer

```sh
cp cloudflare.example.env .cloudflare.env
```

Fill in `.cloudflare.env` (git ignores every `*.env` file except the example), sign in once and deploy:

```sh
npx wrangler login
```

```sh
sh tools/deploy.sh .cloudflare.env
```

Run the last command again whenever you want to deploy a newer version. `tools/deploy.sh` fills the values into a temporary copy, applies new database migrations, deploys the copy and removes it. Extra arguments go to `wrangler deploy`; `sh tools/deploy.sh .cloudflare.env --dry-run` builds without touching the database or uploading. If `.cloudflare.env` also has the lines `CLOUDFLARE_API_TOKEN=...` and `CLOUDFLARE_ACCOUNT_ID=...`, they are used and `wrangler login` is not needed; if either of the two is already exported in your shell, that value wins over the file.

### GitHub Actions

Fork the repo, or push a copy to your own account. Fill in `.cloudflare.env` as above and add the lines `CLOUDFLARE_API_TOKEN=...` and `CLOUDFLARE_ACCOUNT_ID=...`. Then store every value as a repository secret with the [GitHub CLI](https://cli.github.com/):

```sh
grep -v '=$' .cloudflare.env | gh secret set -f - -R your-account/workoholic
```

The same can be done by hand under Settings → Secrets and variables → Actions. From then on the Deploy workflow deploys every push to `main`, and it can be started by hand under Actions → Deploy → Run workflow. The values are never written to a file in the repo and GitHub masks them in the logs. Without the secret `CLOUDFLARE_API_TOKEN` the workflow does nothing.

### Cloudflare Workers Builds

In the Cloudflare dashboard, create a Worker named `workoholic` from your repository (Workers & Pages → Create → Import a repository) and set:

- Deploy command: `sh tools/deploy.sh`
- Build variables and secrets: every name from the table above with your value
- API token: the token you created above; the token Cloudflare creates by itself cannot apply D1 migrations or bind the Secrets Store
- Settings → Build → Branch control: turn off Enable Preview Builds

Cloudflare then deploys every push to `main`. Use either this or the GitHub Actions way, not both, or each push is deployed twice.

## Develop

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

The script is safe to run again: existing resources are reused, and the encryption key `WORKOHOLIC_CONFIG_KEY` is never replaced.

**Afterwards**
- **Running setup again:** for the first setup and for changing settings, for example switching login to Cloudflare Access (`AUTH=access` plus `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `setup.env`). A rerun needs a token with the setup permissions (D1, R2, Workers Scripts, Workers KV, Secrets Store and Workers CI). If you deleted the first one, create a new one with the link in step 2. Only one run at a time is allowed per checkout (`.setup-lock`). If you run the script from several checkouts, coordinate the runs yourself, otherwise two passwords can be generated and only the last one works.
- **Code changes and new migrations** on a running installation go through Workers Builds. If the build stops at the migration step, the default Workers Builds token may lack D1 access. Pick your own token with D1: Edit, Workers Scripts: Edit and Workers KV Storage: Read (the build reads the settings from KV) under Settings → Builds → API token.
- **Further secrets**, for example `STUDENTCONSULTING_EMAIL` and `STUDENTCONSULTING_PASSWORD`, go in the file `secrets.env` (`NAME=value` lines, git-ignored) and are sent with `pnpm secrets:push`. Only the names are printed. A token with Workers Scripts: Edit as `CLOUDFLARE_API_TOKEN` in `setup.env` is enough.
- **Requirements:** Node 22.9 or newer (Node loads `setup.env` with `--env-file-if-exists`) and macOS, Linux or WSL. The scripts do not run directly on Windows.

`docker/entrypoint.sh` renders and starts the app from environment variables in a container, with data in `/data`.
