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

const leaderboard = express.Router();

const stripCommas = (s) =>
    s == null ? null : String(s).replace(/,/g, "");
const toBigInt = (s) => (s == null ? 0n : BigInt(stripCommas(s) ?? "0"));
const sumBigInt = (arr) => arr.reduce((a, b) => a + b, 0n);

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
 *  `utility.batchAll` (to pre-swap USDC→DOT for bridge fees), so the source
 *  call may sit one level below the top-level extrinsic. */
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
 *  PAH extrinsic's signer. Supports direct `polkadotXcm.transferAssetsUsingTypeAndThen`
 *  AND `utility.batch*`-wrapped variants (the dapp's actual pattern with an
 *  upfront USDC→DOT fee swap). Both `Definite` and `Wild` deposits are matched. */
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

                // Wild: residue goes to this beneficiary. Match on beneficiary
                // alone, but require source total ≥ depAmount as a sanity floor.
                if (dep2.assets?.Wild && totalSrcAmt >= depAmount) {
                    return x.signer?.Id ?? null;
                }
            }
        }
    }
    return null;
}

/** Aggregate donor leaderboard for USDC across every treasury. Donor counts
 *  reflect distinct donation events; totals sum across all treasuries. */
async function leaderboardUsdcAggregate() {
    const treasuries = getAllTreasuries();
    const kahAccounts = treasuries.map((t) => t.kahAccount);

    const [sameChainAgg, crossChainEvents, outAgg] = await Promise.all([
        db.indexerAssetHub
            .collection("events")
            .aggregate([
                {
                    $match: {
                        section: "foreignAssets",
                        method: "Transferred",
                        "data.to": { $in: kahAccounts },
                        "data.assetId.interior.X4.3.GeneralIndex":
                            USDC_GENERAL_INDEX,
                    },
                },
                {
                    $group: {
                        _id: "$data.from",
                        count: { $sum: 1 },
                        totalRaw: {
                            $sum: {
                                $toLong: {
                                    $replaceAll: {
                                        input: "$data.amount",
                                        find: ",",
                                        replacement: "",
                                    },
                                },
                            },
                        },
                    },
                },
            ])
            .toArray(),
        db.indexerAssetHub
            .collection("events")
            .find({
                section: "foreignAssets",
                method: "Deposited",
                "data.who": { $in: kahAccounts },
                "data.assetId.interior.X4.3.GeneralIndex": USDC_GENERAL_INDEX,
            })
            .sort({ timestamp: 1 })
            .toArray(),
        db.indexerAssetHub
            .collection("events")
            .aggregate([
                {
                    $match: {
                        section: "foreignAssets",
                        "data.assetId.interior.X4.3.GeneralIndex":
                            USDC_GENERAL_INDEX,
                        $or: [
                            { method: "Transferred", "data.from": { $in: kahAccounts } },
                            { method: "Withdrawn", "data.who": { $in: kahAccounts } },
                            { method: "Burned", "data.owner": { $in: kahAccounts } },
                        ],
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalRaw: {
                            $sum: {
                                $toLong: {
                                    $replaceAll: {
                                        input: "$data.amount",
                                        find: ",",
                                        replacement: "",
                                    },
                                },
                            },
                        },
                    },
                },
            ])
            .toArray(),
    ]);

    const crossChainUnidentified = [];
    const crossChainByDonor = new Map();
    for (const e of crossChainEvents) {
        const amt = toBigInt(e.data?.amount);
        const donor = await findCrossChainDonor(e);
        if (donor) {
            const key = toCanonicalSs58(donor);
            const prev = crossChainByDonor.get(key) ?? {
                count: 0,
                totalRaw: 0n,
            };
            prev.count += 1;
            prev.totalRaw += amt;
            crossChainByDonor.set(key, prev);
        } else {
            crossChainUnidentified.push({
                timestamp: e.timestamp,
                amountRaw: amt.toString(),
            });
        }
    }

    const donorMap = new Map();
    for (const r of sameChainAgg) {
        if (!r._id) continue;
        const key = toCanonicalSs58(r._id);
        const prev = donorMap.get(key) ?? { count: 0, totalRaw: 0n };
        prev.count += r.count;
        prev.totalRaw += BigInt(r.totalRaw);
        donorMap.set(key, prev);
    }
    for (const [ss58, agg] of crossChainByDonor) {
        const prev = donorMap.get(ss58) ?? { count: 0, totalRaw: 0n };
        prev.count += agg.count;
        prev.totalRaw += agg.totalRaw;
        donorMap.set(ss58, prev);
    }

    const donors = [...donorMap.entries()]
        .map(([ss58, v]) => ({
            ss58,
            count: v.count,
            totalRaw: v.totalRaw.toString(),
        }))
        .sort((a, b) => {
            const d = BigInt(b.totalRaw) - BigInt(a.totalRaw);
            return d > 0n ? 1 : d < 0n ? -1 : 0;
        });

    const totalInflowsRaw =
        sumBigInt(sameChainAgg.map((r) => BigInt(r.totalRaw))) +
        sumBigInt([...crossChainByDonor.values()].map((v) => v.totalRaw)) +
        sumBigInt(crossChainUnidentified.map((a) => BigInt(a.amountRaw)));
    const totalOutflowsRaw = BigInt(outAgg[0]?.totalRaw ?? 0);

    return {
        token: "USDC",
        decimals: USDC_DECIMALS,
        totalInflowsRaw: totalInflowsRaw.toString(),
        totalOutflowsRaw: totalOutflowsRaw.toString(),
        donors,
        crossChainUnidentified,
    };
}

