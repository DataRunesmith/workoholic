#!/bin/sh
# Writes the container's wrangler config for the chosen browser, applies D1
# migrations to /data and serves the Worker. Secrets come from the container
# environment and reach wrangler through a private env file.
set -eu

# Saved settings from a one-time /data/import.env (see import-settings.sh).
# shellcheck source=import-settings.sh
. /opt/app/docker/import-settings.sh

: "${PUBLIC_URL:=http://localhost:8787}"
: "${AUTH_MODE:=password}"
: "${BROWSER_MODE:=bundled}"
case "$AUTH_MODE" in
  password)
    [ "${#ADMIN_PASSWORD}" -ge 16 ] 2>/dev/null ||
      { echo "AUTH_MODE=password needs ADMIN_PASSWORD (at least 16 characters)." >&2; exit 1; } ;;
  cloudflare-access)
    [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ] && [ -n "${CF_ACCESS_AUD:-}" ] ||
      { echo "AUTH_MODE=cloudflare-access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD." >&2; exit 1; } ;;
  *) echo "AUTH_MODE must be password or cloudflare-access." >&2; exit 1 ;;
esac
case "$BROWSER_MODE" in
  bundled) remote=false ;;
  cloudflare)
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] ||
      { echo "BROWSER_MODE=cloudflare needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID." >&2; exit 1; }
    remote=true ;;
  *) echo "BROWSER_MODE must be bundled or cloudflare." >&2; exit 1 ;;
esac

# The configuration in D1 is encrypted with WORKOHOLIC_CONFIG_KEY. Without one, a key
# is generated once and kept in the data volume.
if [ -z "${WORKOHOLIC_CONFIG_KEY:-}" ]; then
  [ -s /data/config-key ] || (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >/data/config-key)
  WORKOHOLIC_CONFIG_KEY=$(cat /data/config-key)
fi

# Placeholder values for the rendered copy; resource ids only matter on Cloudflare.
PUBLIC_HOST=$(printf '%s' "$PUBLIC_URL" | sed 's|^[a-z]*://||; s|/.*||')
export PUBLIC_HOST
export CF_ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN:-}" CF_ACCESS_AUD="${CF_ACCESS_AUD:-}"
export D1_DATABASE_NAME=workoholic D1_DATABASE_ID=local SECRETS_STORE_ID=local
export CONFIG_NAMESPACE="${CONFIG_NAMESPACE:-Workoholic}" SITE_FAMILY="${SITE_FAMILY:-Skog}"
export THEME_KEY_PREFIX="${THEME_KEY_PREFIX:-workoholic}" THEME_COOKIE_DOMAIN="${THEME_COOKIE_DOMAIN:-}"

app=/opt/app
values=$(mktemp)
sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$app/cloudflare.example.env" | while read -r name; do
  printf '%s=%s\n' "$name" "$(printenv "$name" || true)"
done >"$values"
site=/srv/site
node /opt/app/tools/render.mjs "$values" "$site" >/dev/null
sed "s/__BROWSER_REMOTE__/$remote/" "$site/docker/wrangler.template.jsonc" >"$site/wrangler.container.jsonc"
cd "$site"

vars=$(mktemp)
chmod 600 "$vars"
{
  echo "PUBLIC_BASE_URL=${PUBLIC_URL%/}"
  echo "AUTH_MODE=$AUTH_MODE"
  echo "WORKOHOLIC_CONFIG_KEY=$WORKOHOLIC_CONFIG_KEY"
  for name in ADMIN_PASSWORD CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD SMTP_HOST SMTP_PORT SMTP_USER \
    SMTP_PASSWORD NOTIFY_EMAIL_TO NOTIFY_EMAIL_FROM NOTIFY_EMAIL_MODE STUDENTCONSULTING_EMAIL \
    STUDENTCONSULTING_PASSWORD STUDENTCONSULTING_AUTOSUBMIT; do
    value=$(printenv "$name" || true)
    [ -n "$value" ] && echo "$name=$value"
  done
} >>"$vars"

npx wrangler d1 migrations apply DB --local --persist-to /data --config wrangler.container.jsonc

node docker/scheduler.mjs &
exec npx wrangler dev --local --persist-to /data --config wrangler.container.jsonc \
  --ip 0.0.0.0 --port "${PORT:-8787}" --test-scheduled \
  --env-file "$vars" --show-interactive-dev-session=false
