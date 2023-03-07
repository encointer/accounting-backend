import { parseEncointerBalance } from "@encointer/types";
import { parse } from "dotenv";
import db from "./db.js";
import {
    gatherTransactionData,
    getRewardsIssueds,
    getBlockNumberByTimestamp,
} from "./graphQl.js";
import { getMonthName, parseCid } from "./util.js";

export async function gatherAccountingOverview(api, account, cid, year, month) {
    const cachedData = await db.getFromAccountDataCache(account, year);
    const data = [];
    for (let i = 0; i < month; i++) {
        const cachedMonthItem = cachedData?.filter((e) => e.month === i)?.[0];
        if (cachedMonthItem) {
            data.push(cachedMonthItem);
        } else {
            const accountingData = await getAccountingData(
                api,
                account,
                cid,
                year,
                i
            );
            data.push(accountingData);
            db.insertIntoAccountDataCache(account, year, i, accountingData);
        }
    }
    data.push(await getAccountingData(api, account, cid, year, month));
    return data;
}

async function getBalance(api, cid, address, at) {
    const balanceEntry = await api.query.encointerBalances.balance.at(
        at,
        cid,
        address
    );
    return {
        principal: parseEncointerBalance(balanceEntry.principal.bits),
        lastUpdate: balanceEntry.lastUpdate.toNumber(),
    };
}

export async function getDemurragePerBlock(api, cid, at) {
    const demurragePerBlock =
        await api.query.encointerBalances.demurragePerBlock.at(at, cid);
    return parseEncointerBalance(demurragePerBlock.bits);
}

function getLastTimeStampOfMonth(year, monthIndex) {
    return new Date(
        Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999)
    ).getTime();
}

function getFirstTimeStampOfMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex)).getTime();
}

export async function getLastBlockOfMonth(api, year, monthIndex) {
    const lastTimestamp = getLastTimeStampOfMonth(year, monthIndex);
    if (new Date() < new Date(lastTimestamp)) {
        // we are not at the end of the month yet, so we return the current blocknumber
        return (await api.rpc.chain.getBlock()).block.header.number;
    }
    const blockNumber = await getBlockNumberByTimestamp(lastTimestamp);

    return blockNumber;
}

export function applyDemurrage(principal, elapsedBlocks, demurragePerBlock) {
    return principal * Math.exp(-demurragePerBlock * elapsedBlocks);
}

async function getDemurrageAdjustedBalance(api, address, cid, blockNumber) {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const cidDecoded = parseCid(cid);
    let balanceEntry = await getBalance(api, cidDecoded, address, blockHash);

    const demurragePerBlock = await getDemurragePerBlock(
        api,
        cidDecoded,
        blockHash
    );
    const balance = applyDemurrage(
        balanceEntry.principal,
        blockNumber - balanceEntry.lastUpdate,
        demurragePerBlock
    );
    return balance;
}

export async function getAccountingData(api, account, cid, year, month) {
    const start = getFirstTimeStampOfMonth(year, month);
    const end = getLastTimeStampOfMonth(year, month);
    const lastBlockOfMonth = await getLastBlockOfMonth(api, year, month);
    const lastBlockOfPreviousMonth = await getLastBlockOfMonth(
        api,
        year,
        month - 1
    );

    const [
        incoming,
        outgoing,
        issues,
        sumIncoming,
        sumOutgoing,
        sumIssues,
        numDistinctClients,
    ] = await gatherTransactionData(start, end, account, cid);

    const txnLog = generateTxnLog(incoming, outgoing, issues);
    const dailyDigest = generateDailyDigestFromTxnLog(txnLog);

    const balance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        lastBlockOfMonth
    );
    const previousBalance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        lastBlockOfPreviousMonth
    );

    return {
        month,
        incomeMinusExpenses: sumIncoming - sumOutgoing,
        sumIssues,
        balance,
        numIncoming: incoming.length,
        numOutgoing: outgoing.length,
        sumIncoming,
        sumOutgoing,
        numIssues: issues.length,
        numDistinctClients,
        costDemurrage:
            previousBalance + sumIncoming - sumOutgoing + sumIssues - balance,
        avgTxnValue: incoming.length > 0 ? sumIncoming / incoming.length : 0,
        txnLog,
        dailyDigest,
    };
}

