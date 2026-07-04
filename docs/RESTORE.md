# RESTORE — bringing Relay back from the vault (box-loss recovery)

Everything needed lives in the private repo **naoufac/relay-vault** + the **recovery key**
(64-hex string; on the box at /root/.backup-key AND held by the owner on Telegram).

## 1 · fetch the vault
    git clone https://github.com/naoufac/relay-vault.git && cd relay-vault
    cat manifest-latest.json        # confirm stamp + project count you expect

## 2 · decrypt (KEY = the recovery key string)
    echo "<KEY>" > /root/.backup-key && chmod 600 /root/.backup-key
    DOW=$(ls relay-*.dump.enc | sort | tail -1)   # or pick the weekday you want
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/root/.backup-key \
      -in relay-<dow>.dump.enc -out relay.dump
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/root/.backup-key \
      -in secrets-<dow>.tar.gz.enc -out secrets.tar.gz

## 3 · secrets back into place (keystore, envs, tunnel creds)
    tar -C / -xzf secrets.tar.gz
    # restores: /root/relay-android.keystore, /srv/relay/.env, /root/agency-pipeline/.env,
    #           /root/.cloudflared/*, /root/.bubblewrap/config.json

## 4 · database (Postgres 16; the ap-pg container listens on 5439)
    createdb -h 127.0.0.1 -p 5439 -U postgres relay   # or the name in DATABASE_URL
    pg_restore -h 127.0.0.1 -p 5439 -U postgres -d relay --clean --if-exists relay.dump

## 5 · code + services
    git clone https://github.com/naoufac/agency-pipeline-Relay.git /root/agency-pipeline
    /root/relay-deploy.sh          # builds /srv/relay, runs all suites, starts relay.service
    cp /root/agency-pipeline/deploy/systemd/relay-*.{service,timer} /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now relay-canary.timer relay-backup.timer
    cloudflared tunnel run relay &  # or install relay-tunnel.service (config restored in step 3)

## 6 · sites
    Produced pages are REGENERATED from the database: for each done project run
    `npx tsx src/cms/finalize-cli.ts <projectId>` (or simply let owners' next visits hit the
    live routes). APKs: `npm run apk -- <projectId>` — same keystore, same identity.

## Verify you're back
    curl https://board.naples.agency/           → 200
    psql "$DATABASE_URL" -c 'select count(*) from projects'  → matches manifest
    CANARY_INDEX=0 npx tsx src/canary.ts        → green flight end-to-end
