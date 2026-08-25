#!/bin/bash
# ============================================================
# Car Workshop Platform — Full Deploy for Red Hat Enterprise Linux
# Server  : EDCDCMWSSTG01  (10.10.241.84)
# User    : osamah.kenawy
# Run as  : bash deploy-rhel.sh
# ============================================================
set -e

# ── Configuration ────────────────────────────────────────────
# Nothing secret is committed here. Supply values in the environment:
#   DB_PASS=... SERVER_IP=... bash deploy-rhel.sh
SERVER_IP="${SERVER_IP:-10.10.241.84}"
BACKEND_DIR="${BACKEND_DIR:-/var/www/car-workshop/backend}"
FRONTEND_DIR="${FRONTEND_DIR:-/var/www/car-workshop/frontend}"
BACKEND_REPO="${BACKEND_REPO:-https://github.com/osamahkenawy/car-workshop-backend.git}"
FRONTEND_REPO="${FRONTEND_REPO:-https://github.com/osamahkenawy/car-workshop-frontend.git}"
DB_NAME="${DB_NAME:-car_workshop}"
DB_USER="${DB_USER:-root}"

# SR-02 — the database password used to be hard-coded in this file, in a public
# repository. It must now come from the environment; the script refuses to run
# without it rather than falling back to a known value.
if [ -z "${DB_PASS:-}" ]; then
  echo "ERROR: DB_PASS is not set."
  echo "  Run:  DB_PASS='<mysql password>' bash deploy-rhel.sh"
  exit 1
fi

# SR-02 — the JWT secret was "rhel-staging-jwt-secret-$(date +%s)". The only
# unknown in that is a unix timestamp, so an attacker who knows roughly when the
# deploy ran can brute-force the signing key in seconds and mint valid tokens
# for any account. Generate a real one, and keep it across redeploys so existing
# sessions are not silently invalidated.
JWT_SECRET_FILE="${JWT_SECRET_FILE:-/etc/car-workshop/jwt.secret}"
if [ -s "$JWT_SECRET_FILE" ]; then
  JWT_SECRET="$(sudo cat "$JWT_SECRET_FILE")"
  echo "  Reusing existing JWT secret from ${JWT_SECRET_FILE}"
else
  JWT_SECRET="$(openssl rand -hex 32)"
  sudo mkdir -p "$(dirname "$JWT_SECRET_FILE")"
  printf '%s' "$JWT_SECRET" | sudo tee "$JWT_SECRET_FILE" >/dev/null
  sudo chmod 600 "$JWT_SECRET_FILE"
  echo "  Generated a new 256-bit JWT secret → ${JWT_SECRET_FILE}"
fi

echo ""
echo "=========================================================="
echo "  Car Workshop Platform — RHEL Deploy"
echo "  Server : $(hostname)  /  ${SERVER_IP}"
echo "=========================================================="

# ── STEP 1: System packages ──────────────────────────────────
echo ""
echo "[1/7] Installing system packages (git, nginx, node 20)..."

sudo dnf install -y git

if ! command -v node &>/dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
else
  echo "  Node $(node -v) already installed."
fi

if ! command -v nginx &>/dev/null; then
  sudo dnf install -y nginx
  sudo systemctl enable nginx
  sudo systemctl start nginx
else
  echo "  Nginx already installed."
fi

if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
else
  echo "  PM2 $(pm2 -v) already installed."
fi

# ── STEP 2: MySQL 8 ──────────────────────────────────────────
echo ""
echo "[2/7] Setting up MySQL 8..."

if ! command -v mysql &>/dev/null; then
  echo "  Installing MySQL 8 community server..."
  # Works for RHEL 8/9 — pick the right el version
  RHEL_VER=$(rpm --eval '%{rhel}')
  sudo dnf install -y "https://dev.mysql.com/get/mysql80-community-release-el${RHEL_VER}-1.noarch.rpm" || \
  sudo dnf install -y "https://dev.mysql.com/get/mysql80-community-release-el9-1.noarch.rpm"
  sudo dnf install -y mysql-community-server
  sudo systemctl enable mysqld
  sudo systemctl start mysqld

  echo "  Waiting for MySQL to start..."
  sleep 5

  # Grab the auto-generated temporary root password
  TMP_PASS=$(sudo grep 'temporary password' /var/log/mysqld.log | tail -1 | awk '{print $NF}')
  echo "  Temporary MySQL root password: ${TMP_PASS}"
  echo ""
  echo "  ⚠️  MySQL requires a secure password. Resetting root password..."
  # Reset password to our desired one and relax validate_password for this setup
  mysql --connect-expired-password -u root -p"${TMP_PASS}" -e \
    "ALTER USER 'root'@'localhost' IDENTIFIED BY '${DB_PASS}'; FLUSH PRIVILEGES;" 2>/dev/null || true

  echo "  MySQL root password set to: ${DB_PASS}"
else
  echo "  MySQL already installed."
fi

