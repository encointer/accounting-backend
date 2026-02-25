import express from "express";
import base58 from "bs58";
import db from "../db.js";

const governance = express.Router();

// State from .toJSON() is { variantName: null | data }, e.g. { enacted: null }
function stateKey(state) {
    if (typeof state === "string") return state.toLowerCase();
    if (typeof state === "object" && state !== null) return Object.keys(state)[0];
    return "";
}

const TERMINAL_KEYS = new Set(["enacted", "approved", "rejected", "supersededby", "supersededBy"]);

function isTerminal(state) {
    return TERMINAL_KEYS.has(stateKey(state));
}

const STATE_LABELS = {
    enacted: "Enacted",
    approved: "Approved",
    rejected: "Rejected",
    ongoing: "Ongoing",
    confirming: "Confirming",
    supersededBy: "SupersededBy",
};

function stateLabel(state) {
    return STATE_LABELS[stateKey(state)] || stateKey(state) || "Unknown";
}

function actionSummary(action, cidNameMap) {
    if (!action || typeof action !== "object") return String(action);
    const variant = Object.keys(action)[0];
    const args = action[variant];
    const cn = (cidObj) => {
        const cid = formatCid(cidObj);
        return cidNameMap[cid] || cid;
    };
    switch (variant) {
        case "updateNominalIncome":
            return `Update nominal income for ${cn(args[0])} to ${formatFixedPoint(args[1])}`;
        case "updateDemurrage":
            return `Update demurrage for ${cn(args[0])}`;
        case "addLocation":
            return `Add location to ${cn(args[0])}`;
        case "removeLocation":
            return `Remove location from ${cn(args[0])}`;
        case "updateCommunityMetadata":
            return `Update metadata for ${cn(args[0])}`;
        case "setInactivityTimeout":
            return `Set inactivity timeout to ${args}`;
        case "petition":
            return `Petition: ${decodeText(args[1])}`.slice(0, 200);
        case "spendNative":
            return `Spend ${formatNativeBalance(args[2])} KSM to ${addrShort(args[1])}`;
        case "spendAsset":
            return `Spend asset to ${addrShort(args[1])}`;
        case "issueSwapNativeOption":
            return `Issue swap native option for ${cn(args[0])}`;
        case "issueSwapAssetOption":
            return `Issue swap asset option for ${cn(args[0])}`;
        default:
            return variant;
    }
}

// Convert { geohash: "0x...", digest: "0x..." } to human-readable CID string
function formatCid(cid) {
    if (!cid || typeof cid !== "object") return cid ? String(cid) : "?";
    const geoHex = (cid.geohash || "").replace(/^0x/, "");
    const digestHex = (cid.digest || "").replace(/^0x/, "");
    const geohash = Buffer.from(geoHex, "hex").toString("ascii");
    const digest = base58.encode(Buffer.from(digestHex, "hex"));
    return geohash + digest;
}

function addrShort(addr) {
    if (!addr) return "?";
    return String(addr).slice(0, 8) + "...";
}

// Decode PalletString (Text) — may be hex-encoded or plain string
function decodeText(raw) {
    if (!raw) return "";
    if (typeof raw === "string" && raw.startsWith("0x")) {
        return Buffer.from(raw.slice(2), "hex").toString("utf8");
    }
    return String(raw);
}

// FixedI64F64 { bits: i128 } — 64.64 fixed point (community currency amounts)
function formatFixedPoint(raw) {
    if (raw === undefined || raw === null) return "?";
    const bits = typeof raw === "object" && raw.bits !== undefined ? raw.bits : raw;
    const n = BigInt(bits);
    const intPart = Number(n >> 64n);
    const fracPart = Number(n & ((1n << 64n) - 1n)) / 2 ** 64;
    return (intPart + fracPart).toFixed(1);
}

// Plain Balance u128 — 12 decimal places (KSM)
function formatNativeBalance(raw) {
    if (raw === undefined || raw === null) return "?";
    return (Number(BigInt(raw)) / 1e12).toFixed(2);
}

function actionType(action) {
    if (!action || typeof action !== "object") return String(action);
    return Object.keys(action)[0];
}

// Extract community identifier string from action, or null for global actions
function actionCommunityId(action) {
    if (!action || typeof action !== "object") return null;
    const variant = Object.keys(action)[0];
    const args = action[variant];
    if (variant === "setInactivityTimeout") return null;
    // First arg is CommunityIdentifier or Option<CommunityIdentifier>
    const cid = Array.isArray(args) ? args[0] : args;
    if (!cid || typeof cid !== "object" || !cid.geohash) return null;
    return formatCid(cid);
}

