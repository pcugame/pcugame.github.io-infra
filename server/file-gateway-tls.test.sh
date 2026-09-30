#!/bin/sh
# Isolated real nginx 1.27 TLS/auth_request regression; requires Docker + OpenSSL.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
name=pcu-gateway-tls-test-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || :; rm -rf "$work"; }
trap cleanup EXIT INT TERM
sh "$root/server/prepare-file-gateway-tls.sh" "$work/identity" >/dev/null
chmod 755 "$work" "$work/identity"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pcu-file-auth.internal \
 -addext subjectAltName=DNS:pcu-file-auth.internal -keyout "$work/wrong.key" -out "$work/wrong.pem" >/dev/null 2>&1
# Extract the production auth location, not a substitute implementation.
ROOT="$root" WORK="$work" node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const root=process.env.ROOT, work=process.env.WORK;
let config='events {} http { access_log off; error_log /dev/null crit;\n';
config+='server { listen 8443 ssl; ssl_certificate /fixture/identity/trust.pem; ssl_certificate_key /fixture/identity/server.key; location / { return 204; } }\n';
config+='server { listen 8445 ssl; ssl_certificate /fixture/wrong.pem; ssl_certificate_key /fixture/wrong.key; location / { return 204; } }\n';
config+='server { listen 8444; location / { return 200 "authorized"; } }\n';
let port=8080;
for(const file of ['public-origin','protected-download']) {
 const template=readFileSync(`${root}/apps/db/${file}.nginx.conf.template`,'utf8');
 for(const [upstream,tlsName] of [['8443','pcu-file-auth.internal'],['8443','wrong.internal'],['8445','pcu-file-auth.internal']]) {
  const id=port++;
  const replace=s=>s.replaceAll('${FILE_GATEWAY_TLS_SERVER_NAME}',tlsName)
   .replaceAll('$pcu_gate_tls_name',`$tls_${id}`)
   .replaceAll('${FILE_GATEWAY_API_UPSTREAM}',`https://127.0.0.1:${upstream}`)
   .replaceAll('${FILE_GATEWAY_SECRET}','fixture-secret-at-least-32-characters')
   .replaceAll('/etc/ssl/certs/ca-certificates.crt','/fixture/identity/trust.pem');
  config+=replace(template.match(/^map[\s\S]*?\n\}/)[0])+'\n';
  config+=`server { listen ${id}; set $pcu_file_method GET; `+replace(template.match(/location = \/__pcu_file_auth \{[\s\S]*?\n  \}/)[0]);
  config+=' location / { auth_request /__pcu_file_auth; proxy_pass http://127.0.0.1:8444; } }\n';
 }
}
config+='}';writeFileSync(`${work}/nginx.conf`,config);
JS
docker run --rm -d --name "$name" -v "$work:/fixture:ro" \
 -v "$work/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine >/dev/null
i=0
until docker exec "$name" nginx -t >/dev/null 2>&1; do
 i=$((i + 1)); [ "$i" -lt 20 ] || exit 1; sleep 1
done
for port in 8080 8083; do
 result=$(docker exec "$name" wget -qO- "http://127.0.0.1:$port/")
 [ "$result" = authorized ] || { echo 'Trusted TLS failed' >&2; exit 1; }
done
for port in 8081 8082 8084 8085; do
 result=$(docker exec "$name" wget -S -O /dev/null "http://127.0.0.1:$port/" 2>&1 || :)
 printf '%s' "$result" | grep -q 'HTTP/1.1 500' || { echo 'Invalid TLS did not fail closed' >&2; exit 1; }
done
echo 'Both gateway templates: trusted TLS succeeds; hostname mismatch and untrusted certificate fail closed.'
