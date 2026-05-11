import express from "express";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import db from "../db.js";
import { getAllTreasuries } from "../treasuryConfig.js";

const KSM_SS58_PREFIX = 2;
const USDC_GENERAL_INDEX = "1,337";
const USDC_DECIMALS = 6;
const KSM_DECIMALS = 12;
// Bridge fees on small amounts can take up to ~19% of the sent amount; the
// remaining 6% buffer absorbs variability between Polkadot/Kusama bridge hops.
const BRIDGE_FEE_TOLERANCE_PCT = 25n;
// Bridge end-to-end delivery time observed in the indexer ranges up to ~11 min;
// 30 min covers congestion and gives a generous match window.
const BRIDGE_DELIVERY_WINDOW_MS = 30 * 60 * 1000;
// Bump when matching/attribution logic changes; old caches are invalidated.
const CACHE_VERSION = 1;

const leaderboard = express.Router();

const stripCommas = (s) =>
    s == null ? null : String(s).replace(/,/g, "");
const toBigInt = (s) => (s == null ? 0n : BigInt(stripCommas(s) ?? "0"));

/** Re-encode an AccountId32 hex (0x...) to Kusama-prefix ss58. */
function hexToKsmSs58(hex) {
    if (typeof hex !== "string") return null;
    try {
        return encodeAddress(hex, KSM_SS58_PREFIX);
    } catch {
        return null;
    }
}

/** Canonicalise any ss58 to Kusama prefix (2) so the same public key
 *  collapses into a single donor row regardless of input encoding. */
function toCanonicalSs58(ss58) {
    if (typeof ss58 !== "string") return ss58;
    try {
        return encodeAddress(decodeAddress(ss58), KSM_SS58_PREFIX);
    } catch {
        return ss58;
    }
}

/** True if a `transferAssetsUsingTypeAndThen` args object targets the Kusama
 *  ecosystem (parents:2, X2[GlobalConsensus(Kusama), Parachain(_)]). */
function isKusamaBound(args) {
    const dest = args?.dest?.V5 || args?.dest?.V4;
    const gc = dest?.interior?.X2?.[0]?.GlobalConsensus;
    if (gc === "Kusama") return true;
    if (gc && typeof gc === "object" && "Kusama" in gc) return true;
    return false;
}

/** Yield every `polkadotXcm.transferAssetsUsingTypeAndThen`-like call args
 *  found in an extrinsic. The dapp wraps cross-chain donations in
 *  `utility.batchAll` (to pre-swap USDC→DOT for bridge fees). */
function extractTutCalls(extrinsic) {
    if (
        extrinsic.section === "polkadotXcm" &&
        extrinsic.method === "transferAssetsUsingTypeAndThen"
    ) {
        return [extrinsic.args];
    }
    if (
        extrinsic.section === "utility" &&
        (extrinsic.method === "batch" ||
            extrinsic.method === "batchAll" ||
            extrinsic.method === "forceBatch")
    ) {
        const calls = extrinsic.args?.calls;
        if (!Array.isArray(calls)) return [];
        return calls
            .filter(
                (c) =>
                    c?.section === "polkadotXcm" &&
                    c?.method === "transferAssetsUsingTypeAndThen",
            )
            .map((c) => c.args);
    }
    return [];
}

/** Attribute a cross-chain KAH `foreignAssets.Deposited` event to the source
 *  PAH extrinsic's signer. Supports `polkadotXcm.transferAssetsUsingTypeAndThen`
 *  directly AND `utility.batch*`-wrapped variants. Both `Definite` and `Wild`
 *  deposits are matched. */
