import express from "express";
import {
    applyDemurrage,
    gatherAccountingOverview,
    gatherRewardsData,
    getDemurragePerBlock,
    generateTxnLog,
    getSelectedRangeData,
    getMoneyVelocity,
    getVolume,
    getCumulativeRewardsData,
    getFrequencyOfAttendance,
    getTransactionActivityLog,
    getSankeyReport,
    getCommunityFlowData,
    getCommunityFlowDataRange,
    getCircularityTimeSeries,
    generateNativeTxnLog,
} from "../data.js";
import { parseEncointerBalance } from "@encointer/types";
import {
    gatherNativeTransactionData,
    gatherTransactionData,
    getBlockNumberByTimestamp,
    getAllTransfers,
    getAllIssues,
} from "../graphQl.js";
import { computePerNodeCircularity } from "../circularity.js";
import db from "../db.js";
import { parseCid, reduceObjects } from "../util.js";
import {
    getAssetNameAndDecimals,
    getTreasuryByCid,
    getTreasuryName,
    USDC_FOREIGN_ASSET_ID,
    USDC_DECIMALS,
} from "../treasuryConfig.js";
import {
    actionType,
    actionCommunityId,
    stateLabel,
    isTerminal,
} from "./governanceHelpers.js";

const accounting = express.Router();

/**
 * @swagger
 * /v1/accounting/accounting-data:
 *   get:
 *     description: Retrieve aggregated accounting data for a given cid and user
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
        const yearNow = now.getUTCFullYear();
        let month = now.getUTCMonth();
        const year = parseInt(req.query.year || yearNow);
        if (year < yearNow) month = 11;

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
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }

        const api = req.app.get("api");
        const timestamp = parseInt(req.query.timestamp);
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
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const includeCurrentMonth = req.query.includeCurrentMonth;

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const users = await db.getCommunityUsers(cid);
        const now = new Date();
        const yearNow = now.getUTCFullYear();
        let month = now.getUTCMonth();
        const year = parseInt(req.query.year || yearNow);
        if (year < yearNow) month = 11;

        const data = [];

        const userPromises = users.map(async (user) => {
            try {
                return {
                    name: user.name,
                    data: await gatherAccountingOverview(
                        api,
                        user.address,
                        cid,
                        year,
                        month,
                        includeCurrentMonth
                    ),
                };
            } catch (err) {
                console.log(err);
                return null;
            }
        });

        const results = await Promise.all(userPromises);
        results.forEach((result) => {
            if (result) {
                data.push(result);
            }
        });

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
 */
