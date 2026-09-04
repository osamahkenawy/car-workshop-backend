#!/bin/bash
# ============================================================
# troubleshoot.sh — Fast diagnostics + safe common fixes for the
# car-workshop staging box (Ubuntu + PM2 + nginx + iptables).
#
# Usage:
#   sudo bash troubleshoot.sh              # full health check (no changes)
#   sudo bash troubleshoot.sh check        # same as no args
#   sudo bash troubleshoot.sh restart      # restart backend + reload nginx
#   sudo bash troubleshoot.sh firewall     # re-add HTTP/HTTPS/SSH ACCEPT rules
#   sudo bash troubleshoot.sh unban <ip>   # unban an IP from fail2ban
#   sudo bash troubleshoot.sh logs         # tail latest backend + nginx errors
#   sudo bash troubleshoot.sh help
# ============================================================

set -o pipefail

BACKEND_DIR="/var/www/car-workshop/backend"
FRONTEND_DIR="/var/www/car-workshop/frontend"
BACKEND_PORT="4000"
DOMAIN="workshop.pioneeruae.com"

# ── colours (fall back to plain text if the TTY doesn't support them) ─────
if [ -t 1 ]; then
  G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[36m'; D=$'\e[0m'
else
  G=''; Y=''; R=''; B=''; D=''
fi
ok()   { echo "${G}✓${D} $*"; }
warn() { echo "${Y}!${D} $*"; }
bad()  { echo "${R}✗${D} $*"; }
hdr()  { echo ""; echo "${B}── $* ──${D}"; }

need_root() {
  if [ "$EUID" -ne 0 ]; then
    echo "This script needs sudo. Re-run:  sudo bash $0 $*"
    exit 1
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# HEALTH CHECK — reports what's healthy and what isn't. No changes.
# ══════════════════════════════════════════════════════════════════════════
cmd_check() {
  hdr "1. PM2 process"
  if pm2 jlist 2>/dev/null | grep -q '"name":"car-workshop-backend"'; then
    pm2 status | grep -E 'car-workshop-backend|status' | head -5
    ok "backend process registered with PM2"
  else
    bad "backend NOT registered with PM2 — run: sudo bash $0 restart"
  fi

  hdr "2. Backend responds on :$BACKEND_PORT"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/plans" 2>/dev/null || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "404" ]; then
    ok "backend responded HTTP $code (anything not 000/timeout means it's alive)"
  else
    bad "backend NOT responding (got '$code') — run: sudo bash $0 restart"
  fi

  hdr "3. Ports 80 / 443 / $BACKEND_PORT listening"
  ss -lntp 2>/dev/null | grep -E ":(${BACKEND_PORT}|80|443)\b" || bad "one or more ports not listening"

  hdr "4. Nginx"
  if systemctl is-active --quiet nginx; then
    ok "nginx active"
  else
    bad "nginx NOT active — run: sudo systemctl start nginx"
  fi
  nginx -t 2>&1 | tail -2

  hdr "5. Nginx reaches backend (through the proxy)"
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: ${DOMAIN}" http://127.0.0.1/ 2>/dev/null || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ]; then
    ok "nginx serving HTTP $code for $DOMAIN"
  else
    bad "nginx returned '$code' for $DOMAIN — check nginx config"
  fi

  hdr "6. Firewall — INPUT chain policy & HTTP/HTTPS/SSH rules"
  local policy
  policy=$(iptables -L INPUT -n 2>/dev/null | head -1)
  echo "$policy"
  if echo "$policy" | grep -q 'policy DROP'; then
    warn "INPUT policy is DROP — the ACCEPT rules for 80/443/22 MUST be present"
  fi
  local rules
  rules=$(iptables -L INPUT -n 2>/dev/null | grep -E 'dpt:(22|80|443)')
  if [ -n "$rules" ]; then
    echo "$rules"
    ok "found ACCEPT rules for the essential ports"
  else
    bad "NO explicit ACCEPT rules for 22/80/443 — run: sudo bash $0 firewall"
  fi

  hdr "7. fail2ban"
  if command -v fail2ban-client >/dev/null; then
    fail2ban-client status | tail -3
    echo ""
    for jail in sshd nginx-http-auth nginx-404 nginx-badbots; do
      local banned
      banned=$(fail2ban-client status "$jail" 2>/dev/null | awk -F: '/Banned IP list/ {print $2}' | xargs)
      if [ -n "$banned" ]; then
        warn "$jail has banned IP(s): $banned"
      fi
    done
  else
    warn "fail2ban not installed"
  fi

  hdr "8. Disk / memory (quick pulse)"
  df -h / | tail -1
  free -h | grep -E 'Mem|Swap'

  hdr "9. Frontend directory has content"
  if [ -f "$FRONTEND_DIR/index.html" ]; then
    ok "$FRONTEND_DIR/index.html exists"
  else
    bad "$FRONTEND_DIR/index.html MISSING — the last deploy left it empty. Rebuild frontend."
  fi

  echo ""
  ok "check complete. If everything above is ${G}✓${D}, the site should be reachable at http://${DOMAIN}"
}

# ══════════════════════════════════════════════════════════════════════════
# RESTART — restart PM2 backend and reload nginx.
# ══════════════════════════════════════════════════════════════════════════
cmd_restart() {
  need_root "$@"
  hdr "Restarting backend"
  # runuser so PM2 stays owned by ubuntu (matches the pm2 startup daemon).
  runuser -l ubuntu -c 'pm2 restart car-workshop-backend --update-env' \
    || bad "PM2 restart failed — check: pm2 logs"
  runuser -l ubuntu -c 'pm2 save' >/dev/null 2>&1

  hdr "Reloading nginx"
  nginx -t && systemctl reload nginx && ok "nginx reloaded"

  sleep 2
  cmd_check
}

# ══════════════════════════════════════════════════════════════════════════
# FIREWALL — re-add ACCEPT rules for SSH / HTTP / HTTPS and persist them.
# Safe to run multiple times: uses -I to insert at the top and dedupes first.
# ══════════════════════════════════════════════════════════════════════════
cmd_firewall() {
  need_root "$@"
  hdr "Adding ACCEPT rules for SSH / HTTP / HTTPS"
  for port in 22 80 443; do
    # Remove any duplicates so we don't stack the same rule five times.
    while iptables -D INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT 2>/dev/null; do :; done
    iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
    ok "port $port ACCEPT rule inserted"
  done

  hdr "Persisting rules so they survive reboot"
  if ! command -v netfilter-persistent >/dev/null; then
    apt-get install -y iptables-persistent
  fi
  netfilter-persistent save
  ok "iptables rules saved"

  echo ""
  iptables -L INPUT -n | grep -E 'dpt:(22|80|443)'
}

# ══════════════════════════════════════════════════════════════════════════
# UNBAN — remove an IP from every active fail2ban jail.
# ══════════════════════════════════════════════════════════════════════════
cmd_unban() {
  need_root "$@"
  local ip="$2"
  if [ -z "$ip" ]; then
    echo "Usage:  sudo bash $0 unban <ip>"
    exit 1
  fi
  hdr "Unbanning $ip from all active jails"
  local jails
  jails=$(fail2ban-client status | awk -F: '/Jail list/ {print $2}' | tr -d ',' | xargs)
  for jail in $jails; do
    if fail2ban-client set "$jail" unbanip "$ip" 2>/dev/null; then
      ok "$jail: unbanned $ip"
    else
      warn "$jail: $ip not banned (or already unbanned)"
    fi
  done
  # Also try to drop any stale iptables entry (in case the ban survived fail2ban)
  iptables -S | grep -F "$ip" || echo "  no lingering iptables entry"
}

# ══════════════════════════════════════════════════════════════════════════
# LOGS — quick tail of recent errors from backend + nginx.
# ══════════════════════════════════════════════════════════════════════════
cmd_logs() {
  hdr "Backend errors (last 30)"
  local errlog
  errlog=$(ls -t /home/ubuntu/.pm2/logs/car-workshop-backend-error*.log 2>/dev/null | head -1)
  if [ -n "$errlog" ]; then
    tail -30 "$errlog"
  else
    warn "no PM2 error log found"
  fi

  hdr "Nginx errors (last 20)"
  tail -20 /var/log/nginx/error.log 2>/dev/null || warn "no nginx error log"

  hdr "System auth log — recent SSH failures (last 10)"
  grep -E 'Failed|Invalid' /var/log/auth.log 2>/dev/null | tail -10 || true
}

# ══════════════════════════════════════════════════════════════════════════
# HELP
# ══════════════════════════════════════════════════════════════════════════
cmd_help() {
  sed -n '2,15p' "$0"
}

# ── dispatch ──────────────────────────────────────────────────────────────
case "${1:-check}" in
  check|"")   cmd_check ;;
  restart)    cmd_restart "$@" ;;
  firewall)   cmd_firewall "$@" ;;
  unban)      cmd_unban "$@" ;;
  logs)       cmd_logs ;;
  help|-h|--help) cmd_help ;;
  *)          echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