/**
 * @swagger
 * /v1/governance/proposals:
 *   get:
 *     description: Retrieve all encointer democracy proposals with tallies
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Array of proposals
 */
governance.get("/proposals", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const proposalCount =
            (await api.query.encointerDemocracy.proposalCount()).toJSON() || 0;

        const proposalLifetime =
            api.consts.encointerDemocracy.proposalLifetime?.toJSON();
        const confirmationPeriod =
            api.consts.encointerDemocracy.confirmationPeriod?.toJSON();

        // Build CID → community name lookup
        const allCommunities = await db.getAllCommunities();
        const cidNameMap = {};
        for (const c of allCommunities) {
            cidNameMap[c.cid] = c.name;
        }

        const results = [];

        for (let id = 1; id <= proposalCount; id++) {
            // Check cache for terminal proposals
            const cached = await db.getFromGeneralCache(
                "governance-proposal",
                { id }
            );
            if (cached.length > 0) {
                results.push(cached[0]);
                continue;
            }

            const [proposalRaw, tallyRaw] = await Promise.all([
                api.query.encointerDemocracy.proposals(id),
                api.query.encointerDemocracy.tallies(id),
            ]);

            if (proposalRaw.isNone) continue;

            const proposal = proposalRaw.toJSON();
            const tally = tallyRaw.isSome ? tallyRaw.toJSON() : { turnout: 0, ayes: 0 };

            const electorate = proposal.electorateSize || proposal.electorate_size || 0;
            const turnout = tally.turnout || 0;
            const ayes = tally.ayes || 0;
            const nays = turnout - ayes;
            const turnoutPct = electorate > 0 ? (turnout / electorate) * 100 : 0;
            const approvalPct = turnout > 0 ? (ayes / turnout) * 100 : 0;

            // AQB threshold: sqrt(electorate) / (sqrt(electorate) + sqrt(turnout)) * 100
            const sqrtE = Math.sqrt(electorate);
            const sqrtT = Math.sqrt(turnout);
            const thresholdPct =
                sqrtE + sqrtT > 0 ? (sqrtE / (sqrtE + sqrtT)) * 100 : 100;

            const state = proposal.state;
            const entry = {
                id,
                start: proposal.start || proposal.startMoment,
                startCindex: proposal.startCindex || proposal.start_cindex,
                actionType: actionType(proposal.action),
                actionSummary: actionSummary(proposal.action, cidNameMap),
                communityId: actionCommunityId(proposal.action),
                communityName: cidNameMap[actionCommunityId(proposal.action)] || null,
                state: stateLabel(state),
                electorateSize: electorate,
                turnout,
                ayes,
                nays,
                turnoutPct: Math.round(turnoutPct * 10) / 10,
                approvalPct: Math.round(approvalPct * 10) / 10,
                thresholdPct: Math.round(thresholdPct * 10) / 10,
                passing: approvalPct >= thresholdPct && turnout > 0,
                proposalLifetime,
                confirmationPeriod,
            };

            // Cache terminal proposals
            if (isTerminal(state)) {
                await db.insertIntoGeneralCache(
                    "governance-proposal",
                    { id },
                    entry
                );
            }

            results.push(entry);
        }

        res.send(JSON.stringify(results));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/governance/vote-timing:
 *   get:
 *     description: Retrieve vote events and attesting phase windows
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Votes and attesting windows
 */
governance.get("/vote-timing", async function (req, res, next) {
    try {
        const [votes, attestingWindows] = await Promise.all([
            db.events
                .find({
                    section: "encointerDemocracy",
                    method: "VotePlaced",
                })
                .sort({ timestamp: 1 })
                .toArray(),
            db.blocks
                .aggregate([
                    { $match: { phase: "ATTESTING" } },
                    {
                        $group: {
                            _id: "$cindex",
                            start: { $min: "$timestamp" },
                            end: { $max: "$timestamp" },
                        },
                    },
                    { $sort: { _id: 1 } },
                ])
                .toArray(),
        ]);

        res.send(
            JSON.stringify({
                votes: votes.map((v) => ({
                    proposalId: v.data?.proposalId ?? v.data?.[0],
                    timestamp: v.timestamp,
                    vote:
                        v.data?.vote ??
                        (v.data?.[1] === "Aye" || v.data?.[1]?.aye !== undefined
                            ? "Aye"
                            : "Nay"),
                    numVotes: v.data?.numVotes ?? v.data?.[2],
                })),
                attestingWindows: attestingWindows.map((w) => ({
                    cindex: w._id,
                    start: w.start,
                    end: w.end,
                })),
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/governance/voting-power-analysis:
 *   get:
 *     description: Per-proposal voting power distributions for voters and electorate
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Per-proposal votersByPower and electorateByPower
 */
governance.get("/voting-power-analysis", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const REPUTATION_LIFETIME = 5;

        // 1. Proposals: need {id, startCindex, communityId}
        const proposalCount =
            (await api.query.encointerDemocracy.proposalCount()).toJSON() || 0;
        const allCommunities = await db.getAllCommunities();
        const cidNameMap = {};
        for (const c of allCommunities) cidNameMap[c.cid] = c.name;

        const proposals = [];
        for (let id = 1; id <= proposalCount; id++) {
            const cached = await db.getFromGeneralCache("governance-proposal", { id });
            if (cached.length > 0) {
                const c = cached[0];
                proposals.push({ id: c.id, startCindex: c.startCindex, communityId: c.communityId });
                continue;
            }
            const proposalRaw = await api.query.encointerDemocracy.proposals(id);
            if (proposalRaw.isNone) continue;
            const p = proposalRaw.toJSON();
            proposals.push({
                id,
                startCindex: p.startCindex || p.start_cindex,
                communityId: actionCommunityId(p.action),
            });
        }

        // 2. VotePlaced events joined with vote extrinsics for voter identity
        const [votePlaced, issuedEvents] = await Promise.all([
            db.events.find({ section: "encointerDemocracy", method: "VotePlaced" }).toArray(),
            db.events.find({ section: "encointerBalances", method: "Issued" }).toArray(),
        ]);

        const extIds = votePlaced.map((v) => v.extrinsicId);
        const extrinsics = await db.extrinsics.find({ _id: { $in: extIds } }).toArray();
        const extMap = new Map(extrinsics.map((e) => [e._id, e]));

        const votesByProposal = new Map();
        for (const v of votePlaced) {
            const ext = extMap.get(v.extrinsicId);
            if (!ext) continue;
            const pid = v.data?.proposalId ?? v.data?.[0];
            const numVotes = v.data?.numVotes ?? v.data?.[2];
            const voter = ext.signer?.Id;
            if (!pid || !voter || !numVotes) continue;
            if (!votesByProposal.has(pid)) votesByProposal.set(pid, []);
            votesByProposal.get(pid).push({ voter, numVotes });
        }

        // 3. Issued events (UBI = successful ceremony) → cindex via blocks
        const blockNums = [...new Set(issuedEvents.map((e) => e.blockNumber))];
        const blocks = await db.blocks
            .find({ height: { $in: blockNums } }, { projection: { height: 1, cindex: 1 } })
            .toArray();
        const blockCindex = new Map(blocks.map((b) => [b.height, b.cindex]));

        const issuances = [];
        for (const e of issuedEvents) {
            const cindex = blockCindex.get(e.blockNumber);
            if (cindex == null) continue;
            issuances.push({ account: e.data[1], cindex });
        }

        // 4. Per-proposal: electorate and voter distributions by power level
        const result = [];
        for (const proposal of proposals) {
            if (!proposal.startCindex) continue;
            const minCi = proposal.startCindex - REPUTATION_LIFETIME + 1;
            const maxCi = proposal.startCindex;

            // Electorate: each Issued event in valid cindex range = one reputation
            const accountPower = new Map();
            for (const iss of issuances) {
                if (iss.cindex >= minCi && iss.cindex <= maxCi) {
                    accountPower.set(iss.account, (accountPower.get(iss.account) || 0) + 1);
                }
            }
            const electorateByPower = {};
            for (const [, power] of accountPower) {
                electorateByPower[power] = (electorateByPower[power] || 0) + 1;
            }

            // Voters
            const votes = votesByProposal.get(proposal.id) || [];
            const votersByPower = {};
            for (const v of votes) {
                votersByPower[v.numVotes] = (votersByPower[v.numVotes] || 0) + 1;
            }

            result.push({
                id: proposal.id,
                communityId: proposal.communityId,
                votersByPower,
                electorateByPower,
            });
        }

        res.send(JSON.stringify({ proposals: result }));
    } catch (e) {
        next(e);
    }
});

export default governance;
