# Workoholic

Söker jobb åt dig hos StudentConsulting, högst tio per kalendermånad, och samlar dem i en textfil. Appen är en Cloudflare Worker med D1, R2, Workflows och Browser Rendering, och är uppdelad i en pnpm-arbetsyta: `apps/web`, `packages/core` och `packages/studentconsulting`.

Alla inställningar är platshållare av typen `__NAMN__`, så ingen miljöspecifik uppgift ligger i koden: dina egna värden ligger i en fil som git ignorerar, i hemligheter i GitHub Actions eller i byggvariabler hos Cloudflare. Din inloggning hos StudentConsulting och övriga hemligheter fyller du i i appen, där de lagras krypterade.

## Kör en egen kopia

Det finns fyra sätt, och alla ger samma app. Välj ett.

| Sätt | Du behöver | Körs på |
|---|---|---|
| [Docker](#docker) | Docker | Din egen dator eller server |
| [Direkt med Wrangler](#direkt-med-wrangler) | Node.js 24, ett Cloudflare-konto | Cloudflare |
| [GitHub Actions](#github-actions) | Ett GitHub-konto, ett Cloudflare-konto | Cloudflare, vid varje push till `main` |
| [Cloudflare Workers Builds](#cloudflare-workers-builds) | Ett GitHub- eller GitLab-konto, ett Cloudflare-konto | Cloudflare, vid varje push till `main` |

Ett GitHub-konto behövs bara för de två sista. För de två första räcker det att ladda ned källkoden som ZIP-fil eller klona den.

### Docker

```sh
ADMIN_PASSWORD='minst-8-tecken' docker compose up -d
```

Välj ett eget lösenord i stället för exemplet. Öppna <http://localhost:8787>, logga in med lösenordet och fyll i inställningarna. All data, även en genererad krypteringsnyckel, sparas i volymen `data`, så säkerhetskopiera den volymen. Jobbsajten besöks med en Chrome som containern laddar ned första gången den behövs; `compose.yaml` lägger till behörigheten `SYS_ADMIN` så att Chrome kan köra i sin egen sandlåda. Sätt `PUBLIC_URL` om appen nås på en annan adress. I stället för att skriva värdena på kommandoraden kan du lägga dem i en fil med namnet `.env` bredvid `compose.yaml`; git ignorerar den.

Porten publiceras bara på den här datorn. För att nå appen från andra datorer sätter du en omvänd proxy med HTTPS framför den; `BIND_ADDRESS=0.0.0.0` publicerar porten okrypterad på alla nätverksgränssnitt, så använd det bara i ett nätverk du litar på. Använd Docker Engine 28.3.3 eller senare; äldre versioner låter andra datorer i samma nätverk nå portar som publicerats på 127.0.0.1.

### Dina värden hos Cloudflare

De tre Cloudflare-sätten använder samma värden. De står i `cloudflare.example.env`:

| Namn | Värde |
|---|---|
| `PUBLIC_HOST` | Värdnamnet som appen körs på, till exempel `app.example.com`. Domänen måste finnas i ditt Cloudflare-konto. |
| `CF_ACCESS_TEAM_DOMAIN` | Din teamdomän i Cloudflare Access, `your-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | AUD-taggen (Application Audience) för Access-applikationen framför appen. Utan den kan ingen logga in, så `tools/deploy.sh` vägrar driftsätta så länge den är tom. |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | Namn och ID för din D1-databas. |
| `SECRETS_STORE_ID` | ID för din Secrets Store, som håller nyckeln som krypterar de sparade inställningarna. |
| `CONFIG_NAMESPACE` | Ett namn som blandas in i den krypteringen. Välj det en gång och byt det aldrig. |
| `THEME_KEY_PREFIX` | Namnet som temainställningen sparas under i webbläsaren, till exempel `workoholic`. |
| `THEME_COOKIE_DOMAIN` | Valfritt. En överordnad domän att dela temainställningen med dina andra sajter på. |
| `SITE_FAMILY` | Namnet som visas för standardtemat. |

Kommandona nedan kräver Node.js; varje steg går också att göra i Cloudflares kontrollpanel.

Gör detta en gång, före första driftsättningen. Det första och det tredje kommandot skriver ut ID:n till tabellen ovan; ett konto har en enda Secrets Store, så om du redan har en använder du dess ID från `npx wrangler secrets-store store list --remote` i stället för att skapa en:

```sh
npx wrangler d1 create workoholic
```

```sh
npx wrangler r2 bucket create workoholic-evidence
```

```sh
npx wrangler secrets-store store create workoholic --remote
```

Skapa krypteringsnyckeln i din Secrets Store. Kommandot frågar efter värdet; använd utdata från `openssl rand -base64 32`, spara en kopia och byt den aldrig:

```sh
npx wrangler secrets-store secret create DITT_STORE_ID --name WORKOHOLIC_CONFIG_KEY --scopes workers --remote
```

Lägg också till en egen Access-applikation (self-hosted) för `PUBLIC_HOST` under Zero Trust → Access → Applications och kopiera dess AUD-tagg, slå på Email Routing för domänen (Workern har en `send_email`-bindning) och skapa en API-token för driftsättning från mallen "Edit Cloudflare Workers" med behörigheterna Account: D1: Edit och Account: Secrets Store: Edit tillagda. Token är värdet för `CLOUDFLARE_API_TOKEN` nedan.

Efter första driftsättningen öppnar du appen och fyller i inställningarna. Tabellerna skapas och uppdateras av filerna i `migrations/` vid varje driftsättning.

### Direkt med Wrangler

```sh
cp cloudflare.example.env .cloudflare.env
```

Fyll i `.cloudflare.env` (git ignorerar alla `*.env`-filer utom exemplet), logga in en gång och driftsätt:

```sh
npx wrangler login
```

```sh
sh tools/deploy.sh .cloudflare.env
```

Kör det sista kommandot igen när du vill driftsätta en nyare version. `tools/deploy.sh` fyller i värdena i en tillfällig kopia, kör nya databasmigreringar, driftsätter kopian och tar bort den. Extra argument går vidare till `wrangler deploy`; `sh tools/deploy.sh .cloudflare.env --dry-run` bygger utan att röra databasen eller ladda upp något. Om `.cloudflare.env` också har raderna `CLOUDFLARE_API_TOKEN=...` och `CLOUDFLARE_ACCOUNT_ID=...` används de, och `wrangler login` behövs inte; om någon av de två redan är exporterad i skalet går det värdet före filen.

### GitHub Actions

Forka repot, eller pusha en kopia till ditt eget konto. Fyll i `.cloudflare.env` som ovan och lägg till raderna `CLOUDFLARE_API_TOKEN=...` och `CLOUDFLARE_ACCOUNT_ID=...`. Spara sedan alla värden som hemligheter i repot med [GitHub CLI](https://cli.github.com/):

```sh
grep -v '=$' .cloudflare.env | gh secret set -f - -R ditt-konto/workoholic
```

Samma sak går att göra för hand under Settings → Secrets and variables → Actions. Därefter driftsätter arbetsflödet Deploy varje push till `main`, och det kan startas för hand under Actions → Deploy → Run workflow. Värdena skrivs aldrig till någon fil i repot och GitHub maskerar dem i loggarna. Utan hemligheten `CLOUDFLARE_API_TOKEN` gör arbetsflödet ingenting.

### Cloudflare Workers Builds

Skapa en Worker med namnet `workoholic` från ditt repo i Cloudflares kontrollpanel (Workers & Pages → Create → Import a repository) och ange:

- Deploy command: `sh tools/deploy.sh`
- Build variables and secrets: varje namn i tabellen ovan med ditt värde
- API token: den token du skapade ovan; den token som Cloudflare skapar själv kan varken köra D1-migreringar eller binda Secrets Store
- Settings → Build → Branch control: stäng av Enable Preview Builds

Cloudflare driftsätter sedan varje push till `main`. Använd antingen detta eller GitHub Actions, inte båda, annars driftsätts varje push två gånger.

## Utveckla

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

Skriptet kan köras om utan risk: befintliga resurser återanvänds, och krypteringsnyckeln `WORKOHOLIC_CONFIG_KEY` ersätts aldrig.

**Efteråt**
- **Köra om setup:** för första uppsättningen och för att ändra inställningar, till exempel att byta inloggning till Cloudflare Access (`AUTH=access` plus `CF_ACCESS_TEAM_DOMAIN` och `CF_ACCESS_AUD` i `setup.env`). En omkörning behöver en token med setup-behörigheterna (D1, R2, Workers Scripts, Workers KV, Secrets Store och Workers CI). Har du raderat den första, skapa en ny med länken i steg 2. Bara en körning åt gången tillåts per kopia av repot (`.setup-lock`). Körs skriptet från flera kopior, samordna körningarna själv, annars kan två lösenord genereras och bara det sista fungerar.
- **Kodändringar och nya migreringar** på en körande installation går via Workers Builds. Om bygget stoppar vid migreringssteget kan Workers Builds standardtoken sakna D1-åtkomst. Välj då en egen token med D1: Edit, Workers Scripts: Edit och Workers KV Storage: Read (bygget läser inställningarna från KV) under Settings → Builds → API token.
- **Fler hemligheter**, till exempel `STUDENTCONSULTING_EMAIL` och `STUDENTCONSULTING_PASSWORD`, läggs i filen `secrets.env` (rader av typen `NAMN=värde`, ligger i git-ignore) och skickas med `pnpm secrets:push`. Bara namnen skrivs ut. Det räcker med en token med Workers Scripts: Edit som `CLOUDFLARE_API_TOKEN` i `setup.env`.
- **Krav:** Node 22.9 eller nyare (Node läser in `setup.env` med `--env-file-if-exists`) samt macOS, Linux eller WSL. Skripten fungerar inte direkt på Windows.

`docker/entrypoint.sh` renderar och startar appen från miljövariabler i en container, med data i `/data`.

English: see [docs/eng/README.md](docs/eng/README.md).
