#!/bin/sh
# Strict TLS in a disposable browser container. Requires built API/contracts.
# No user/system trust store or production service is modified.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
docker run --rm --network host \
 --add-host runtime.pcu.example.com:127.0.0.1 \
 --add-host region.approved.pcu.example.com:127.0.0.1 \
 --add-host game.approved.pcu.example.com:127.0.0.1 \
 --add-host approved.pcu.example.com:127.0.0.1 \
 --add-host blocked.pcu.example.com:127.0.0.1 \
 --add-host api.pcu.example.com:127.0.0.1 \
 -v "$root:/workspace:ro" -w /workspace \
 mcr.microsoft.com/playwright:v1.58.2-noble bash -euc '
 apt-get update -qq
 apt-get install -y -qq libnss3-tools >/dev/null
 mkdir -p /tmp/pcu-driver /tmp/pcu-tls /root/.pki/nssdb
 npm install --prefix /tmp/pcu-driver --no-audit --no-fund playwright@1.58.2 ws@8 >/dev/null
 openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pcu-browser-fixture-ca \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout /tmp/pcu-tls/ca.key -out /tmp/pcu-tls/ca.pem 2>/dev/null
 openssl req -new -newkey rsa:2048 -nodes -subj /CN=runtime.pcu.example.com \
  -keyout /tmp/pcu-tls/key.pem -out /tmp/pcu-tls/server.csr 2>/dev/null
 printf "%s\n" "basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature,keyEncipherment" "extendedKeyUsage=serverAuth" \
  "subjectAltName=DNS:runtime.pcu.example.com,DNS:region.approved.pcu.example.com,DNS:game.approved.pcu.example.com,DNS:approved.pcu.example.com,DNS:blocked.pcu.example.com,DNS:api.pcu.example.com" > /tmp/pcu-tls/extensions
 openssl x509 -req -in /tmp/pcu-tls/server.csr -CA /tmp/pcu-tls/ca.pem -CAkey /tmp/pcu-tls/ca.key -CAcreateserial \
  -days 1 -extfile /tmp/pcu-tls/extensions -out /tmp/pcu-tls/cert.pem 2>/dev/null
 cp /tmp/pcu-tls/ca.pem /usr/local/share/ca-certificates/pcu-fixture.crt
 update-ca-certificates >/dev/null
 certutil -N --empty-password -d sql:/root/.pki/nssdb
 certutil -A -d sql:/root/.pki/nssdb -n pcu-fixture -t "C,," -i /tmp/pcu-tls/ca.pem
 export PLAYWRIGHT_MODULE_PATH=/tmp/pcu-driver/node_modules/playwright/index.mjs
 export WS_MODULE_PATH=/tmp/pcu-driver/node_modules/ws
 export BROWSER_TLS_CA_PATH=/tmp/pcu-tls/ca.pem
 export BROWSER_TLS_CERT_PATH=/tmp/pcu-tls/cert.pem BROWSER_TLS_KEY_PATH=/tmp/pcu-tls/key.pem
 for engine in "$@"; do
  PLAYWRIGHT_BROWSER="$engine" node scripts/webgl-network-browser.mjs
 done
 ' -- "${@:-chromium}"
