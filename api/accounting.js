import express from "express";
import {
    applyDemurrage,
    gatherAccountingOverview,
    gatherRewardsData,
    getDemurragePerBlock,
    generateTxnLog,
    getSelectedRangeData,
} from "../data.js";
import { parseEncointerBalance } from "@encointer/types";
import {
    gatherTransactionData,
    getBlockNumberByTimestamp,
} from "../graphQl.js";
import db from "../db.js";
import { parseCid } from "../util.js";

const accounting = express.Router();

/**
 * @swagger
 * /v1/accounting/accounting-data:
 *   get:
 *     description: Retrieve aggregated accounting data for a given cid and user
 *     parameters:
 *       - in: query
 *         name: account
 *         required: true
 *         description: AccountId
 *         schema:
 *           type: string
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
accounting.get("/accounting-data", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const cid = req.query.cid;
        const account = req.session?.address;

        if (!account) {
            res.sendStatus(403);
            return;
        }

        const user = await db.getUser(account);
        const community = await db.getCommunity(cid);

        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();

        const data = await gatherAccountingOverview(
            api,
            account,
            cid,
            year,
            month
        );
        res.send(
            JSON.stringify({
                data,
                communityName: community.name,
                name: user.name,
                year,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/selected-range-data:
 *   get:
 *     description: Retrieve start balance, end balance and daily digest for a certain time range
 *     parameters:
 *       - in: query
 *         name: account
 *         required: true
 *         description: AccountId
 *         schema:
 *           type: string
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *       - in: query
 *         name: end
 *         required: true
 *         description:  timestamp
 *         schema:
 *           type: number
 *       - in: query
 *         name: cid
 *         required: true
 *         description: timestamp
 *         schema:
 *           type: number
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
accounting.get("/selected-range-data", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const cid = req.query.cid;
        const start = req.query.start;
        const end = req.query.end;
        const account = req.session?.address;

        if (!account) {
            res.sendStatus(403);
            return;
        }

        const user = await db.getUser(account);
        const community = await db.getCommunity(cid);

        const data = await getSelectedRangeData(api, account, cid, start, end);
        res.send(
            JSON.stringify({
                data,
                communityName: community.name,
                name: user.name,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/account-overview:
 *   get:
 *     description: Retrieve overview of balances of all accounts
 *     parameters:
 *       - in: query
 *         name: timestamp
 *         required: true
 *         description: Timestamp
 *         schema:
 *           type: string
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
accounting.get("/account-overview", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }

        const api = req.app.get("api");
        const timestamp = req.query.timestamp;
        const cid = req.query.cid;
        const cidDecoded = parseCid(cid);
        const community = await db.getCommunity(cid);
        const communityName = community.name;
        const blockNumber = await getBlockNumberByTimestamp(timestamp);
        const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
        const apiAt = await api.at(blockHash);
        const allUsers = await db.getAllUsers();
        let entries = (
            await apiAt.query.encointerBalances.balance.entries()
        ).map((e) => ({ key: e[0].toHuman(), value: e[1] }));
        const demurragePerBlock = await getDemurragePerBlock(
            api,
            cidDecoded,
            blockHash
        );

        entries = entries
            .filter(
                (e) => JSON.stringify(e.key[0]) === JSON.stringify(cidDecoded)
            )
            .map((e) => ({
                account: e.key[1],
                accountName: allUsers.find((u) => u.address === e.key[1])?.name,
                balance: applyDemurrage(
                    parseEncointerBalance(e.value.principal.bits),
                    blockNumber - e.value.lastUpdate.toNumber(),
                    demurragePerBlock
                ),
            }));
        res.send(JSON.stringify({ data: entries, communityName }));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/all-accounts-data:
 *   get:
 *     description: Retrieve accounting-data for all accounts of a specified cid
 *     parameters:
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
accounting.get("/all-accounts-data", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const users = await db.getCommunityUsers(cid);

        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();

        const data = [];

        for (const user of users) {
            try {
                data.push({
                    name: user.name,
                    data: await gatherAccountingOverview(
                        api,
                        user.address,
                        cid,
                        year,
                        month
                    ),
                });
            } catch (err) {
                console.log(err);
                continue;
            }
        }

        res.send(
            JSON.stringify({
                data,
                communityName,
                year,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/rewards-data:
 *   get:
 *     description: Retrieve overview of paid rewards per cycle for a specified cid
 *     parameters:
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
accounting.get("/rewards-data", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const data = await gatherRewardsData(api, cid);

        res.send(JSON.stringify({ data, communityName: communityName }));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/transaction-log:
 *   get:
 *     description: Retrieve transaction log for a specified account, in cid, between start and end
 *     parameters:
 *       - in: query
 *         name: start
 *         required: true
 *         description: Timestamp
 *         schema:
 *           type: string
 *       - in: query
 *         name: end
 *         required: true
 *         description: Timestamp
 *         schema:
 *           type: string
 *       - in: query
 *         name: account
 *         required: true
 *         description: AccountId
 *         schema:
 *           type: string
 *       - in: query
 *         name: cid
 *         required: true
 *         description: Base58 encoded CommunityIdentifier, eg. u0qj944rhWE
 *         schema:
 *           type: string
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 */
accounting.get("/transaction-log", async function (req, res, next) {
    try {
        const query = req.query;
        const cid = query.cid;
        const account = query.account;
        const start = query.start;
        const end = query.end;

        const [incoming, outgoing, issues] = await gatherTransactionData(
            start,
            end,
            account,
            cid
        );

        const txnLog = generateTxnLog(incoming, outgoing, issues);

        res.send(JSON.stringify(txnLog));
    } catch (e) {
        next(e);
    }
});

export default accounting;
