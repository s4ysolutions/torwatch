# Ansible deployment for torwatch

Deploys `torwatchd` (Go torrent-video streaming, port 8765) + static frontend
to the `torwatch` host group.

Split: this repo holds portable deploy logic only (`roles/torwatch`: task
list, package names, templates). Real target + secrets live in
`~/s4y/oci/ansible`: inventory (`torwatch-prod` = vps1), ssh user/key, and
vault file `host_vars/torwatch-prod/vault.yml` with `vault_opensubs_key`
(optional — empty default disables OpenSubtitles). Run the deploy from there
(`playbooks/torwatch.yml`).

## What the role does

1. **base** — disable broken `pgdg13` repo (vps1), install nginx, open
   http/https firewall ports, allow nginx proxying (SELinux).
2. **app** — cross-build `dist/` locally via `deploy/build-arm64.sh`
   (needs Go on the control machine), copy binary + `static/` to
   `/usr/local/opt/torwatch`, write `/etc/torwatch/env`.
3. **service** — install + start `torwatch.service`
   (`-addr 127.0.0.1:8765 -ttl 24h -max-disk 20GB`).
4. **nginx** — render HTTP-only vhost for `torwatch.s4y.solutions`
   (skipped once a cert exists, so certbot's 443 block survives),
   `nginx -t`, start nginx.

TLS provisioning is the caller's job (shared OCI `tasks/certbot-ol9.yml`).

## Direct run (example inventory only)

```bash
cd ansible
cp inventory/hosts.yml.example inventory/hosts.yml  # gitignored; fill in
ansible-playbook playbooks/deploy-torwatch.yml
```

## Production run

```bash
cd ~/s4y/oci/ansible
ansible-playbook playbooks/torwatch.yml
```
