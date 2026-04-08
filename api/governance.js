import express from "express";
import db from "../db.js";
import {
    stateKey,
    isTerminal,
    stateLabel,
    actionSummary,
    formatCid,
    actionType,
    actionCommunityId,
} from "./governanceHelpers.js";

const governance = express.Router();

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
            if (cached.length > 0 && cached[0].state !== "Approved") {
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
        const REPUTATION_LIFETIME =
            api.consts.encointerCeremonies?.reputationLifetime?.toJSON() || 5;

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
            .find({ height: { $in: blockNums } }, { projection: { height: 1, cindex: 1, phase: 1 } })
            .toArray();
        const blockInfo = new Map(blocks.map((b) => [b.height, { cindex: b.cindex, phase: b.phase }]));

        // Build (cid, cindex) -> set(accounts) from Issued events, deduplicating
        // so each account counts at most once per ceremony per community.
        const cidCiAccts = new Map(); // key: "cid:cindex", value: Set of accounts
        for (const e of issuedEvents) {
            const info = blockInfo.get(e.blockNumber);
            if (!info || info.cindex == null) continue;
            // Adjust for REGISTERING phase: issuance belongs to previous ceremony
            const cindex = info.phase === "REGISTERING" ? info.cindex - 1 : info.cindex;
            const cid = e.data[0];
            const account = e.data[1];
            const key = `${cid}:${cindex}`;
            if (!cidCiAccts.has(key)) cidCiAccts.set(key, new Set());
            cidCiAccts.get(key).add(account);
        }

        // 4. Per-proposal: electorate and voter distributions by power level
        const result = [];
        for (const proposal of proposals) {
            if (!proposal.startCindex || !proposal.communityId) continue;
            // Pallet window: voting_cindexes = [cs - R + plc, cs - 2]
            // where plc = proposal_lifetime_cycles = 1 on Kusama
            const maxPower = REPUTATION_LIFETIME - 1;
            const minCi = proposal.startCindex - REPUTATION_LIFETIME + 1;
            const maxCi = proposal.startCindex - 2; // pallet uses saturating_sub(2)

            // Electorate: unique accounts per ceremony in the window
            const accountPower = new Map();
            for (let ci = minCi; ci <= maxCi; ci++) {
                const accts = cidCiAccts.get(`${proposal.communityId}:${ci}`);
                if (!accts) continue;
                for (const acct of accts) {
                    accountPower.set(acct, (accountPower.get(acct) || 0) + 1);
                }
            }
            // Cap power at maxPower
            for (const [acct, power] of accountPower) {
                if (power > maxPower) accountPower.set(acct, maxPower);
            }
            const electorateByPower = {};
            for (const [, power] of accountPower) {
                electorateByPower[power] = (electorateByPower[power] || 0) + 1;
            }

            // Voters — use on-chain numVotes from VotePlaced events
            const votes = votesByProposal.get(proposal.id) || [];
            const votersByPower = {};
            for (const v of votes) {
                const pw = Math.min(v.numVotes, maxPower);
                votersByPower[pw] = (votersByPower[pw] || 0) + 1;
            }

            result.push({
                id: proposal.id,
                communityId: proposal.communityId,
                votersByPower,
                electorateByPower,
            });
        }

        res.send(JSON.stringify({ proposals: result, reputationLifetime: REPUTATION_LIFETIME }));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/governance/swap-voter-client-analysis:
 *   get:
 *     description: For each enacted swap option proposal, categorize Aye voters into
 *                  those who previously sent CC to the beneficiary and those who have not.
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Per-proposal breakdown of client vs non-client voters
 */
governance.get("/swap-voter-client-analysis", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const allCommunities = await db.getAllCommunities();
        const cidNameMap = {};
        for (const c of allCommunities) cidNameMap[c.cid] = c.name;

        // 1. Find enacted swap option proposals with beneficiary addresses
        const proposalCount =
            (await api.query.encointerDemocracy.proposalCount()).toJSON() || 0;

        const swapProposals = [];
        for (let id = 1; id <= proposalCount; id++) {
            const proposalRaw = await api.query.encointerDemocracy.proposals(id);
            if (proposalRaw.isNone) continue;
            const proposal = proposalRaw.toJSON();
            const aType = actionType(proposal.action);
            if (aType !== "issueSwapAssetOption" && aType !== "issueSwapNativeOption") continue;
            if (stateKey(proposal.state) !== "enacted") continue;

            const args = proposal.action[aType];
            const beneficiary = args[1];
            const communityId = actionCommunityId(proposal.action);

            swapProposals.push({
                id,
                beneficiary,
                communityId,
                communityName: cidNameMap[communityId] || communityId,
                actionType: aType,
                actionSummary: actionSummary(proposal.action, cidNameMap),
            });
        }

        // 2. Get all VotePlaced events and resolve voter addresses
        const votePlaced = await db.events
            .find({ section: "encointerDemocracy", method: "VotePlaced" })
            .toArray();
        const extIds = votePlaced.map((v) => v.extrinsicId);
        const extrinsics = await db.extrinsics
            .find({ _id: { $in: extIds } })
            .toArray();
        const extMap = new Map(extrinsics.map((e) => [e._id, e]));

        // Build per-proposal Aye voters with timestamps
        const ayeVotersByProposal = new Map();
        for (const v of votePlaced) {
            const ext = extMap.get(v.extrinsicId);
            if (!ext) continue;
            const pid = v.data?.proposalId ?? v.data?.[0];
            const voteDir =
                v.data?.vote ??
                (v.data?.[1] === "Aye" || v.data?.[1]?.aye !== undefined
                    ? "Aye"
                    : "Nay");
            const voter = ext.signer?.Id;
            if (!pid || !voter || voteDir !== "Aye") continue;
            if (!ayeVotersByProposal.has(pid)) ayeVotersByProposal.set(pid, []);
            ayeVotersByProposal.get(pid).push({ voter, timestamp: v.timestamp });
        }

        // 3. For each swap proposal, check which Aye voters are clients
        const results = [];
        for (const sp of swapProposals) {
            const ayeVoters = ayeVotersByProposal.get(sp.id) || [];
            if (ayeVoters.length === 0) {
                results.push({
                    ...sp,
                    totalAyeVoters: 0,
                    clientVoters: 0,
                    nonClientVoters: 0,
                    clients: [],
                    nonClients: [],
                });
                continue;
            }

            // Query all CC transfers TO beneficiary
            const transfersToBeneficiary = await db.events
                .find({
                    section: "encointerBalances",
                    method: "Transferred",
                    "data.2": sp.beneficiary,
                })
                .toArray();

            // Build map: sender → list of transfer timestamps
            const senderTransfers = new Map();
            for (const t of transfersToBeneficiary) {
                const sender = t.data[1];
                if (!senderTransfers.has(sender)) senderTransfers.set(sender, []);
                senderTransfers.get(sender).push(t.timestamp);
            }

            const clients = [];
            const nonClients = [];
            for (const { voter, timestamp: voteTs } of ayeVoters) {
                const transfers = senderTransfers.get(voter) || [];
                const hasPriorTransfer = transfers.some((ts) => ts < voteTs);
                if (hasPriorTransfer) {
                    clients.push(voter);
                } else {
                    nonClients.push(voter);
                }
            }

            results.push({
                ...sp,
                totalAyeVoters: ayeVoters.length,
                clientVoters: clients.length,
                nonClientVoters: nonClients.length,
                clients,
                nonClients,
            });
        }

        res.send(JSON.stringify(results));
    } catch (e) {
        next(e);
    }
});

export default governance;
