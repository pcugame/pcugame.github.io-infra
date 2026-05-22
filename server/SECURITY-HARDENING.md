# Production Security Hardening

These scripts apply the production host policy without changing the public SSH port.

## What Changes

- SSH on `5050/tcp` remains publicly reachable.
- SSH public key authentication remains enabled globally, so GitHub Actions key-based deploys continue to work.
- SSH password authentication is disabled globally and re-enabled only for KR, JP, and Tailscale `100.64.0.0/10`.
- Root SSH login is disabled and SSH users are restricted to `song gh-deploy` by default.
- The API pod binds `4000/tcp` to `127.0.0.1` by default in `deploy.sh`; public API traffic should go through nginx.
- fail2ban protects SSH, nftables rate-limits new SSH connections, and direct external access to `4000/tcp` and `rpcbind 111/tcp,udp` is blocked.

## Apply SSH Password Geo Policy

Keep your current SSH session open and test with a second session before logging out.

```bash
cd /srv/graduationproject_v2
sudo SSH_ALLOW_USERS="song gh-deploy" bash hardening/install-ssh-password-geo.sh
```

The script fetches aggregated KR/JP IPv4 CIDRs from IPdeny and writes:

```text
/etc/ssh/sshd_config.d/99-password-geo.conf
```

The filename intentionally sorts late because sshd `Match` blocks apply until the next `Match` or end of config parsing.

Preview without writing:

```bash
bash hardening/install-ssh-password-geo.sh --dry-run
```

Verify effective sshd policy:

```bash
sudo sshd -t
sudo sshd -T -C user=song,addr=203.250.133.230,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
sudo sshd -T -C user=song,addr=133.242.0.1,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
sudo sshd -T -C user=song,addr=8.8.8.8,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
sudo sshd -T -C user=song,addr=100.64.0.1,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
```

Expected:

- KR/JP/Tailscale: `passwordauthentication yes`
- US or GitHub Actions style address: `passwordauthentication no`
- All addresses: `pubkeyauthentication yes`

## Apply fail2ban and nftables

```bash
cd /srv/graduationproject_v2
sudo bash hardening/install-network-hardening.sh --install-packages
```

If the public interface should be explicit:

```bash
sudo PUBLIC_IFACE=eth0 bash hardening/install-network-hardening.sh --install-packages
```

## Redeploy API With Loopback Binding

The deploy script now defaults to `127.0.0.1:4000:4000`.

```bash
cd /srv/graduationproject_v2
./deploy.sh up
```

If you need to override it temporarily:

```bash
API_BIND_HOST=0.0.0.0 ./deploy.sh up
```

## Final Checks

```bash
curl -fsS https://203.250.133.230/api/health
curl -fsS http://127.0.0.1:4000/api/health
systemctl status ssh nginx fail2ban nftables
fail2ban-client status sshd
nft list table inet pcu_hardening
ss -tulpen | grep -E ':(5050|4000|111)\b'
```

External direct access to `:4000` should fail after redeploy and firewall application; `https://203.250.133.230/api/health` should continue to work through nginx.

## Nginx Security Upgrade Runbook

Use this when an Nginx CVE affects the reverse proxy. For CVE-2026-42945, Debian 13
backports the fix in `nginx` / `nginx-common` `1.26.3-3+deb13u5`; prefer that
package over switching to the upstream nginx.org repository unless Debian has no
patched candidate.

```bash
sudo tar -C / -czf "/root/nginx-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).tgz" etc/nginx

apt-cache policy nginx nginx-common
apt changelog nginx | grep -Ei 'CVE-2026-42945|rewrite|security' | head -n 40

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade nginx nginx-common

sudo nginx -t
sudo systemctl reload nginx || sudo systemctl restart nginx
```

Verify after the upgrade:

```bash
dpkg -l nginx nginx-common
sudo nginx -v
systemctl is-active nginx
curl -fsS http://127.0.0.1:4000/api/health
curl -kfsS https://203.250.133.230/api/health
sudo ss -tulpen | grep -E ':(443|80|4000|5050)\b'
curl -fsS --connect-timeout 5 http://203.250.133.230:4000/api/health || echo "direct :4000 blocked"
```

Expected:

- `nginx` and `nginx-common` are on the patched Debian security version.
- `nginx -t` succeeds and `nginx` remains `active`.
- API health passes through both loopback and the public HTTPS reverse proxy.
- `:4000` listens only on `127.0.0.1` and public direct access to `:4000` fails.
