import express from "express";
import {
    applyDemurrage,
    gatherAccountingOverview,
    gatherRewardsData,
    getDemurragePerBlock,
    generateTxnLog,
} from "../data.js";
import { CIDS } from "../consts.js";
import { parseEncointerBalance } from "@encointer/types";
import {
    gatherTransactionData,
    getBlockNumberByTimestamp,
} from "../graphQl.js";
import { validateAccountOrAdminToken } from "../apiUtil.js";

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
 *      - ApiKeyAuth: []
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
                communityName: CIDS[cid].name,
                name: CIDS[cid].accounts[account]?.name || "",
                year,
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
 *      - ApiKeyAuth: []
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
        const cidData = CIDS[cid];
        const cidDecoded = cidData.cidDecoded;
        const communityName = cidData.name;
        const blockNumber = await getBlockNumberByTimestamp(timestamp);
        const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
        const apiAt = await api.at(blockHash);
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
                accountName: cidData.accounts[e.key[1]]?.name,
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
 * /v1/accounting/tokens:
 *   get:
 *     description: Retrieve all access tokens of businesses
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - ApiKeyAuth: []
 */
accounting.get("/tokens", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        res.send(JSON.stringify(CIDS));
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
 *      - ApiKeyAuth: []
 */
accounting.get("/all-accounts-data", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const cidData = CIDS[cid];
        const communityName = cidData.name;
        const accounts = cidData.accounts;

        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();

        const data = [];
        for (const [account, accountInfo] of Object.entries(accounts)) {
            data.push({
                name: accountInfo.name,
                data: await gatherAccountingOverview(
                    api,
                    account,
                    cid,
                    year,
                    month
                ),
            });
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
 *      - ApiKeyAuth: []
 */
accounting.get("/rewards-data", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;

        const data = await gatherRewardsData(api, cid);

        res.send(JSON.stringify({ data, communityName: CIDS[cid].name }));
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
 *     security:
 *      - ApiKeyAuth: []
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
