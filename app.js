import {
    applyDemurrage,
    getAccountingData,
    getDemurragePerBlock,
    validateAccountToken,
} from "./util.js";
import cors from "cors";
import { CIDS } from "./consts.js";
import { parseEncointerBalance } from "@encointer/types";
import { getBlockNumberByTimestamp } from "./graphQl.js";

function addToCache(account, year, month, data) {
    DATA_CACHE[account] = DATA_CACHE[account] || {};
    DATA_CACHE[account][year] = DATA_CACHE[account][year] || {};
    DATA_CACHE[account][year][month] = data;
}

const DATA_CACHE = {};

async function gatherAccountingOverview(api, account, cid, year, month) {
    const cachedData = DATA_CACHE[account]?.[year]
    const data = [];
    for (let i = 0; i < month; i++) {
        if (cachedData && cachedData[i]) {
            data.push(cachedData[i]);
        } else {
            const accountingData = await getAccountingData(
                api,
                account,
                cid,
                year,
                i
            );
            data.push(accountingData);
            addToCache(account, year, i, accountingData);
        }
    }
    data.push(await getAccountingData(api, account, cid, year, month));
    return data;
}

export function addMiddlewaresAndRoutes(app, api) {
    app.use(cors());

    app.use(function (req, res, next) {
        console.log("Received new request:", req.url);
        var send = res.send;
        res.send = function (body) {
            console.log(
                `Sending response for: ${req.url} with status ${this.statusCode}`
            );
            send.call(this, body);
        };
        next();
    });

    app.get("/get-accounting-data", async function (req, res, next) {
        try {
            const account = req.query.account;
            const cid = req.query.cid;
            const token = req.query.token;

            if (!validateAccountToken(account, cid, token)) {
                res.send(403);
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

    app.get("/get-account-overview", async function (req, res, next) {
        try {
            if (req.query.token !== process.env.ACCESS_TOKEN_ADMIN) {
                res.send(403);
                return;
            }
            
            const timestamp = req.query.timestamp;
            const cidData = CIDS[req.query.cid];
            const cid = cidData.cidDecoded;
            const communityName = cidData.name;
            const blockNumber = await getBlockNumberByTimestamp(timestamp);
            const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
            const apiAt = await api.at(blockHash);
            let entries = (
                await apiAt.query.encointerBalances.balance.entries()
            ).map((e) => ({ key: e[0].toHuman(), value: e[1] }));
            const demurragePerBlock = await getDemurragePerBlock(
                api,
                cid,
                blockHash
            );

            entries = entries
                .filter((e) => JSON.stringify(e.key[0]) === JSON.stringify(cid))
                .map((e) => ({
                    account: e.key[1],
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

    app.get("/get-all-accounts-data", async function (req, res, next) {
        try {
            if (req.query.token !== process.env.ACCESS_TOKEN_ADMIN) {
                res.send(403);
                return;
            }
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

    return app;
}
