# PrestaShop Local Setup

One-command recipe to run a local PrestaShop container that the Relay PrestaShop builder
(`src/cms/prestashop.ts`) can provision against for PROVE-mode tests and local development.

## Quick start

```bash
docker run -d \
  --name relay-presta \
  -p 8069:80 \
  -e DB_SERVER=db \
  -e DB_NAME=prestashop \
  -e DB_USER=ps \
  -e DB_PASSWD=ps \
  -e PS_DOMAIN=localhost:8069 \
  -e PS_FOLDER_ADMIN=admin \
  -e PS_ENABLE_SSL=0 \
  -e ADMIN_MAIL=admin@relay.local \
  -e ADMIN_PASSWD=Relay12345! \
  prestashop/prestashop:8-apache
```

This pulls the official PrestaShop 8.x Apache image.  The first startup takes 2-4 minutes
(database install runs automatically).  Poll `http://localhost:8069/api/` until it returns
HTTP 200.

### Wait for readiness

```bash
until curl -s -o /dev/null -w "%{http_code}" http://localhost:8069/api/ | grep -q 200; do
  echo "waiting for PrestaShop…"; sleep 5
done
echo "PrestaShop ready"
```

## Create a Webservice API key

1. Browse to `http://localhost:8069/admin` and log in with `admin@relay.local` / `Relay12345!`.
2. Go to **Advanced Parameters → Webservice**.
3. Enable webservice: toggle **Enable PrestaShop webservice** → Save.
4. Click **Add new key**.
5. Set permissions: tick all resources (or at minimum: `categories`, `products`, `images`).
6. Copy the generated 32-char key.

## Environment variables

Add to your `.env` (or export in shell) before running PROVE-mode checks:

```
RELAY_PRESTA_URL=http://localhost:8069
RELAY_PRESTA_KEY=<your-32-char-key>
```

`RELAY_PRESTA=1` is set automatically by the `presta:prove` npm script.

## Run the PROVE-mode gate

```bash
npm run presta:prove
```

This runs `src/prestashop-check.ts` with `RELAY_PRESTA=1`.  It:

1. Probes the endpoint for liveness.
2. Asserts a French (`fr`) language ID is returned by `/api/languages`.
3. Creates a scratch category + product with `id_currency=1` (EUR).
4. Attempts an image attachment round-trip via `/api/images/products/{id}`.
5. Deletes the scratch resources (teardown).
6. Exits 0 on pass; exits 1 on failure.

If the endpoint is unreachable the suite exits 0 with a `SKIP` message — no infra, no failure.

## Teardown

```bash
docker stop relay-presta && docker rm relay-presta
```

## Notes

- The default PrestaShop 8.x install sets **EUR as currency id 1** and **French as language id 1**
  when the install locale is `fr-FR`.  The Relay builder relies on this convention and falls back
  gracefully if the IDs differ.
- The Relay builder never stores the raw API key in logs or DB params — only the env var name
  `RELAY_PRESTA_KEY` is referenced in source.
- The `RELAY_PRESTA=1` feature flag is the only switch needed to activate live provisioning.
  Without it the builder records intent in `params.presta_provision` (STUB mode) and returns
  `ok:true` immediately so the static Directus build stands.
