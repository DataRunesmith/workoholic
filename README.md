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

## Sätt upp på Cloudflare

Du behöver bara en tillfällig token och ditt domännamn. Resten skapas, fylls i och deployas av ett skript.

1. **Aktivera R2** en gång i Cloudflare-dashboarden (R2). Det går inte att göra via API.
2. **Skapa en tillfällig token** med [den här förifyllda länken](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Workoholic%20setup%20(temporary)). Det måste vara ett **användartoken** (under My Profile). Workers Builds API:t stöder inte kontoägda tokens, så med ett sådant kan skriptet inte sätta build-kommandona. Länken fyller bara i formuläret, och poster som inte känns igen hoppas över utan fel, så kontrollera att D1, R2, Workers Scripts och Workers KV Storage syns. Lägg själv till **Secrets Store: Edit**, **Workers CI: Edit** (för att skriptet ska kunna sätta build-kommandona) och, för egen domän, **Workers Routes: Edit** (zon). Länken sätter omfånget till alla konton och alla zoner. Välj under Account Resources bara det konto du använder för Workoholic, och skicka sedan formuläret.
3. Kör:

   ```sh
   cp setup.example.env setup.env      # fyll i CLOUDFLARE_API_TOKEN och PUBLIC_HOST
   pnpm install
   pnpm setup:cloudflare --check       # visar vad som skulle skapas, ändrar inget
   pnpm setup:cloudflare               # skapar D1, R2 och nyckel, migrerar och deployar
   ```

4. Ett genererat inloggningslösenord hamnar i `.setup-secrets` (bara ägaren kan läsa filen). Spara det och radera filen.
5. Koppla repot under Workers & Pages → workoholic → Settings → Builds och kör `pnpm setup:cloudflare` igen (tokenet behövs fortfarande). Skriptet sätter då build- och deploy-kommandon själv. Inställningarna (inga hemligheter) lagras i en KV-namnrymd, `workoholic-config`, och bygget läser dem därifrån, så inga build-variabler behövs. Saknas behörigheten **Workers CI: Edit** skriver skriptet i stället ut de två kommandona som ska fyllas i för hand. Kan bygget inte läsa KV finns en reserv med build-variabler i samma utskrift. **Radera den tillfälliga token** i dashboarden först när detta steg är klart.

Skriptet kan köras om utan risk: befintliga resurser återanvänds, och krypteringsnyckeln `WORKOHOLIC_CONFIG_KEY` ersätts aldrig. Det är till för första uppsättningen och för att ändra inställningar. Kodändringar och nya migreringar på en körande installation går via Workers Builds, och bara en körning åt gången tillåts per kopia av repot (`.setup-lock`). Körs skriptet från flera kopior, samordna körningarna själv, annars kan två lösenord genereras och bara det sista fungerar. Om bygget stoppar vid migreringssteget kan Workers Builds standardtoken sakna D1-åtkomst. Välj då en egen token med D1: Edit, Workers Scripts: Edit och Workers KV Storage: Read (bygget läser inställningarna från KV) under Settings → Builds → API token. Den tillfälliga setup-tokenen är raderad då, så för `secrets:push` skapar du en ny token med Workers Scripts: Edit och lägger den som `CLOUDFLARE_API_TOKEN` i `setup.env`. Fler hemligheter, till exempel `STUDENTCONSULTING_EMAIL` och `STUDENTCONSULTING_PASSWORD`, läggs i filen `secrets.env` (rader av typen `NAMN=värde`, ligger i git-ignore) och skickas med `pnpm secrets:push`. Bara namnen skrivs ut. `setup.env` läses in av Node (`--env-file-if-exists`, kräver Node 22.9 eller nyare). Skripten kräver macOS, Linux eller WSL och fungerar inte direkt på Windows. Cloudflare Access sätts upp senare genom `AUTH=access` plus `CF_ACCESS_TEAM_DOMAIN` och `CF_ACCESS_AUD` i `setup.env`.

`docker/entrypoint.sh` renderar och startar appen från miljövariabler i en container, med data i `/data`.

English: see [docs/eng/README.md](docs/eng/README.md).
