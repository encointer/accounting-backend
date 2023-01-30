import { ApiPromise, WsProvider } from "@polkadot/api";
const encointer_rpc_endpoint = "wss://kusama.api.encointer.org";
import typesBundle from "./typesBundle.js";
import {
    applyDemurrage,
    getAccountingData,
    getBlockNumber,
    getDemurragePerBlock,
    getLastBlockOfMonth,
    validateAccountToken,
} from "./util.js";
import express from "express";
import cors from "cors";
import { ACCOUNTS, CIDS } from "./consts.js";
import { parseEncointerBalance } from "@encointer/types";

const DATA_CACHE = {};

function getFromCache(account, year, month) {
    const data = [];
    for (let i = 0; i < month; i++) {
        const item = DATA_CACHE[account]?.[year]?.[month];
        if (item) data.push(item);
    }
    return data;
}

function addToCache(account, year, month, data) {
    DATA_CACHE[account] = DATA_CACHE[account] || {};
    DATA_CACHE[account][year] = DATA_CACHE[account][year] || {};
    DATA_CACHE[account][year][month] = data;
}

async function main() {
    const wsProvider = new WsProvider(encointer_rpc_endpoint);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    const app = express();
    app.use(cors());

    app.get("/get-accounting-data", async function (req, res, next) {
        try {
            const account = req.query.account;
            const cid = req.query.cid;
            const token = req.query.token;

            if (!validateAccountToken(account, token)) {
                res.send(403);
                return;
            }
            const now = new Date();
            const year = now.getUTCFullYear();
            const month = now.getUTCMonth();
            const cached_data = getFromCache(account, year, month);

            const data = [];
            for (let i = 0; i < month; i++) {
                if (cached_data[i]) {
                    data.push(cached_data[i]);
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
            res.send(
                JSON.stringify({
                    data,
                    communityName: CIDS[cid].name,
                    name: ACCOUNTS[account].name,
                    year,
                })
            );
        } catch (e) {
            next(e);
        }
    });

    app.get("/get-account-overview", async function (req, res, next) {
        try {
            const timestamp = req.query.timestamp;
            const cidData = CIDS[req.query.cid];
            const cid = cidData.cidDecoded;
            const communityName = cidData.name;
            const blockNumber = await getBlockNumber(api, timestamp);
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
            res.send(JSON.stringify({data: entries, communityName}));
        } catch (e) {
            next(e);
        }
    });

    app.listen(8081);
}

main().catch(console.error);
//.finally(() => process.exit());