accounting.get("/rewards-data", async function (req, res, next) {
    try {
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
        const start = parseInt(query.start);
        const end = parseInt(query.end);

        const [incoming, outgoing, issues] = await gatherTransactionData(
            start,
            end,
            account,
            cid
        );

        const [spends, burns, transferred] = await Promise.all([
            db
                .getTreasurySpendsByUser(account, start, end)
                .then((c) => c.toArray()),
            db
                .getBalancesBurnedByUser(account, start, end)
                .then((c) => c.toArray()),
            db
                .getBalancesTransferredByUser(account, start, end)
                .then((c) => c.toArray()),
        ]);

        for (const spend of spends) {
            const burn = burns.find((b) => b.blockNumber === spend.blockNumber);
            const transferToTreasury = transferred.find(
                (t) =>
                    t.blockNumber === spend.blockNumber &&
                    t.data[2] === spend.data.treasury
            );

            let amount = 0;
            if (burn) {
                amount = -burn.data[2];
            }

            if (transferToTreasury) {
                amount = -transferToTreasury.data[3];
            }

            const nameAndDecimals = getAssetNameAndDecimals(
                spend.data.assetId
            );
            if (!nameAndDecimals) {
                console.warn(`transaction-log: unknown assetId in spend ${spend._id}: ${JSON.stringify(spend.data.assetId)}`);
                continue;
            }
            const { name, decimals } = nameAndDecimals;
            const treasuryName = getTreasuryName(spend.data.treasury);
            const assetAmount =
                parseInt(spend.data.amount.replace(/,/g, "")) /
                Math.pow(10, decimals);

            spend.name = burn || transferToTreasury ? "Swap" : "Spend";
            spend.foreignAssetName = name;
            spend.foreignAssetAmount = assetAmount;
            spend.decimals = decimals;
            spend.treasuryName = treasuryName;
            spend.amount = burn ? -burn.data[2] : 0;
        }

        const txnLog = generateTxnLog(incoming, outgoing, issues, spends);

        res.send(JSON.stringify(txnLog));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/community-treasury-log:
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
 *         name: cid
 *         required: false
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
accounting.get("/community-treasury-log", async function (req, res, next) {
    try {
        const query = req.query;
        const cid = query.cid;
        const start = parseInt(query.start);
        const end = parseInt(query.end);

        const treasury = getTreasuryByCid(cid);
        if (!treasury) {
            res.status(400).send(JSON.stringify({ error: `No treasury configured for cid ${cid}` }));
            return;
        }
        let [spends, incomingTransactions] = await Promise.all([
            db.getTreasurySpendsByTreasury(treasury.address, start, end),
            db.incomingTreasuryTxns(treasury.address, treasury.kahAccount, start, end),
        ]);

        spends = (await Promise.all(
            spends.map(async (spend) => {
                const [burn, sendToTreasury] = await Promise.all([
                    db.treasurySpendCorrespondingBurn(spend),
                    db.treasurySpendCorrespondingTransferToTreasury(spend),
                ]);
                const nameAndDecimals = getAssetNameAndDecimals(
                    spend.data.assetId
                );
                if (!nameAndDecimals) {
                    console.warn(`community-treasury-log: unknown assetId in spend ${spend._id}: ${JSON.stringify(spend.data.assetId)}`);
                    return null;
                }
                const { name, decimals } = nameAndDecimals;
                const treasuryName = getTreasuryName(spend.data.treasury);
                const amount =
                    parseInt(spend.data.amount.replace(/,/g, "")) /
                    Math.pow(10, decimals);

                return {
                    type: burn || sendToTreasury ? "Swap" : "Spend",
                    assetName: name,
                    decimals: decimals,
                    treasuryName: treasuryName,
                    amount: amount,
                    beneficiary: spend.data.beneficiary,
                    communityCurrencyAmountSwapped: burn ? burn.data[2] : null,
                    timestamp: spend.timestamp,
                };
            })
        )).filter((e) => e !== null);

        incomingTransactions = incomingTransactions.map((txn) => {
            const nameAndDecimals = getAssetNameAndDecimals(txn.data.assetId);
            if (!nameAndDecimals) {
                return null;
            }
            const { name, decimals } = nameAndDecimals;
            return {
                type: "TopUp",
                assetName: name,
                decimals: decimals,
                amount:
                    parseInt(txn.data.amount.replace(/,/g, "")) /
                    Math.pow(10, decimals),
                from: txn.data.from,
                timestamp: txn.timestamp,
            };
        });

        incomingTransactions = incomingTransactions.filter((e) => e !== null);

        let log = incomingTransactions.concat(spends);
        log = log.sort((a, b) => a.timestamp - b.timestamp);

        res.send(JSON.stringify(log));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/native-transaction-log:
 *   get:
 *     description: Retrieve transaction log for a specified account, only native token, between start and end
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
 *     tags:
 *       - accounting
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 */
accounting.get("/native-transaction-log", async function (req, res, next) {
    try {
        const query = req.query;
        const account = query.account;
        const start = parseInt(query.start);
        const end = parseInt(query.end);

        const [incoming, incomingDrips, incomingXcm, outgoing, outgoingXcm] =
            await gatherNativeTransactionData(start, end, account);

        const txnLog = generateNativeTxnLog(
            incoming,
            incomingDrips,
            incomingXcm,
            outgoing,
            outgoingXcm
        );

        res.send(JSON.stringify(txnLog));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/money-velocity-report:
 *   get:
 *     description: Retrieve money velocity report for a specified cid and year
 *     parameters:
 *       - in: query
 *         name: year
 *         required: false
 *         description: Year
 *         schema:
 *           type: number
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
accounting.get("/money-velocity-report", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const useTotalVolume = req.query.useTotalVolume === "true";

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const now = new Date();
        const yearNow = now.getUTCFullYear();
        let month = now.getUTCMonth();
        const year = parseInt(req.query.year || yearNow);
        if (year < yearNow) month = 11;

        const data = {};
        for (let i = 0; i <= month; i++) {
            data[i] = await getMoneyVelocity(api, cid, year, i, useTotalVolume);
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
 * /v1/accounting/volume-report:
 *   get:
 *     description: Retrieve total volume for each month of the year
 *     parameters:
 *       - in: query
 *         name: year
 *         required: false
 *         description: Year
 *         schema:
 *           type: number
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
accounting.get("/volume-report", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const cid = req.query.cid;

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const now = new Date();
        const yearNow = now.getUTCFullYear();
        let month = now.getUTCMonth();
        const year = parseInt(req.query.year || yearNow);
        if (year < yearNow) month = 11;

        const data = {};
        for (let i = 0; i <= month; i++) {
            data[i] = await getVolume(cid, year, i);
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
 * /v1/accounting/reputables-by-cindex:
 *   get:
 *     description: Retrieve the number of reputables by cindex
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
 */
accounting.get("/reputables-by-cindex", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const community = await db.getCommunity(cid);
        const communityName = community.name;

        let cumulativeRewardsData = await getCumulativeRewardsData(api, cid);
        res.send(
            JSON.stringify({
                data: cumulativeRewardsData,
                communityName,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/frequency-of-attendance:
 *   get:
 *     description: Get the frequency of attendance for reputables
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
 */
accounting.get("/frequency-of-attendance", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const data = await getFrequencyOfAttendance(api, cid);
        res.send(
            JSON.stringify({
                data,
                communityName,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/transaction-activity:
 *   get:
 *     description: Get the transaction activity report
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
 */
accounting.get("/transaction-activity", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const cid = req.query.cid;

        const community = await db.getCommunity(cid);

        const now = new Date();
        const yearNow = now.getUTCFullYear();
        let month = now.getUTCMonth();
        const year = parseInt(req.query.year || yearNow);
        if (year < yearNow) month = 11;

        const data = await getTransactionActivityLog(cid, year, month, true);
        res.send(
            JSON.stringify({
                data,
                communityName: community.name,
                year,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/sankey-report:
 *   get:
 *     description: Retrieve accounting-data for all accounts of a specified cid
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
accounting.get("/community-flow", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const cid = req.query.cid;
        const community = await db.getCommunity(cid);

        let data;
        if (req.query.startYear !== undefined) {
            // Range mode
            data = await getCommunityFlowDataRange(
                cid,
                parseInt(req.query.startYear),
                parseInt(req.query.startMonth),
                parseInt(req.query.endYear),
                parseInt(req.query.endMonth)
            );
        } else {
            // Backward-compatible single month
            data = await getCommunityFlowData(
                cid,
                parseInt(req.query.year),
                parseInt(req.query.month)
            );
        }

        res.send(
            JSON.stringify({
                ...data,
                communityName: community.name,
            })
        );
    } catch (e) {
        next(e);
    }
});

accounting.get("/circularity", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const cid = req.query.cid;
        const community = await db.getCommunity(cid);
        const data = await getCircularityTimeSeries(cid);
        res.send(
            JSON.stringify({
                data,
                communityName: community.name,
            })
        );
    } catch (e) {
        next(e);
    }
});

accounting.get("/sankey-report", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        const api = req.app.get("api");
        const cid = req.query.cid;
        const start = Math.max(parseInt(req.query.start), 1651156848222);
        const end = parseInt(req.query.end);
        const account = req.query.account;

        const community = await db.getCommunity(cid);
        const communityName = community.name;

        const startBlockNumber = await getBlockNumberByTimestamp(start);
        const endBlockNumber = await getBlockNumberByTimestamp(end);

        let acceptancePointAddresses = await db.getAcceptancePointAddresses(
            cid
        );
        // encointer verein address, this is aleadry accounted for as lea buy back
        acceptancePointAddresses = acceptancePointAddresses.filter(
            (a) => a !== "EG6vZCnvhQPSJRVxorae4xoP5jZKyMQMahYRQfFDyG21KJC"
        );
        acceptancePointAddresses = [...new Set(acceptancePointAddresses)];

        let data, accountName;
        if (account === "all") {
            accountName = "all biz accounts";
            let allResults = await Promise.all(
                acceptancePointAddresses.map((a) =>
                    getSankeyReport(
                        api,
                        cid,
                        a,
                        start,
                        end,
                        startBlockNumber,
                        endBlockNumber,
                        acceptancePointAddresses
                    )
                )
            );
            data = reduceObjects(allResults);
        } else {
            let allAccounts = await db.getAllUsers();
            accountName = allAccounts.find((e) => e.address === account).name;
            data = await getSankeyReport(
                api,
                cid,
                account,
                start,
                end,
                startBlockNumber,
                endBlockNumber,
                acceptancePointAddresses
            );
        }

        res.send(
            JSON.stringify({
                data,
                communityName,
                accountName,
            })
        );
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/accounting/swap-option-analysis:
 *   get:
 *     description: Retrieve swap option analysis for a community treasury
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
 */
// Parse on-chain integer values that may be comma-formatted strings, plain numbers, or hex
function parseChainInt(val) {
    if (val == null) return 0;
    if (typeof val === "number") return val;
    if (typeof val === "bigint") return Number(val);
    if (typeof val === "string") return parseInt(val.replace(/,/g, ""), 10) || 0;
    return 0;
}

// Parse FixedI64F64 { bits: i128 } → float
function parseFixedI64F64(val) {
    if (val == null) return null;
    const bits = typeof val === "object" && val.bits !== undefined ? val.bits : val;
    if (bits == null) return null;
    const n = BigInt(typeof bits === "string" ? bits.replace(/,/g, "") : bits);
    const intPart = Number(n >> 64n);
    const fracPart = Number(n & ((1n << 64n) - 1n)) / 2 ** 64;
    return intPart + fracPart;
}

accounting.get("/swap-option-analysis", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const assetHubApi = req.app.get("assetHubApi");
        const cid = req.query.cid;

        const treasury = getTreasuryByCid(cid);
        if (!treasury) {
            res.status(400).send(JSON.stringify({ error: `No treasury configured for cid ${cid}` }));
            return;
        }

        const cidDecoded = parseCid(cid);

        // --- Balances, on-chain swap options, proposals, events, scheduler in parallel ---
        const [
            accountInfo,
            usdcAccountRaw,
            nativeOptionsRaw,
            assetOptionsRaw,
            proposalCount,
            /* currentPhase */ ,
            nextPhaseTimestampRaw,
            spends,
            incoming,
            swapOptionEvents,
        ] = await Promise.all([
            api.query.system.account(treasury.address),
            treasury.kahAccount && assetHubApi
                ? assetHubApi.query.foreignAssets.account(USDC_FOREIGN_ASSET_ID, treasury.kahAccount)
                    .then((r) => r.toJSON())
                    .catch(() => null)
                : Promise.resolve(null),
            api.query.encointerTreasuries.swapNativeOptions.entries(cidDecoded).catch(() => []),
            api.query.encointerTreasuries.swapAssetOptions.entries(cidDecoded).catch(() => []),
            api.query.encointerDemocracy.proposalCount().then((c) => c.toJSON() || 0),
            api.query.encointerScheduler.currentPhase().then((p) => p.toJSON()),
            api.query.encointerScheduler.nextPhaseTimestamp().then((t) => t.toJSON()),
            db.getTreasurySpendsByTreasury(treasury.address, 0, Date.now()),
            db.incomingTreasuryTxns(treasury.address, treasury.kahAccount, 0, Date.now()),
            db.getSwapOptionEvents(treasury.address, 0, Date.now()),
        ]);

        // --- KSM balance ---
        const ksmBalance = Number(accountInfo.data.free.toBigInt()) / 1e12;

        // --- USDC balance ---
        const usdcBalance = usdcAccountRaw?.balance
            ? parseChainInt(usdcAccountRaw.balance) / Math.pow(10, USDC_DECIMALS)
            : 0;

        // --- Active on-chain swap options ---
        const activeNativeOptions = nativeOptionsRaw.map(([key, val]) => {
            const option = val.toJSON();
            const keyArgs = key.args.map((a) => a.toJSON());
            return {
                beneficiary: keyArgs[1],
                remainingAllowance: option.nativeAllowance != null
                    ? parseChainInt(option.nativeAllowance) / 1e12
                    : null,
                rate: parseFixedI64F64(option.rate),
                doBurn: option.doBurn ?? null,
                validFrom: option.validFrom ?? null,
                validUntil: option.validUntil ?? null,
            };
        });

        const activeAssetOptions = assetOptionsRaw.map(([key, val]) => {
            const option = val.toJSON();
            const keyArgs = key.args.map((a) => a.toJSON());
            return {
                beneficiary: keyArgs[1],
                remainingAllowance: option.assetAllowance != null
                    ? parseChainInt(option.assetAllowance) / Math.pow(10, USDC_DECIMALS)
                    : null,
                rate: parseFixedI64F64(option.rate),
                doBurn: option.doBurn ?? null,
                validFrom: option.validFrom ?? null,
                validUntil: option.validUntil ?? null,
            };
        });

        // --- Proposals (swap options only, for this community) ---
        const allCommunities = await db.getAllCommunities();
        const cidNameMap = {};
        for (const c of allCommunities) cidNameMap[c.cid] = c.name;

        const nativeProposals = [];
        const assetProposals = [];

        for (let id = 1; id <= proposalCount; id++) {
            const cached = await db.getFromGeneralCache("governance-proposal", { id });
            let proposal, state;
            if (cached.length > 0) {
                const c = cached[0];
                if (c.communityId !== cid) continue;
                if (c.actionType !== "issueSwapNativeOption" && c.actionType !== "issueSwapAssetOption") continue;
                // Fetch on-chain data to get action details (beneficiary, allowance, rate)
                const proposalRawCached = await api.query.encointerDemocracy.proposals(id);
                let beneficiary = null, allowance = null, rate = null, doBurn = null, validFrom = null, validUntil = null;
                if (proposalRawCached.isSome) {
                    const pCached = proposalRawCached.toJSON();
                    const args = pCached.action[c.actionType];
                    if (args) {
                        beneficiary = args[1];
                        const optionData = args[2];
                        const isNative = c.actionType === "issueSwapNativeOption";
                        const decimals = isNative ? 12 : USDC_DECIMALS;
                        const allowanceKey = isNative ? "nativeAllowance" : "assetAllowance";
                        allowance = optionData?.[allowanceKey] != null
                            ? parseChainInt(optionData[allowanceKey]) / Math.pow(10, decimals)
                            : null;
                        rate = parseFixedI64F64(optionData?.rate);
                        doBurn = optionData?.doBurn ?? null;
                        validFrom = optionData?.validFrom ?? null;
                        validUntil = optionData?.validUntil ?? null;
                    }
                }
                const entry = {
                    id: c.id,
                    state: c.state,
                    passing: c.passing,
                    actionType: c.actionType,
                    actionSummary: c.actionSummary,
                    beneficiary, allowance, rate, doBurn, validFrom, validUntil,
                };
                if (c.actionType === "issueSwapNativeOption") nativeProposals.push(entry);
                else assetProposals.push(entry);
                continue;
            }

            const proposalRaw = await api.query.encointerDemocracy.proposals(id);
            if (proposalRaw.isNone) continue;
            proposal = proposalRaw.toJSON();
            state = proposal.state;
            const aType = actionType(proposal.action);
            if (aType !== "issueSwapNativeOption" && aType !== "issueSwapAssetOption") continue;
            if (actionCommunityId(proposal.action) !== cid) continue;

            const args = proposal.action[aType];
            const beneficiary = args[1];
            const optionData = args[2];

            const sLabel = stateLabel(state);

            // Cache terminal proposals (same as governance.js)
            if (isTerminal(state)) {
                const tallyRaw = await api.query.encointerDemocracy.tallies(id);
                const tally = tallyRaw.isSome ? tallyRaw.toJSON() : { turnout: 0, ayes: 0 };
                const electorate = proposal.electorateSize || proposal.electorate_size || 0;
                const turnout = tally.turnout || 0;
                const ayes = tally.ayes || 0;
                const turnoutPct = electorate > 0 ? (turnout / electorate) * 100 : 0;
                const approvalPct = turnout > 0 ? (ayes / turnout) * 100 : 0;
                const sqrtE = Math.sqrt(electorate);
                const sqrtT = Math.sqrt(turnout);
                const thresholdPct = sqrtE + sqrtT > 0 ? (sqrtE / (sqrtE + sqrtT)) * 100 : 100;
                await db.insertIntoGeneralCache("governance-proposal", { id }, {
                    id,
                    start: proposal.start || proposal.startMoment,
                    startCindex: proposal.startCindex || proposal.start_cindex,
                    actionType: aType,
                    actionSummary: `${aType === "issueSwapNativeOption" ? "Issue swap native option" : "Issue swap asset option"} for ${cidNameMap[cid] || cid}`,
                    communityId: cid,
                    communityName: cidNameMap[cid] || null,
                    state: sLabel,
                    electorateSize: electorate,
                    turnout, ayes, nays: turnout - ayes,
                    turnoutPct: Math.round(turnoutPct * 10) / 10,
                    approvalPct: Math.round(approvalPct * 10) / 10,
                    thresholdPct: Math.round(thresholdPct * 10) / 10,
                    passing: approvalPct >= thresholdPct && turnout > 0,
                });
            }

            // For non-terminal, compute passing
            let passing = false;
            if (!isTerminal(state)) {
                const tallyRaw = await api.query.encointerDemocracy.tallies(id);
                const tally = tallyRaw.isSome ? tallyRaw.toJSON() : { turnout: 0, ayes: 0 };
                const electorate = proposal.electorateSize || proposal.electorate_size || 0;
                const turnout = tally.turnout || 0;
                const ayes = tally.ayes || 0;
                const approvalPct = turnout > 0 ? (ayes / turnout) * 100 : 0;
                const sqrtE = Math.sqrt(electorate);
                const sqrtT = Math.sqrt(turnout);
                const thresholdPct = sqrtE + sqrtT > 0 ? (sqrtE / (sqrtE + sqrtT)) * 100 : 100;
                passing = approvalPct >= thresholdPct && turnout > 0;
            }

            const isNative = aType === "issueSwapNativeOption";
            const decimals = isNative ? 12 : USDC_DECIMALS;
            const allowanceKey = isNative ? "nativeAllowance" : "assetAllowance";
            const allowance = optionData?.[allowanceKey] != null
                ? parseChainInt(optionData[allowanceKey]) / Math.pow(10, decimals)
                : null;

            const entry = {
                id,
                state: sLabel,
                beneficiary,
                allowance,
                rate: parseFixedI64F64(optionData?.rate),
                doBurn: optionData?.doBurn ?? null,
                validFrom: optionData?.validFrom ?? null,
                validUntil: optionData?.validUntil ?? null,
                passing,
            };
            if (isNative) nativeProposals.push(entry);
            else assetProposals.push(entry);
        }

        // --- Treasury event history ---
        const nativeEvents = [];
        const assetEvents = [];

        for (const txn of incoming) {
            const nameAndDecimals = getAssetNameAndDecimals(txn.data.assetId);
            if (!nameAndDecimals) continue;
            const { name, decimals } = nameAndDecimals;
            const amount = parseInt(txn.data.amount.replace(/,/g, "")) / Math.pow(10, decimals);
            const event = { timestamp: txn.timestamp, type: "topup", amount, from: txn.data.from };
            if (name === "KSM") nativeEvents.push(event);
            else assetEvents.push({ ...event, assetName: name });
        }

        for (const spend of spends) {
            const nameAndDecimals = getAssetNameAndDecimals(spend.data.assetId);
            if (!nameAndDecimals) continue;
            const { name, decimals } = nameAndDecimals;
            const amount = parseInt(spend.data.amount.replace(/,/g, "")) / Math.pow(10, decimals);
            const event = {
                timestamp: spend.timestamp,
                type: "spend",
                amount,
                beneficiary: spend.data.beneficiary,
            };
            if (name === "KSM") nativeEvents.push(event);
            else assetEvents.push({ ...event, assetName: name });
        }

        for (const evt of swapOptionEvents) {
            const isNative = evt.method === "GrantedSwapNativeOption";
            const event = {
                timestamp: evt.timestamp,
                type: "option_granted",
                beneficiary: evt.data?.beneficiary,
            };
            if (isNative) nativeEvents.push(event);
            else assetEvents.push(event);
        }

        nativeEvents.sort((a, b) => a.timestamp - b.timestamp);
        assetEvents.sort((a, b) => a.timestamp - b.timestamp);

        // --- Enactment timing ---
        const nextEnactmentTimestamp = nextPhaseTimestampRaw || null;

        // --- Per-business statistics ---
        // Collect all unique beneficiaries from active options + proposals
        const beneficiarySet = new Set();
        for (const o of activeNativeOptions) if (o.beneficiary) beneficiarySet.add(o.beneficiary);
        for (const o of activeAssetOptions) if (o.beneficiary) beneficiarySet.add(o.beneficiary);
        for (const p of nativeProposals) if (p.beneficiary) beneficiarySet.add(p.beneficiary);
        for (const p of assetProposals) if (p.beneficiary) beneficiarySet.add(p.beneficiary);

        let businesses = [];
        if (beneficiarySet.size > 0) {
            const allUsers = await db.getAllUsers();
            const userMap = new Map(allUsers.map((u) => [u.address, u.name]));

            // CC transfers bucketed by calendar month boundaries
            const now = new Date();
            const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const threeMonthsStart = new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime();
            const [allTimeCCTransfers, allIssues] = await Promise.all([
                getAllTransfers(0, Date.now(), cid),
                getAllIssues(cid),
            ]);

            // Build per-account influx/outflow from CC transfers
            const influxCurrentMonth = new Map();
            const influx3m = new Map();
            const influxOlder = new Map();
            const edgeMap = new Map();
            const nodeIds = new Set();
            for (const t of allTimeCCTransfers) {
                const sender = t.data[1];
                const recipient = t.data[2];
                const amount = t.data[3];
                nodeIds.add(sender);
                nodeIds.add(recipient);
                if (t.timestamp >= currentMonthStart) {
                    influxCurrentMonth.set(recipient, (influxCurrentMonth.get(recipient) || 0) + amount);
                } else if (t.timestamp >= threeMonthsStart) {
                    influx3m.set(recipient, (influx3m.get(recipient) || 0) + amount);
                } else {
                    influxOlder.set(recipient, (influxOlder.get(recipient) || 0) + amount);
                }
                // Aggregate edges for circularity
                const key = `${sender}|${recipient}`;
                if (edgeMap.has(key)) {
                    edgeMap.get(key).amount += amount;
                } else {
                    edgeMap.set(key, { source: sender, target: recipient, amount });
                }
            }

            // Ceremony issuance (UBI) per account — all-time
            const ceremonyIssuance = new Map();
            for (const iss of allIssues) {
                const account = iss.data[1];
                const amount = iss.data[2];
                ceremonyIssuance.set(account, (ceremonyIssuance.get(account) || 0) + amount);
            }

            // Compute per-node circularity
            const edges = [...edgeMap.values()];
            const perNodeCirc = computePerNodeCircularity(edges);

            // Exercised amounts per beneficiary (from treasury spends)
            const exercisedNative = new Map();
            const exercisedAsset = new Map();
            for (const spend of spends) {
                const nd = getAssetNameAndDecimals(spend.data.assetId);
                if (!nd) continue;
                const { name, decimals } = nd;
                const amount = parseInt(spend.data.amount.replace(/,/g, "")) / Math.pow(10, decimals);
                const ben = spend.data.beneficiary;
                if (name === "KSM") exercisedNative.set(ben, (exercisedNative.get(ben) || 0) + amount);
                else exercisedAsset.set(ben, (exercisedAsset.get(ben) || 0) + amount);
            }

            businesses = [...beneficiarySet].map((addr) => {
                const activeNative = activeNativeOptions.filter((o) => o.beneficiary === addr)
                    .reduce((s, o) => s + (o.remainingAllowance || 0), 0);
                const activeAsset = activeAssetOptions.filter((o) => o.beneficiary === addr)
                    .reduce((s, o) => s + (o.remainingAllowance || 0), 0);
                const approvedNative = nativeProposals.filter((p) => p.beneficiary === addr && p.state === "Approved")
                    .reduce((s, p) => s + (p.allowance || 0), 0);
                const approvedAssetAmt = assetProposals.filter((p) => p.beneficiary === addr && p.state === "Approved")
                    .reduce((s, p) => s + (p.allowance || 0), 0);
                const proposedNative = nativeProposals.filter((p) => p.beneficiary === addr && (p.state === "Ongoing" || p.state === "Confirming"))
                    .reduce((s, p) => s + (p.allowance || 0), 0);
                const proposedAssetAmt = assetProposals.filter((p) => p.beneficiary === addr && (p.state === "Ongoing" || p.state === "Confirming"))
                    .reduce((s, p) => s + (p.allowance || 0), 0);

                const circ = perNodeCirc.get(addr) || { outflow2: 0, outflow3: 0, outflow4plus: 0, outflowNonCircular: 0, totalOutflow: 0 };

                return {
                    address: addr,
                    name: userMap.get(addr) || null,
                    swapOptions: {
                        native: {
                            exercised: exercisedNative.get(addr) || 0,
                            active: activeNative,
                            approved: approvedNative,
                            proposed: proposedNative,
                        },
                        asset: {
                            exercised: exercisedAsset.get(addr) || 0,
                            active: activeAsset,
                            approved: approvedAssetAmt,
                            proposed: proposedAssetAmt,
                        },
                    },
                    ccInfluxCurrentMonth: influxCurrentMonth.get(addr) || 0,
                    ccInflux3m: influx3m.get(addr) || 0,
                    ccInfluxOlder: influxOlder.get(addr) || 0,
                    ccCeremonyIssuance: ceremonyIssuance.get(addr) || 0,
                    ccOutflow: circ,
                };
            });
        }

        res.send(JSON.stringify({
            communityName: treasury.name,
            native: {
                currentBalance: ksmBalance,
                activeOptions: activeNativeOptions,
                proposals: nativeProposals,
                events: nativeEvents,
            },
            asset: {
                assetName: "USDC",
                currentBalance: usdcBalance,
                activeOptions: activeAssetOptions,
                proposals: assetProposals,
                events: assetEvents,
            },
            nextEnactmentTimestamp,
            businesses,
        }));
    } catch (e) {
        next(e);
    }
});

export default accounting;
