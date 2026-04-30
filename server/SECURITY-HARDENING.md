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
