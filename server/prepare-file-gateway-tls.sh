#!/bin/sh
# Prepare a versioned TLS identity; never installs/reloads nginx automatically.
set -eu
umask 077
out=${1:?Usage: prepare-file-gateway-tls.sh /absolute/new-directory}
case "$out" in /*) ;; *) echo 'Directory must be absolute' >&2; exit 1;; esac
case "$out" in *[!a-zA-Z0-9_./-]*) echo 'Unsafe directory characters' >&2; exit 1;; esac
[ ! -e "$out" ] || { echo 'Refusing to overwrite an existing identity' >&2; exit 1; }
mkdir -m 700 "$out"
# A pinned self-signed server identity avoids retaining a signing CA key.
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
  -subj /CN=pcu-file-auth.internal \
  -addext subjectAltName=DNS:pcu-file-auth.internal \
  -addext basicConstraints=critical,CA:FALSE \
  -addext keyUsage=critical,digitalSignature,keyEncipherment \
  -addext extendedKeyUsage=serverAuth \
  -keyout "$out/server.key" -out "$out/trust.pem" 2>/dev/null
chmod 600 "$out/server.key"
chmod 644 "$out/trust.pem"
openssl verify -CAfile "$out/trust.pem" -verify_hostname pcu-file-auth.internal "$out/trust.pem"
cat > "$out/zz-pcu-file-auth" <<CONFIG
# Add after api-proxy; do not change the existing default/public server.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name pcu-file-auth.internal;
    ssl_certificate $out/trust.pem;
    ssl_certificate_key $out/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    error_log /dev/null crit;
    client_max_body_size 1k;
    location = /api/internal/file-access {
        allow 203.250.133.232;
        allow 127.0.0.1;
        allow ::1;
        deny all;
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host pcu-file-auth.internal;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_connect_timeout 3s;
        proxy_read_timeout 5s;
        proxy_next_upstream off;
    }
    location / { return 404; }
}
CONFIG
printf 'Prepared identity and candidate vhost in %s\n' "$out"
openssl x509 -in "$out/trust.pem" -noout -fingerprint -sha256 -enddate
