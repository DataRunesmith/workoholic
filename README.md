# Workoholic

Söker jobb åt dig hos StudentConsulting, högst tio per kalendermånad, och samlar dem i en textfil. Appen är en Cloudflare Worker med D1, R2, Workflows och Browser Rendering, och är uppdelad i ett pnpm-arbetsyta: `apps/web`, `packages/core` och `packages/studentconsulting`.

Alla inställningar är platshållare av typen `__NAMN__`, och hemligheter lagras krypterade i appen.

## Kom igång

```sh
pnpm install
pnpm test
pnpm typecheck
```

Kör en egen kopia:

```sh
cp cloudflare.example.env mina-värden.env
node tools/render.mjs mina-värden.env build
(cd build && npx wrangler dev)
```

Hemligheter, till exempel `ADMIN_PASSWORD` och `SMTP_PASSWORD`, läggs inte i värdefilen. Databasen skapas av filerna i `migrations/`. Inloggning sker via Cloudflare Access.

`docker/entrypoint.sh` renderar och startar appen från miljövariabler i en container, med data i `/data`.

English: see [docs/eng/README.md](docs/eng/README.md).
