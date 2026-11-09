#!/usr/bin/env bash
# Read-only system inventory for the proposed single-process pilot.
set -u
export LC_ALL=C

section() { printf '\n--- %s ---\n' "$1"; }
available() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Run this script on the target Linux host.\n' >&2
  exit 2
fi

data_path="${LSW_PREFLIGHT_DATA_DIR:-/}"
section "OS and CPU load"
uname -srmo
if [[ -r /etc/os-release ]]; then
  awk '/^(NAME|VERSION|ID|VERSION_ID)=/ { print }' /etc/os-release
fi
getconf _NPROCESSORS_ONLN 2>/dev/null || true
if available uptime; then uptime; fi
if [[ -r /proc/loadavg ]]; then cat /proc/loadavg; fi

section "Memory and swap"
if available free; then
  free -m
elif [[ -r /proc/meminfo ]]; then
  awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { print }' /proc/meminfo
fi
if [[ -r /proc/pressure/memory ]]; then cat /proc/pressure/memory; fi

section "Disk capacity and inodes"
df -hP /
df -iP /
if [[ "$data_path" != "/" ]]; then
  if [[ -d "$data_path" ]]; then
    df -hP -- "$data_path"
    df -iP -- "$data_path"
  else
    printf 'Proposed data directory does not exist: %s\n' "$data_path"
  fi
fi

section "Listening ports"
if available ss; then
  ss -lntu
else
  printf 'ss is unavailable. Check the listening TCP and UDP ports separately.\n'
fi

section "Running services and largest processes"
if available systemctl; then
  systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null |
    awk '{ print $1 }'
fi
if available ps; then
  ps -eo comm,pcpu,pmem,rss --sort=-rss | head -n 16
fi

section "Reverse proxy inventory"
for proxy in nginx caddy apache2 httpd; do
  if available "$proxy"; then printf '%s: %s\n' "$proxy" "$(command -v "$proxy")"; fi
done
for conf in /etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/caddy/Caddyfile /etc/apache2/sites-enabled /etc/httpd/conf.d; do
  if [[ -e "$conf" ]]; then printf '%s\n' "$conf"; fi
  if [[ -d "$conf" && -r "$conf" ]]; then
    find "$conf" -maxdepth 1 -mindepth 1 \( -type f -o -type l \) -printf '  %f\n'
  fi
done

printf '\nReview the inventory with a representative website peak-load baseline.\n'