echo "  Creating database if not exists..."
mysql -u "${DB_USER}" -p"${DB_PASS}" -e "CREATE DATABASE IF NOT EXISTS ${DB_NAME};" 2>/dev/null || true

# ── STEP 3: App directories ───────────────────────────────────
echo ""
echo "[3/7] Creating app directories..."
sudo mkdir -p "$BACKEND_DIR"
sudo mkdir -p "$FRONTEND_DIR"
sudo chown -R "$(whoami):$(whoami)" /var/www/car-workshop

# ── STEP 4: Backend ───────────────────────────────────────────
echo ""
echo "[4/7] Deploying backend..."

if [ -d "${BACKEND_DIR}/.git" ]; then
  echo "  Updating existing clone..."
  cd "$BACKEND_DIR"
  git fetch origin && git reset --hard origin/main
else
  echo "  Cloning from GitHub..."
  git clone "$BACKEND_REPO" "$BACKEND_DIR"
  cd "$BACKEND_DIR"
fi

echo "  Installing npm dependencies..."
npm install

echo "  Writing .env..."
cat > "${BACKEND_DIR}/.env" << ENVEOF
NODE_ENV=production
PORT=4000
BACKEND_URL=http://${SERVER_IP}
BASE_URL=http://${SERVER_IP}
FRONTEND_URL=http://${SERVER_IP}

DB_HOST=localhost
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
MECHANIC_ACCESS_TTL_SHORT=12h
MECHANIC_REFRESH_TTL_DAYS=30
API_KEY_PREFIX=cw_

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=no-reply@workshop.pioneeruae.com
SMTP_FROM_NAME=Car Workshop Platform

CRON_TZ=Asia/Dubai
VAT_ENABLED=true
VAT_RATE=5.0
LOG_OTP_SECRET=false
ENVEOF

echo "  Running DB migrations..."
mysql -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" < "${BACKEND_DIR}/src/migrations/car_workshop.sql"           2>/dev/null || true
mysql -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" < "${BACKEND_DIR}/src/migrations/post/00_schema_patches.sql" 2>/dev/null || true
mysql -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" < "${BACKEND_DIR}/src/migrations/post/01_seed_countries.sql" 2>/dev/null || true
mysql -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" < "${BACKEND_DIR}/src/migrations/post/02_sow_schema.sql"     2>/dev/null || true

echo "  Starting backend with PM2..."
pm2 delete car-workshop-backend 2>/dev/null || true
pm2 start "${BACKEND_DIR}/src/server.js" \
  --name car-workshop-backend \
  --max-memory-restart 512M
pm2 save

# Enable PM2 to start on system boot
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null || true

# ── STEP 5: Frontend ──────────────────────────────────────────
echo ""
echo "[5/7] Building and deploying frontend..."

FRONTEND_TMP="/tmp/car-workshop-frontend-src"
if [ -d "${FRONTEND_TMP}/.git" ]; then
  cd "$FRONTEND_TMP"
  git fetch origin && git reset --hard origin/main
else
  rm -rf "$FRONTEND_TMP"
  git clone "$FRONTEND_REPO" "$FRONTEND_TMP"
  cd "$FRONTEND_TMP"
fi

npm install
VITE_API_URL="http://${SERVER_IP}" npm run build

sudo rm -rf "${FRONTEND_DIR:?}"/*
sudo cp -r "${FRONTEND_TMP}/dist/." "$FRONTEND_DIR/"

# Fix SELinux context so Nginx can serve static files
sudo chcon -Rt httpd_sys_content_t "$FRONTEND_DIR" 2>/dev/null || true

echo "  Frontend deployed."

# ── STEP 6: Nginx config ──────────────────────────────────────
echo ""
echo "[6/7] Configuring Nginx..."

sudo tee /etc/nginx/conf.d/car-workshop.conf > /dev/null << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_IP} _;

    # Frontend SPA
    root ${FRONTEND_DIR};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass         http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    # Socket.IO
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
    }

    # File uploads
    location /uploads/ {
        proxy_pass       http://127.0.0.1:4000/uploads/;
        proxy_set_header Host \$host;
    }

    client_max_body_size 50M;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
}
NGINXEOF

# Allow SELinux to let Nginx talk to backend on port 4000
sudo setsebool -P httpd_can_network_connect 1 2>/dev/null || true

sudo nginx -t && sudo systemctl reload nginx

# ── STEP 7: Firewall ─────────────────────────────────────────
echo ""
echo "[7/7] Opening firewall ports..."
sudo firewall-cmd --permanent --add-service=http  2>/dev/null || true
sudo firewall-cmd --permanent --add-service=https 2>/dev/null || true
sudo firewall-cmd --reload 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────
echo ""
pm2 status
echo ""
echo "=========================================================="
echo "  ✅ Deployment complete!"
echo "  App  : http://${SERVER_IP}"
echo "  API  : http://${SERVER_IP}/api"
echo "  Docs : http://${SERVER_IP}/api/docs"
echo "=========================================================="
