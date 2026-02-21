#!/usr/bin/env node

// Cache warming / smoke test script.
//
// Strategy: recent data first across ALL communities, then work backwards.
// This ensures the most-requested data is warm as quickly as possible.
//
// Usage:
//   CI (forge admin session via SECRET_KEY):
//     SECRET_KEY=ci-test-secret node scripts/warm-caches.js --quick
//
//   Production (authenticate with real credentials):
//     BASE_URL=https://accounting.encointer.org \
//     AUTH_ADDRESS=... AUTH_PASSWORD=... \
//     node scripts/warm-caches.js
//
// Exits 0 if all attempted endpoints succeed, 1 otherwise.

import crypto from "crypto";
import * as dotenv from "dotenv";
dotenv.config();

const BASE_URL = process.env.BASE_URL || "http://localhost:8081";
const QUICK = process.argv.includes("--quick");
const SECRET_KEY = process.env.SECRET_KEY;
const AUTH_ADDRESS = process.env.AUTH_ADDRESS;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

const SAMPLE_ACCOUNT = "DGeoBv3E9xniabhyWsSjd25Te8ZmjQ7zndc2VVbmU8zmZQB";
const TREASURY_CIDS = new Set(["u0qj944rhWE", "kygch5kVGq7", "s1vrqQL2SD"]);
const START_YEAR = 2022;

let passed = 0;
let failed = 0;
let sessionCookie = null;

// Forge a cookie-session cookie signed with SECRET_KEY (same as the server uses).
function forgeSessionCookie(sessionData) {
    const value = Buffer.from(JSON.stringify(sessionData)).toString("base64");
    const sig = crypto
        .createHmac("sha1", SECRET_KEY)
        .update("session=" + value)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `session=${value}; session.sig=${sig}`;
}

