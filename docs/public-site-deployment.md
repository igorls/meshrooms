# Public site deployment

`website/` is the static entry page for **Meshrooms by WormDB** at
<https://meshrooms.wormdb.dev/>. It needs no build or application runtime.
The static directory contains no private invitations, credentials, or user data.
The [browser runtime](browser-deployment.md) separately serves /rooms, /r/,
/api/lobby, and its built assets through Nginx. The root WormDB site remains separate.

## Preview and verify

From the repository root:

```sh
python -m http.server 14322 --bind 127.0.0.1 --directory website
```

Check desktop and mobile rendering, keyboard focus, installation links, and the
copy button. Keep release/platform claims aligned with the published release.
The locally hosted Manrope font includes its upstream license in `assets/`.

## First HTTPS setup

Prerequisites: a Debian-style Nginx installation (1.25.1 or later for `http2 on`),
Certbot with an existing ACME account, and public ports 80/443. Add an A record
named `meshrooms` pointing to the host's public IPv4 address. Add no AAAA record
unless IPv6 HTTP/HTTPS is also reachable. Leave root and `www` records unchanged.

1. Create `/var/www/certbot` and install `deploy/nginx/meshrooms-http.conf` as
   `/etc/nginx/sites-available/meshrooms`. Link that file from `sites-enabled`.
   Check for an existing site before replacing anything.
2. Run `nginx -t`, then `systemctl reload nginx`. Confirm an HTTP challenge file
   is publicly reachable under `/.well-known/acme-challenge/`.
3. Obtain the certificate without changing other virtual hosts:

   ```sh
   certbot certonly --webroot --webroot-path /var/www/certbot \
     --cert-name meshrooms.wormdb.dev -d meshrooms.wormdb.dev \
     --non-interactive --keep-until-expiring
   ```

4. Publish the static release as described below, then replace the bootstrap
   vhost with `deploy/nginx/meshrooms.conf`. Validate and reload Nginx again.
5. Install `deploy/nginx/renew-meshrooms.sh` with mode 0755 in
   `/etc/letsencrypt/renewal-hooks/deploy/`. Confirm the Certbot renewal timer is
   active and run a scoped renewal rehearsal:

   ```sh
   certbot renew --cert-name meshrooms.wormdb.dev --dry-run
   ```

## Release and rollback

Package `website/` from a committed revision and record its SHA-256. Transfer
the archive over authenticated SSH, verify the hash on the host, then extract
it into a new `/var/www/meshrooms/releases/<git-sha>` directory. Give directories
0755 and files 0644 permissions; Nginx only needs read access. Never archive
the repository root or local runtime data.

Atomically replace `/var/www/meshrooms/current` with a symlink to that release.
Keep the previous target for rollback; repointing the symlink restores it.
Content-only updates do not require restarting Nginx or the MeshGuard relay.
Configuration changes require `nginx -t` before a graceful reload.

After deployment, verify normal certificate validation, HTTP-to-HTTPS redirect,
home page, stylesheet, script, font, SVG, and a missing path returning HTTP 404.
Confirm the deployed file hashes match the release and existing services retain
their pre-deployment state. Open the public page and test the copy action under
the deployed content policy.

References: [Nginx static routing](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files)
and [Certbot webroot certificates](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot).