/** Discover all-time faucet accounts from the Encointer indexer. */
async function discoverFaucetAccounts() {
    const created = await db.events
        .find({
            section: "encointerFaucet",
            method: "FaucetCreated",
        })
        .sort({ blockNumber: 1 })
        .toArray();
    // FaucetCreated data shape (positional): [faucetAccount, name].
    // No Closed/Drained/Dissolved events emitted by the current pallet.
    return created
        .map((e) => {
            const data = e.data ?? [];
            return data[0] ?? null;
        })
        .filter(Boolean);
}

/** Aggregate donor leaderboard for KSM across every faucet. */
async function leaderboardKsmAggregate() {
    const accounts = await discoverFaucetAccounts();
    if (accounts.length === 0) {
        return {
            token: "KSM",
            decimals: KSM_DECIMALS,
            totalInflowsRaw: "0",
            totalOutflowsRaw: "0",
            donors: [],
            crossChainUnidentified: [],
        };
    }

    const [sameChainAgg, xcmDeposits, outAgg] = await Promise.all([
        db.events
            .aggregate([
                {
                    $match: {
                        section: "balances",
                        method: "Transfer",
                        "data.to": { $in: accounts },
                    },
                },
                {
                    $group: {
                        _id: "$data.from",
                        count: { $sum: 1 },
                        totalRaw: {
                            $sum: {
                                $toLong: {
                                    $replaceAll: {
                                        input: "$data.amount",
                                        find: ",",
                                        replacement: "",
                                    },
                                },
                            },
                        },
                    },
                },
            ])
            .toArray(),
        db.events
            .find({
                section: "balances",
                method: "Deposit",
                "data.who": { $in: accounts },
            })
            .sort({ timestamp: 1 })
            .toArray(),
        db.events
            .aggregate([
                {
                    $match: {
                        section: "balances",
                        $or: [
                            { method: "Transfer", "data.from": { $in: accounts } },
                            { method: "Withdraw", "data.who": { $in: accounts } },
                        ],
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalRaw: {
                            $sum: {
                                $toLong: {
                                    $replaceAll: {
                                        input: "$data.amount",
                                        find: ",",
                                        replacement: "",
                                    },
                                },
                            },
                        },
                    },
                },
            ])
            .toArray(),
    ]);

    const donorMap = new Map();
    for (const r of sameChainAgg) {
        if (!r._id) continue;
        const key = toCanonicalSs58(r._id);
        const prev = donorMap.get(key) ?? { count: 0, totalRaw: 0n };
        prev.count += r.count;
        prev.totalRaw += BigInt(r.totalRaw);
        donorMap.set(key, prev);
    }
    const donors = [...donorMap.entries()]
        .map(([ss58, v]) => ({
            ss58,
            count: v.count,
            totalRaw: v.totalRaw.toString(),
        }))
        .sort((a, b) => {
            const d = BigInt(b.totalRaw) - BigInt(a.totalRaw);
            return d > 0n ? 1 : d < 0n ? -1 : 0;
        });

    const sameChainTotal = sumBigInt(
        sameChainAgg.map((r) => BigInt(r.totalRaw)),
    );
    const xcmDepositTotal = sumBigInt(
        xcmDeposits.map((e) => toBigInt(e.data?.amount)),
    );

    return {
        token: "KSM",
        decimals: KSM_DECIMALS,
        totalInflowsRaw: (sameChainTotal + xcmDepositTotal).toString(),
        totalOutflowsRaw: BigInt(outAgg[0]?.totalRaw ?? 0).toString(),
        donors,
        crossChainUnidentified: xcmDeposits.map((e) => ({
            timestamp: e.timestamp,
            amountRaw: toBigInt(e.data?.amount).toString(),
        })),
    };
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
            return res.send(await leaderboardUsdcAggregate());
        }
        if (token === "KSM") {
            return res.send(await leaderboardKsmAggregate());
        }
        return res.status(400).send({ error: "unsupported token" });
    } catch (e) {
        next(e);
    }
});

export default leaderboard;