async function authenticate() {
    // Prefer forging a cookie when we know the secret (CI)
    if (SECRET_KEY) {
        sessionCookie = forgeSessionCookie({
            isReadonlyAdmin: true,
            isAdmin: false,
            address: SAMPLE_ACCOUNT,
            name: "cache-warmer",
        });
        console.log("  pass  forged readonlyAdmin session via SECRET_KEY");
        return true;
    }
    // Otherwise authenticate against the running server (production)
    if (!AUTH_ADDRESS || !AUTH_PASSWORD) return false;
    try {
        const res = await fetch(`${BASE_URL}/v1/auth/authenticate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: AUTH_ADDRESS, password: AUTH_PASSWORD }),
            redirect: "manual",
        });
        if (!res.ok) {
            console.log(`  FAIL  authenticate -> HTTP ${res.status}`);
            return false;
        }
        const setCookie = res.headers.getSetCookie?.() || [];
        sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
        const user = await res.json();
        console.log(`  pass  authenticated as ${user.name}`);
        return true;
    } catch (e) {
        console.log(`  FAIL  authenticate -> ${e.message}`);
        return false;
    }
}

async function hit(label, path, timeoutMs = 120_000) {
    const url = `${BASE_URL}${path}`;
    const headers = {};
    if (sessionCookie) headers["Cookie"] = sessionCookie;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal, headers });
        clearTimeout(timer);
        if (res.ok) {
            const body = await res.text();
            console.log(`  pass  ${label} (${body.length} bytes)`);
            passed++;
            return body;
        }
        console.log(`  FAIL  ${label} -> HTTP ${res.status}`);
        failed++;
        return null;
    } catch (e) {
        console.log(`  FAIL  ${label} -> ${e.message}`);
        failed++;
        return null;
    }
}

async function main() {
    console.log(`Target: ${BASE_URL}`);
    console.log(`Mode:   ${QUICK ? "quick" : "full"}\n`);

    const authed = await authenticate();
    if (!authed) {
        console.log("Warning: no auth, skipping protected endpoints.\n");
    }

    // ── communities ────────────────────────────────────────────────────
    let communities;
    try {
        const res = await fetch(`${BASE_URL}/v1/communities/all-communities`);
        communities = await res.json();
        console.log(
            `  pass  all-communities (${communities.length} communities)`
        );
        passed++;
    } catch (e) {
        console.log(`  FAIL  all-communities -> ${e.message}`);
        console.log("\nCannot fetch communities, aborting.");
        process.exit(1);
    }

    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const currentYear = new Date().getUTCFullYear();
    // Years in reverse order: current year first, then backwards
    const years = QUICK
        ? [currentYear]
        : Array.from({ length: currentYear - START_YEAR + 1 }, (_, i) => currentYear - i);

    // ── Phase 1: DB-only endpoints, recent first ─────────────────────
    // Iterate years (recent first), all communities per year
    if (authed) {
        for (const y of years) {
            console.log(`\n── Year ${y} ──`);
            for (const { cid, name } of communities) {
                console.log(`  [${name} / ${cid}]`);
                await hit(`volume-report ${y}`, `/v1/accounting/volume-report?cid=${cid}&year=${y}`);
                await hit(`transaction-activity ${y}`, `/v1/accounting/transaction-activity?cid=${cid}&year=${y}`);
            }
        }
    }

    // ── Phase 2: circularity + community-flow (all communities) ──────
    if (authed) {
        console.log(`\n── Circularity & community flow ──`);
        for (const { cid, name } of communities) {
            console.log(`  [${name} / ${cid}]`);
            // Circularity computes all months internally, recent months benefit from
            // communityFlow cache populated above
            await hit(`circularity`, `/v1/accounting/circularity?cid=${cid}`, 600_000);
            // Community flow for last 3 months (default page load)
            const m = new Date().getUTCMonth();
            const sm = m >= 2 ? m - 2 : m + 10;
            const sy = m >= 2 ? currentYear : currentYear - 1;
            await hit(
                `community-flow range (recent)`,
                `/v1/accounting/community-flow?cid=${cid}&startYear=${sy}&startMonth=${sm}&endYear=${currentYear}&endMonth=${m}`,
                300_000
            );
        }
    }

    // ── Phase 3: treasury logs ────────────────────────────────────────
    for (const { cid, name } of communities) {
        if (TREASURY_CIDS.has(cid)) {
            console.log(`\n  [${name} / ${cid}] treasury`);
            await hit(
                "community-treasury-log",
                `/v1/accounting/community-treasury-log?cid=${cid}&start=${oneYearAgo}&end=${now}`
            );
        }
    }

    if (QUICK) {
        printSummary();
        return;
    }

    // ── Phase 4: RPC-heavy endpoints (all communities) ───────────────
    for (const { cid, name } of communities) {
        console.log(`\n[${name} / ${cid}] RPC-heavy`);
        await hit("rewards-data", `/v1/accounting/rewards-data?cid=${cid}`, 600_000);

        if (!authed) continue;

        // all-accounts-data must run before money-velocity (populates account_data cache)
        // Recent years first
        for (const y of years) {
            await hit(
                `all-accounts-data ${y}`,
                `/v1/accounting/all-accounts-data?cid=${cid}&year=${y}`,
                600_000
            );
        }
        for (const y of years) {
            await hit(
                `money-velocity ${y}`,
                `/v1/accounting/money-velocity-report?cid=${cid}&year=${y}`,
                600_000
            );
        }
        await hit("reputables-by-cindex", `/v1/accounting/reputables-by-cindex?cid=${cid}`, 600_000);
        await hit("frequency-of-attendance", `/v1/accounting/frequency-of-attendance?cid=${cid}`, 600_000);
    }

    // ── Phase 5: faucet ──────────────────────────────────────────────
    if (authed) {
        console.log("\n[faucet]");
        await hit("faucet-drips", "/v1/faucet/drips");
    }

    // ── Phase 6: account-specific endpoints (sample account, Leu) ────
    console.log("\n[account-specific / sample]");
    await hit(
        "transaction-log",
        `/v1/accounting/transaction-log?cid=u0qj944rhWE&start=${oneYearAgo}&end=${now}&account=${SAMPLE_ACCOUNT}`
    );
    await hit(
        "native-transaction-log",
        `/v1/accounting/native-transaction-log?start=${oneYearAgo}&end=${now}&account=${SAMPLE_ACCOUNT}`
    );

    if (authed) {
        await hit(
            "account-overview",
            `/v1/accounting/account-overview?cid=u0qj944rhWE&timestamp=${now}`,
            300_000
        );
        await hit(
            "sankey-report",
            `/v1/accounting/sankey-report?cid=u0qj944rhWE&start=${oneYearAgo}&end=${now}&account=${SAMPLE_ACCOUNT}`,
            300_000
        );
    }

    printSummary();
}

function printSummary() {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log("=".repeat(50));
    process.exit(failed > 0 ? 1 : 0);
}

main();
