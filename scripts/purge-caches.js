#!/usr/bin/env node

// Purge all MongoDB caches used by the accounting backend.
//
// Usage:
//   source .env
//   node scripts/purge-caches.js

import { MongoClient } from "mongodb";
import * as dotenv from "dotenv";
dotenv.config();

const DB_URL = process.env.DB_URL;
if (!DB_URL) {
    console.error("DB_URL env var must be set");
    process.exit(1);
}

const CACHE_DB = "encointer-kusama-accounting-backend-cache";
const COLLECTIONS = ["account_data", "rewards_data", "general_cache"];

const client = new MongoClient(DB_URL, { ssl: true, sslValidate: true });
try {
    await client.connect();
    const db = client.db(CACHE_DB);
    for (const name of COLLECTIONS) {
        const { deletedCount } = await db.collection(name).deleteMany({});
        console.log(`${name}: deleted ${deletedCount} documents`);
    }
} finally {
    await client.close();
}
