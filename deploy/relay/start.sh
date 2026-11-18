#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 2 ]; then
  echo "Usage: ./start.sh PUBLIC_IPV4_OR_DOMAIN /absolute/path/relay-routes.json" >&2
  exit 2
fi
relay_domain=$1
relay_routes=$2
case "$relay_domain" in ''|*[!a-zA-Z0-9.-]*|.*|*..*|*-|*.) echo "Invalid public relay address" >&2; exit 2;; esac
relay_caddyfile=./Caddyfile
case "$relay_domain" in
  *[!0-9.]*)
    case "$relay_domain" in *.*) ;; *) echo "A public DNS domain or IPv4 address is required" >&2; exit 2;; esac
    [ "${#relay_domain}" -le 253 ] || { echo "Invalid relay domain" >&2; exit 2; }
    relay_saved_ifs=$IFS
    IFS=.
    for relay_label in $relay_domain; do
      case "$relay_label" in -*|*-) echo "Invalid relay domain label" >&2; exit 2;; esac
      [ "${#relay_label}" -le 63 ] || { echo "Invalid relay domain label" >&2; exit 2; }
    done
    IFS=$relay_saved_ifs
    # A DNS TLD is alphabetic or punycode. Reject number-like final labels so
    # URL parsers cannot reinterpret a supposed domain as hex/octal IPv4.
    relay_tld=${relay_domain##*.}
    case "$relay_tld" in
      *[!a-zA-Z]*) case "$relay_tld" in xn--*|XN--*) ;; *) echo "Invalid public DNS suffix" >&2; exit 2;; esac;;
    esac
    ;;
  *)
    # Accept canonical dotted-decimal unicast addresses only. Private, shared,
    # loopback, link-local, documentation, benchmark and reserved ranges cannot
    # receive the public IP certificate needed by the normal clients.
    if ! printf '%s\n' "$relay_domain" | awk -F. '
      NF != 4 { exit 1 }
      {
        for (i=1; i<=4; i++) if ($i !~ /^[0-9]+$/ || length($i)>3 || (length($i)>1 && substr($i,1,1)=="0") || $i+0>255) exit 1
        a=$1+0; b=$2+0; c=$3+0
        if (a==0 || a==10 || a==127 || a>=224 ||
            (a==100 && b>=64 && b<=127) || (a==169 && b==254) ||
            (a==172 && b>=16 && b<=31) ||
            (a==192 && ((b==0 && (c==0 || c==2)) || (b==88 && c==99) || b==168)) ||
            (a==198 && (b==18 || b==19 || (b==51 && c==100))) ||
            (a==203 && b==0 && c==113)) exit 1
      }'; then
      echo "Use the server's fixed public IPv4 address; private, reserved or malformed IP addresses are not allowed" >&2
      exit 2
    fi
    relay_caddyfile=./Caddyfile.ip
    ;;
esac
case "$relay_routes" in /*) ;; *) echo "Use an absolute route hash file path" >&2; exit 2;; esac
[ -f "$relay_routes" ] || { echo "Route hash file does not exist" >&2; exit 2; }
cd "$(dirname "$0")"
command -v docker >/dev/null
# This file contains hashes of random route credentials, never the credentials themselves.
# Docker Compose file-backed secrets preserve host modes; uid 1000 must be able to read it.
[ ! -L config ] && [ ! -L .env ] && [ ! -L config/routes.json ] || { echo "Deployment config must not be a symlink" >&2; exit 2; }
[ ! -e .env ] || [ -f .env ] || { echo "Deployment .env must be a regular file" >&2; exit 2; }
mkdir -p config
relay_routes_tmp=$(mktemp config/.routes.XXXXXX)
relay_env_tmp=
trap 'rm -f "$relay_routes_tmp" "$relay_env_tmp"' 0
trap 'exit 130' HUP INT TERM
relay_env_tmp=$(mktemp .env.XXXXXX)
cp "$relay_routes" "$relay_routes_tmp"
chmod 0444 "$relay_routes_tmp"
# Relative paths are resolved against this Compose file. They also avoid
# dotenv interpolation of special characters in the release directory path.
printf 'COMPOSE_PROJECT_NAME=boujoy-relay\nBOUJOY_RELAY_DOMAIN=%s\nBOUJOY_RELAY_ROUTES_FILE=./config/routes.json\nBOUJOY_RELAY_CADDYFILE=%s\n' "$relay_domain" "$relay_caddyfile" > "$relay_env_tmp"
chmod 0600 "$relay_env_tmp"
export COMPOSE_PROJECT_NAME=boujoy-relay
export BOUJOY_RELAY_DOMAIN="$relay_domain"
export BOUJOY_RELAY_CADDYFILE="$relay_caddyfile"
# Validate the staged configuration without changing the files used by an
# existing deployment. Environment precedence points this preflight at the
# staged route table; the persisted dotenv still contains the stable path.
export BOUJOY_RELAY_ROUTES_FILE="./$relay_routes_tmp"
docker compose --env-file "$relay_env_tmp" config --quiet
mv -f "$relay_routes_tmp" config/routes.json
mv -f "$relay_env_tmp" .env
export BOUJOY_RELAY_ROUTES_FILE=./config/routes.json
# File-backed secrets are bind mounts: replacing routes.json atomically needs
# container recreation so an old inode is never retained as the active table.
docker compose up --build --force-recreate -d || {
  relay_up_status=$?
  echo 'Container startup failed after committing configuration; no automatic rollback was performed. Inspect docker compose ps/logs before retrying.' >&2
  exit "$relay_up_status"
}
printf 'Relay configured for https://%s/healthz\n' "$relay_domain"
echo 'Saved .env (0600); run docker compose ps/logs/restart from deploy/relay with the same project configuration.'
echo 'Verify TLS health and both authenticated tunnel lanes before marking remote access available.'