async function findCrossChainDonor(dep) {
    const t = dep.timestamp;
    const depAmount = toBigInt(dep.data?.amount);
    const candidates = await db.indexerAssetHubPolkadot
        .collection("extrinsics")
        .find({
            success: true,
            timestamp: { $gte: t - BRIDGE_DELIVERY_WINDOW_MS, $lte: t + 60_000 },
            $or: [
                {
                    section: "polkadotXcm",
                    method: "transferAssetsUsingTypeAndThen",
                },
                {
                    section: "utility",
                    method: { $in: ["batch", "batchAll", "forceBatch"] },
                    "args.calls.section": "polkadotXcm",
                    "args.calls.method": "transferAssetsUsingTypeAndThen",
                },
            ],
        })
        .toArray();

    const treasuryKahSs58 = dep.data?.who;
    for (const x of candidates) {
        const inner = extractTutCalls(x);
        for (const args of inner) {
            if (!isKusamaBound(args)) continue;
            const totalAssets =
                args?.assets?.V5 || args?.assets?.V4 || [];
            const totalSrcAmt = totalAssets.reduce((acc, a) => {
                const f = a?.fun?.Fungible;
                return f == null ? acc : acc + toBigInt(f);
            }, 0n);

            const xcm =
                args?.custom_xcm_on_dest?.V5 ||
                args?.custom_xcm_on_dest?.V4;
            if (!Array.isArray(xcm)) continue;
            for (const ins of xcm) {
                const dep2 = ins?.DepositAsset;
                if (!dep2) continue;
                const benHex =
                    dep2.beneficiary?.interior?.X1?.[0]?.AccountId32?.id;
                const benSs58 = hexToKsmSs58(benHex);
                if (benSs58 !== treasuryKahSs58) continue;

                const definite = dep2.assets?.Definite;
                if (Array.isArray(definite)) {
                    for (const a of definite) {
                        const fung = a?.fun?.Fungible;
                        if (fung == null) continue;
                        const srcAmt = toBigInt(fung);
                        const slack =
                            (srcAmt * BRIDGE_FEE_TOLERANCE_PCT) / 100n;
                        if (
                            srcAmt >= depAmount &&
                            srcAmt - depAmount <= slack
                        ) {
                            return x.signer?.Id ?? null;
                        }
                    }
                }

                if (dep2.assets?.Wild && totalSrcAmt >= depAmount) {
                    return x.signer?.Id ?? null;
                }
            }
        }
    }
    return null;
}

// ─── Incremental cache ─────────────────────────────────────────────────────
// State shape per token:
//   {
//     version: number,
//     cursorBlock: number,              // max blockNumber processed
//     donors: { [ss58]: { count, totalRaw: string } },
//     crossChainUnidentified: [{ timestamp, amountRaw }],
//     totalOutflowsRaw: string
//   }
// Total inflow is recomputed at response time from donors + unidentified.

function emptyState() {
    return {
        version: CACHE_VERSION,
        cursorBlock: 0,
        donors: {},
        crossChainUnidentified: [],
        totalOutflowsRaw: "0",
    };
}

async function loadState(token) {
    const rows = await db.getFromGeneralCache("leaderboard", { token });
    if (rows.length === 0) return emptyState();
    const s = rows[0];
    if (!s || s.version !== CACHE_VERSION) return emptyState();
    return s;
}

async function saveState(token, state) {
    await db.insertIntoGeneralCache("leaderboard", { token }, state);
}

function addDonor(donors, ss58, amount) {
    const key = toCanonicalSs58(ss58);
    const cur = donors[key] ?? { count: 0, totalRaw: "0" };
    donors[key] = {
        count: cur.count + 1,
        totalRaw: (BigInt(cur.totalRaw) + amount).toString(),
    };
}

function renderState(state, token, decimals) {
    const donors = Object.entries(state.donors)
        .map(([ss58, v]) => ({
            ss58,
            count: v.count,
            totalRaw: v.totalRaw,
        }))
        .sort((a, b) => {
            const d = BigInt(b.totalRaw) - BigInt(a.totalRaw);
            return d > 0n ? 1 : d < 0n ? -1 : 0;
        });
    const totalInflows =
        donors.reduce((s, d) => s + BigInt(d.totalRaw), 0n) +
        state.crossChainUnidentified.reduce(
            (s, a) => s + BigInt(a.amountRaw),
            0n,
        );
    return {
        token,
        decimals,
        totalInflowsRaw: totalInflows.toString(),
        totalOutflowsRaw: state.totalOutflowsRaw,
        donors,
        crossChainUnidentified: state.crossChainUnidentified,
    };
}

// ─── USDC across treasuries (KAH) ───────────────────────────────────────────

