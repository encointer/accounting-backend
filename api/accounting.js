import express from "express";
import {
    applyDemurrage,
    gatherAccountingOverview,
    gatherRewardsData,
    getDemurragePerBlock,
    generateTxnLog,
    getBlockNumberByTimestamp,
} from "../data.js";
import { CIDS } from "../consts.js";
import { parseEncointerBalance } from "@encointer/types";
import {
    gatherTransactionData
} from "../graphQl.js";
import { validateAccountOrAdminToken, validateAdminToken } from "../apiUtil.js";

const accounting = express.Router();

accounting.get("/accounting-data", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const account = req.query.account;
        const cid = req.query.cid;

        if (!validateAccountOrAdminToken(account, cid, req)) {
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

accounting.get("/account-overview", async function (req, res, next) {
    try {
        if (!validateAdminToken(req)) {
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

accounting.get("/tokens", async function (req, res, next) {
    try {
        if (!validateAdminToken(req)) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        res.send(JSON.stringify(CIDS));
    } catch (e) {
        next(e);
    }
});

accounting.get("/all-accounts-data", async function (req, res, next) {
    try {
        if (!validateAdminToken(req)) {
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

accounting.get("/rewards-data", async function (req, res, next) {
    try {
        if (!validateAdminToken(req)) {
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