export async function gatherRewardsData(api, cid) {
    const cidDecoded = parseCid(cid);
    const rewardsIssueds = await getRewardsIssueds(cid);

    // sorting is important for chaching
    rewardsIssueds.sort((a, b) => b.timestamp - a.timestamp);

    const currentCindex = (
        await api.query.encointerScheduler.currentCeremonyIndex()
    ).toNumber();

    const rewardsIssuedsWithCindexAndNominalIncome = [];

    const cachedData = (await db.getFromRewardsDataCache(cid))?.data;
    for (const issueEvent of rewardsIssueds) {
        // exclude rescue action event
        if (issueEvent.id === "1063138-1") continue;
        const h = await api.rpc.chain.getBlockHash(issueEvent.blockHeight);
        const apiAt = await api.at(h);

        let [nominalIncome, cindex, phase] = await apiAt.queryMulti([
            [apiAt.query.encointerCommunities.nominalIncome, cidDecoded],
            [apiAt.query.encointerScheduler.currentCeremonyIndex],
            [apiAt.query.encointerScheduler.currentPhase],
        ]);

        cindex = cindex.toNumber();

        issueEvent.cindex =
            phase.toHuman() === "Registering" ? cindex - 1 : cindex;
        issueEvent.nominalIncome = parseEncointerBalance(nominalIncome.bits);

        if (cachedData && cindex.toString() in cachedData) break;
        rewardsIssuedsWithCindexAndNominalIncome.push(issueEvent);
    }

    const newData = rewardsIssuedsWithCindexAndNominalIncome.reduce(
        (acc, cur) => {
            const cindex = cur.cindex;
            const numParticipants = parseInt(cur.arg2);
            const nominalIncome = cur.nominalIncome;
            acc[cindex] = acc[cindex] || {};
            acc[cindex].numParticipants =
                (acc[cindex].numParticipants || 0) + numParticipants;
            acc[cindex].totalRewards =
                (acc[cindex].totalRewards || 0) +
                numParticipants * nominalIncome;
            return acc;
        },
        {}
    );

    let result = newData;
    if (cachedData)
        result = { ...result, ...cachedData };

    // cache only data that is sure not to change anymore
    const dataToBeCached = Object.fromEntries(
        Object.entries(result).filter(
            ([key]) => parseInt(key) < currentCindex - 1
        )
    );
    db.insertIntoRewardsDataCache(cid, dataToBeCached);

    return result;
}

export function generateTxnLog(incoming, outgoing, issues) {
    const incomingLog = incoming.map((e) => ({
        blockNumber: e.blockHeight,
        timestamp: e.timestamp,
        counterParty: e.arg1,
        amount: e.arg3,
    }));
    const outgoingLog = outgoing.map((e) => ({
        blockNumber: e.blockHeight,
        timestamp: e.timestamp,
        counterParty: e.arg2,
        amount: -e.arg3,
    }));
    const issuesLog = issues.map((e) => ({
        blockNumber: e.blockHeight,
        timestamp: e.timestamp,
        counterParty: "ISSUANCE",
        amount: e.arg2,
    }));
    const txnLog = incomingLog.concat(outgoingLog).concat(issuesLog);
    txnLog.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    return txnLog;
}

function groupTransactionsByDay(txnLog) {
    return txnLog.reduce((acc, cur) => {
        const d = new Date(parseInt(cur.timestamp));
        const dayString = `${getMonthName(d.getUTCMonth())} ${d.getUTCDate()}`;
        acc[dayString] = acc[dayString] || [];
        acc[dayString].push(cur);
        return acc;
    }, {});
}

function generateDailyDigestFromTxnLog(txnLog) {
    const groupedTransactions = groupTransactionsByDay(txnLog);
    const result = {};

    for (const [dayString, txns] of Object.entries(groupedTransactions)) {
        let sumIncoming = 0;
        let numIncoming = 0;
        let sumOutgoing = 0;
        let numOutgoing = 0;
        let sumIssues = 0;
        let numIssues = 0;

        const distinctClients = new Set();
        for (const txn of txns) {
            if (txn.amount > 0) {
                if (txn.counterParty === "ISSUANCE") {
                    numIssues++;
                    sumIssues += txn.amount;
                } else {
                    numIncoming++;
                    sumIncoming += txn.amount;
                    distinctClients.add(txn.counterParty);
                }
            } else {
                numOutgoing++;
                sumOutgoing += -txn.amount;
            }
        }
        result[dayString] = {
            sumIncoming,
            numIncoming,
            sumOutgoing,
            numOutgoing,
            sumIssues,
            numIssues,
            numDistinctClients: distinctClients.size,
            avgTxnValue: numIncoming ? sumIncoming / numIncoming : 0,
        };
    }
    return result;
}