async function buildUsdcLeaderboard() {
    const state = await loadState("USDC");
    const treasuries = getAllTreasuries();
    const kahAccounts = treasuries.map((t) => t.kahAccount);
    const kahSet = new Set(kahAccounts);

    const newEvents = await db.indexerAssetHub
        .collection("events")
        .find({
            section: "foreignAssets",
            "data.assetId.interior.X4.3.GeneralIndex": USDC_GENERAL_INDEX,
            blockNumber: { $gt: state.cursorBlock },
            $or: [
                { method: "Transferred", "data.to": { $in: kahAccounts } },
                { method: "Transferred", "data.from": { $in: kahAccounts } },
                { method: "Deposited", "data.who": { $in: kahAccounts } },
                { method: "Withdrawn", "data.who": { $in: kahAccounts } },
                { method: "Burned", "data.owner": { $in: kahAccounts } },
            ],
        })
        .sort({ blockNumber: 1 })
        .toArray();

    let maxBlock = state.cursorBlock;
    const donors = { ...state.donors };
    const unident = [...state.crossChainUnidentified];
    let outflows = BigInt(state.totalOutflowsRaw || "0");

    for (const e of newEvents) {
        if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
        const amt = toBigInt(e.data?.amount);
        const m = e.method;
        if (m === "Transferred") {
            if (kahSet.has(e.data?.to)) {
                addDonor(donors, e.data?.from, amt);
            } else if (kahSet.has(e.data?.from)) {
                outflows += amt;
            }
        } else if (m === "Deposited" && kahSet.has(e.data?.who)) {
            const donor = await findCrossChainDonor(e);
            if (donor) {
                addDonor(donors, donor, amt);
            } else {
                unident.push({
                    timestamp: e.timestamp,
                    amountRaw: amt.toString(),
                });
            }
        } else if (m === "Withdrawn" && kahSet.has(e.data?.who)) {
            outflows += amt;
        } else if (m === "Burned" && kahSet.has(e.data?.owner)) {
            outflows += amt;
        }
    }

    const next = {
        version: CACHE_VERSION,
        cursorBlock: maxBlock,
        donors,
        crossChainUnidentified: unident,
        totalOutflowsRaw: outflows.toString(),
    };
    if (newEvents.length > 0) await saveState("USDC", next);
    return renderState(next, "USDC", USDC_DECIMALS);
}

// ─── KSM across faucets (Encointer) ─────────────────────────────────────────

async function discoverFaucetAccounts() {
    // FaucetCreated event data shape (positional): [faucetAccount, name].
    // No Closed/Drained/Dissolved events emitted by the current pallet.
    const created = await db.events
        .find({
            section: "encointerFaucet",
            method: "FaucetCreated",
        })
        .sort({ blockNumber: 1 })
        .toArray();
    return created
        .map((e) => (e.data ?? [])[0] ?? null)
        .filter(Boolean);
}

async function buildKsmLeaderboard() {
    const state = await loadState("KSM");
    const accounts = await discoverFaucetAccounts();
    if (accounts.length === 0) {
        return renderState(emptyState(), "KSM", KSM_DECIMALS);
    }
    const accountSet = new Set(accounts);

    const newEvents = await db.events
        .find({
            section: "balances",
            blockNumber: { $gt: state.cursorBlock },
            $or: [
                { method: "Transfer", "data.to": { $in: accounts } },
                { method: "Transfer", "data.from": { $in: accounts } },
                { method: "Deposit", "data.who": { $in: accounts } },
                { method: "Withdraw", "data.who": { $in: accounts } },
            ],
        })
        .sort({ blockNumber: 1 })
        .toArray();

    let maxBlock = state.cursorBlock;
    const donors = { ...state.donors };
    const unident = [...state.crossChainUnidentified];
    let outflows = BigInt(state.totalOutflowsRaw || "0");

    for (const e of newEvents) {
        if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
        const amt = toBigInt(e.data?.amount);
        const m = e.method;
        if (m === "Transfer") {
            if (accountSet.has(e.data?.to)) {
                addDonor(donors, e.data?.from, amt);
            } else if (accountSet.has(e.data?.from)) {
                outflows += amt;
            }
        } else if (m === "Deposit" && accountSet.has(e.data?.who)) {
            unident.push({
                timestamp: e.timestamp,
                amountRaw: amt.toString(),
            });
        } else if (m === "Withdraw" && accountSet.has(e.data?.who)) {
            outflows += amt;
        }
    }

    const next = {
        version: CACHE_VERSION,
        cursorBlock: maxBlock,
        donors,
        crossChainUnidentified: unident,
        totalOutflowsRaw: outflows.toString(),
    };
    if (newEvents.length > 0) await saveState("KSM", next);
    return renderState(next, "KSM", KSM_DECIMALS);
}

/**
 * @swagger
 * /v1/leaderboard:
 *   get:
 *     description: Aggregate donor leaderboard for a token across every
 *       recipient (USDC across treasuries, KSM across faucets).
 *     parameters:
 *       - in: query
 *         name: token
 *         schema: { type: string, default: USDC }
 *     responses:
 *       '200': { description: Success }
 *       '400': { description: Unsupported token }
 */
leaderboard.get("/", async function (req, res, next) {
    try {
        const token = String(req.query.token ?? "USDC").toUpperCase();
        if (token === "USDC") {
            return res.send(await buildUsdcLeaderboard());
        }
        if (token === "KSM") {
            return res.send(await buildKsmLeaderboard());
        }
        return res.status(400).send({ error: "unsupported token" });
    } catch (e) {
        next(e);
    }
});

export default leaderboard;
