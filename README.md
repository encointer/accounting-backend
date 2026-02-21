# Encointer Accounting Backend

Offers APIs to query indexed chain state

```
npm install
node index.js
curl "127.0.0.1:8081/v1/accounting/transaction-log?cid=u0qj944rhWE&start=1670000000000&end=1776250900000&account=DGeoBv3E9xniabhyWsSjd25Te8ZmjQ7zndc2VVbmU8zmZQB" > transaction-log.json
```

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | yes | — | HMAC secret for cookie-session signing |
| `DB_URL` | yes | — | MongoDB connection string |
| `ENCOINTER_RPC` | no | `wss://kusama.api.encointer.org` | Polkadot RPC endpoint |
| `INDEXER_ENDPOINT` | no | `http://localhost:3000` | Indexer API URL |

## Warming Caches

Many endpoints (accounting data, rewards, volume reports) cache their results in MongoDB once the underlying data is immutable (past months, past ceremony indices). First requests for uncached data are slow (minutes for RPC-heavy endpoints). The `warm-caches` script pre-populates these caches and doubles as a smoke test.

### Local / CI (forge session via SECRET_KEY)

```bash
source .env
SECRET_KEY=$SECRET_KEY node scripts/warm-caches.js --quick
```

`--quick` only tests the current year and skips RPC-heavy endpoints. Good for CI and verifying the server is healthy.

### Full warm-up (all years, all endpoints)

```bash
source .env
SECRET_KEY=$SECRET_KEY node scripts/warm-caches.js
```

This hits every community × every year since 2022, including rewards-data, money-velocity, all-accounts-data, and sankey reports. On a cold cache this can take hours — individual RPC-heavy endpoints may need up to 10 minutes each, and `money-velocity` depends on `all-accounts-data` being cached first. Some 500s on a cold run are expected; run it again after the first pass to fill remaining caches.

### Production (authenticate against running server)

If you don't have the `SECRET_KEY` but have user credentials:

```bash
BASE_URL=https://accounting.encointer.org \
AUTH_ADDRESS=<your-address> AUTH_PASSWORD=<your-password> \
node scripts/warm-caches.js
```

### Purging caches

Drop all cached data from MongoDB (account_data, rewards_data, general_cache):

```bash
source .env
node scripts/purge-caches.js
```

### npm scripts

```bash
npm test             # same as warm-caches --quick
npm run warm-caches  # full warm-up
npm run purge-caches # drop all caches
```

