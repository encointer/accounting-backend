import { parseEncointerBalance } from "@encointer/types";
import db from "./db.js";
import {
    gatherTransactionData,
    getRewardsIssueds,
    getBlockNumberByTimestamp,
    getTransactionVolume,
    getAllIssues,
    getAllBlocksByBlockHeights,
    getReputableRegistrations,
    getAllTransfers,
} from "./graphQl.js";
import { getMonthName, mapRescueCids, parseCid } from "./util.js";

function canBeCached(month, year) {
    return monthIsOver(month, year);
}

function monthIsOver(month, year) {
    const now = new Date();
    const yearNow = now.getUTCFullYear();
    let monthNow = now.getUTCMonth();
    return year < yearNow || month < monthNow;
}

function monthIsInFuture(month, year) {
    const now = new Date();
    const yearNow = now.getUTCFullYear();
    let monthNow = now.getUTCMonth();
    return year > yearNow || (year === yearNow && month > monthNow);
}

function getMonthProgress() {
    const currentDate = new Date();

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();

    const currentDay = currentDate.getDate();

    const monthProgress = (currentDay / totalDaysInMonth);

    return monthProgress.toFixed(4);
}

export async function gatherAccountingOverview(
    api,
    account,
    cid,
    year,
    month,
    includeCurrentMonth = false
) {
    const now = new Date();
    const yearNow = now.getUTCFullYear();

    // we loop over all months including the last and then skip the last month computation at the end.
    if (year < yearNow) {
        includeCurrentMonth = false;
        month += 1;
    }

    const cachedData = await db.getFromAccountDataCache(account, year, cid);
    const data = [];
    // encointer started in june 2022
    const startMonth = year === 2022 ? 5 : 0;
    for (let i = startMonth; i < month; i++) {
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
            db.insertIntoAccountDataCache(
                account,
                year,
                i,
                cid,
                accountingData
            );
        }
    }
    if (includeCurrentMonth) {
        const currentMonthData = await getAccountingData(
            api,
            account,
            cid,
            year,
            month
        );
        data.push(currentMonthData);
    }
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

export async function getFirstBlockOfMonth(year, monthIndex) {
    const firstTimestamp = getFirstTimeStampOfMonth(year, monthIndex);
    const blockNumber = await getBlockNumberByTimestamp(firstTimestamp);

    return blockNumber;
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

export async function getSelectedRangeData(api, account, cid, start, end) {
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

    const startBalance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        await getBlockNumberByTimestamp(start)
    );

    const endBalance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        await getBlockNumberByTimestamp(end)
    );

    return {
        dailyDigest,
        startBalance,
        endBalance,
        incomeMinusExpenses: sumIncoming - sumOutgoing,
        sumIssues,
        numIncoming: incoming.length,
        numOutgoing: outgoing.length,
        sumIncoming,
        sumOutgoing,
        numIssues: issues.length,
        numDistinctClients,
        costDemurrage:
            startBalance + sumIncoming - sumOutgoing + sumIssues - endBalance,
        avgTxnValue: incoming.length > 0 ? sumIncoming / incoming.length : 0,
    };
}

async function enrichRewardsIssueds(api, rewardsIssueds, cachedData, cid) {
    // sorting is important for chaching
    // such that we can stop processing the events as soon
    // as the data from the given cycle is in the cache
    rewardsIssueds.sort((a, b) => b.timestamp - a.timestamp);

    const rewardsIssuedsWithCindexAndNominalIncome = [];

    for (const issueEvent of rewardsIssueds) {
        const h = await api.rpc.chain.getBlockHash(issueEvent.blockNumber);
        const apiAt = await api.at(h);

        let mappedCid = mapRescueCids(cid, parseInt(issueEvent.blockNumber));
        const cidDecoded = parseCid(mappedCid);
        let [nominalIncome, cindex, phase] = await apiAt.queryMulti([
            [apiAt.query.encointerCommunities.nominalIncome, cidDecoded],
            [apiAt.query.encointerScheduler.currentCeremonyIndex],
            [apiAt.query.encointerScheduler.currentPhase],
        ]);
        cindex = cindex.toNumber();

        issueEvent.cindex =
            phase.toHuman() === "Registering" ? cindex - 1 : cindex;
        issueEvent.nominalIncome = parseEncointerBalance(nominalIncome.bits);
        // we patch this because on chain the nominal income was not set during the first rescue ceremonie
        if (parseInt(issueEvent.blockNumber) === 808023)
            issueEvent.nominalIncome = 22;

        if (cachedData && cindex.toString() in cachedData) break;
        rewardsIssuedsWithCindexAndNominalIncome.push(issueEvent);
    }
    return rewardsIssuedsWithCindexAndNominalIncome;
}

function reduceRewardsIssuedsWithCindexAndNominalIncome(data) {
    return data.reduce((acc, cur) => {
        const cindex = cur.cindex;
        const numParticipants = parseInt(cur.data[2]);
        const nominalIncome = cur.nominalIncome;
        acc[cindex] = acc[cindex] || {};
        acc[cindex].numParticipants =
            (acc[cindex].numParticipants || 0) + numParticipants;
        acc[cindex].totalRewards =
            (acc[cindex].totalRewards || 0) + numParticipants * nominalIncome;
        return acc;
    }, {});
}

export async function gatherRewardsData(api, cid) {
    const rewardsIssueds = await getRewardsIssueds(cid);
    const currentCindex = (
        await api.query.encointerScheduler.currentCeremonyIndex()
    ).toNumber();

    const cachedData = (await db.getFromRewardsDataCache(cid))?.data;

    const rewardsIssuedsWithCindexAndNominalIncome = await enrichRewardsIssueds(
        api,
        rewardsIssueds,
        cachedData,
        cid
    );

    const newData = reduceRewardsIssuedsWithCindexAndNominalIncome(
        rewardsIssuedsWithCindexAndNominalIncome
    );

    let result = newData;
    if (cachedData) result = { ...result, ...cachedData };

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
        blockNumber: e.blockNumber.toString(),
        timestamp: e.timestamp.toString(),
        counterParty: e.data[1],
        amount: e.data[3],
    }));
    const outgoingLog = outgoing.map((e) => ({
        blockNumber: e.blockNumber.toString(),
        timestamp: e.timestamp.toString(),
        counterParty: e.data[2],
        amount: -e.data[3],
    }));
    const issuesLog = issues.map((e) => ({
        blockNumber: e.blockNumber.toString(),
        timestamp: e.timestamp.toString(),
        counterParty: "ISSUANCE",
        amount: e.data[2],
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

async function getTotalIssuance(api, cid, blockNumber) {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    cid = mapRescueCids(cid, blockNumber);
    const cidDecoded = parseCid(cid);
    return parseEncointerBalance(
        (
            await api.query.encointerBalances.totalIssuance.at(
                blockHash,
                cidDecoded
            )
        ).principal.bits
    );
}
export async function getMoneyVelocity(
    api,
    cid,
    year,
    month,
    useTotalVolume = false
) {
    if(monthIsInFuture(month, year)) throw Exception("month is in future")

    const monthOver = monthIsOver(month, year)
    const cachedData = await db.getFromGeneralCache("moneyVelocity", {
        cid,
        year,
        month,
    });
    if (cachedData.length === 1) return cachedData[0].moneyVelocity;

    let totalTurnoverOrVolume = 0;

    if (useTotalVolume) {
        totalTurnoverOrVolume = await getVolume(cid, year, month);
    } else {
        let accountingData;
        if (monthOver) {
            accountingData = await db.getFromAccountDataCacheByMonth(
                month,
                year,
                cid
            );
        } else {
            accountingData = await getAccountingData(
                api,
                account,
                cid,
                year,
                i
            );
        }

        totalTurnoverOrVolume = accountingData.reduce(
            (acc, cur) => acc + cur.sumIncoming,
            0
        );
    }

    const firstBlockOfMonth = await getFirstBlockOfMonth(year, month);
    const lastBlockOfMonth = await getLastBlockOfMonth(api, year, month);
    const totalIssuanceStart = await getTotalIssuance(
        api,
        cid,
        firstBlockOfMonth
    );
    const totalIssuanceEnd = await getTotalIssuance(api, cid, lastBlockOfMonth);

    console.log(totalIssuanceStart, totalIssuanceEnd)
    const averagetotalIssuance = (totalIssuanceStart + totalIssuanceEnd) * 0.5;

    if(!monthOver) {
        const monthProgress = getMonthProgress()
        if(monthProgress === 0) return 0
        totalTurnoverOrVolume /= monthProgress
    }

    const moneyVelocity = (totalTurnoverOrVolume * 12) / averagetotalIssuance;
    if (canBeCached(month, year)) {
        db.insertIntoGeneralCache(
            "moneyVelocity",
            { cid, year, month },
            { moneyVelocity }
        );
    }
    return moneyVelocity;
}

export async function getVolume(cid, year, month) {
    const cachedData = await db.getFromGeneralCache("transactionVolume", {
        cid,
        year,
        month,
    });
    if (cachedData.length === 1) return cachedData[0].transactionVolume;

    const start = getFirstTimeStampOfMonth(year, month);
    const end = getLastTimeStampOfMonth(year, month);
    const transactionVolume = await getTransactionVolume(cid, start, end);

    if (canBeCached(month, year)) {
        db.insertIntoGeneralCache(
            "transactionVolume",
            { cid, year, month },
            { transactionVolume }
        );
    }

    return transactionVolume;
}

async function getIssuedsWithCindex(cid) {
    const issueds = await getAllIssues(cid);
    const blocks = await getAllBlocksByBlockHeights([
        ...new Set(issueds.map((c) => c.blockNumber)),
    ]);
    issueds.forEach((i) => {
        let block = blocks.find((b) => b.height === i.blockNumber);
        i.cindex = block.cindex;
        if (block.phase === "REGISTERING") i.cindex--;
    });
    return issueds;
}

export async function getCumulativeRewardsData(api, cid) {
    const reputationLifetime =
        await api.query.encointerCeremonies.reputationLifetime();

    const issueds = await getIssuedsWithCindex(cid);

    const reputablesByCindex = issueds.reduce((acc, cur) => {
        acc[cur.cindex] = acc[cur.cindex] || [];
        acc[cur.cindex].push(cur.data[1]);
        return acc;
    }, {});

    const cumulativeReputables = {};

    Object.keys(reputablesByCindex).forEach((e) => {
        let cindex = parseInt(e);
        let minCindex = Math.max(1, cindex - reputationLifetime);
        let reputables = new Set();
        for (let i = minCindex; i <= cindex; i++) {
            (reputablesByCindex[`${i}`] || []).forEach((item) =>
                reputables.add(item)
            );
        }

        cumulativeReputables[e] = reputables.size;
    });

    return cumulativeReputables;
}

export async function getFrequencyOfAttendance(api, cid) {
    const reputationLifetime =
        await api.query.encointerCeremonies.reputationLifetime();

    const currentCindex = (
        await api.query.encointerScheduler.currentCeremonyIndex()
    ).toNumber();
    const issueds = await getIssuedsWithCindex(cid);
    const repuableRegistrations = await getReputableRegistrations(cid);

    const data = {};

    issueds.forEach((i) => {
        const address = i.data[1];
        data[address] = data[address] || {
            registrations: 0,
            reputations: 0,
            potentialCindexes: new Set(),
        };
        data[address].reputations += 1;
        for (let j = 1; j <= reputationLifetime; j++)
            data[address].potentialCindexes.add(
                Math.min(i.cindex + j, currentCindex)
            );
    });

    repuableRegistrations.forEach((r) => {
        data[r.data[2]] = data[r.data[2]] || {
            registrations: 0,
            reputations: 0,
            potentialCindexes: new Set(),
        };
        data[r.data[2]].registrations += 1;
    });

    const result = {};
    const numReputables = Object.keys(data).length;
    for (let i = 1; i <= 14; i++) {
        const denominator = 2 * i + 1;
        const cutoff = 2 / denominator;
        result[`${2}/${denominator}`] =
            Object.values(data).filter(
                (i) => i.registrations / i.potentialCindexes.size >= cutoff
            ).length / numReputables;
    }
    return result;
}

async function getTransactionActiviyData(cid, year, month) {
    const start = getFirstTimeStampOfMonth(year, month);
    const end = getLastTimeStampOfMonth(year, month);

    const voucherAddresses = await db.getVoucherAddresses(cid);
    const govAddresses = await db.getGovAddresses(cid);
    const acceptancePointAddresses = await db.getAcceptancePointAddresses(cid);

    const transfers = await getAllTransfers(start, end, cid);

    const totalTransactionCount = transfers.length;
    const voucherTransactionCount = transfers.filter((t) =>
        voucherAddresses.includes(t.data[2])
    ).length;
    const govTransactionCount = transfers.filter((t) =>
        govAddresses.includes(t.data[2])
    ).length;
    const acceptancePointTransactionCount = transfers.filter((t) =>
        acceptancePointAddresses.includes(t.data[2])
    ).length;

    return {
        month,
        voucherTransactionCount,
        govTransactionCount,
        acceptancePointTransactionCount,
        personalTransactionCount:
            totalTransactionCount -
            voucherTransactionCount -
            govTransactionCount -
            acceptancePointTransactionCount,
    };
}
export async function getTransactionActivityLog(
    cid,
    year,
    month,
    includeCurrentMonth = false
) {
    const now = new Date();
    const yearNow = now.getUTCFullYear();

    // we loop over all months including the last and then skip the last month computation at the end.
    if (year < yearNow) {
        includeCurrentMonth = false;
        month += 1;
    }

    const cachedData = await db.getFromGeneralCache("transactionActivity", {
        cid,
        year,
    });

    const data = [];
    // encointer started in june 2022
    const startMonth = year === 2022 ? 5 : 0;
    for (let i = startMonth; i < month; i++) {
        const cachedMonthItem = cachedData?.filter((e) => e.month === i)?.[0];

        if (cachedMonthItem) {
            data.push(cachedMonthItem);
        } else {
            const transactionActivityData = await getTransactionActiviyData(
                cid,
                year,
                i
            );
            data.push(transactionActivityData);

            db.insertIntoGeneralCache(
                "transactionActivity",
                { cid, year, month: i },
                transactionActivityData
            );
        }
    }
    if (includeCurrentMonth) {
        const currentMonthData = await getTransactionActiviyData(
            cid,
            year,
            month
        );
        data.push(currentMonthData);
    }
    return data;
}

export async function getSankeyReport(
    api,
    cid,
    account,
    start,
    end,
    startBlockNumber,
    endBlockNumber,
    acceptancePointAddresses
) {
    const [
        incoming,
        outgoing,
        issues,
        sumIncoming,
        sumOutgoing,
        sumIssues,
        numDistinctClients,
    ] = await gatherTransactionData(start, end, account, cid);

    const startBalance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        startBlockNumber
    );
    const endBalance = await getDemurrageAdjustedBalance(
        api,
        account,
        cid,
        endBlockNumber
    );

    const sum = (arr) => arr.reduce((partialSum, a) => partialSum + a, 0);
    const ciiToBiz = sumIssues;
    const b2bToBiz = sum(
        incoming
            .filter((e) => acceptancePointAddresses.includes(e.data[1]))
            .map((e) => e.data[3])
    );
    const retailToBiz = sumIncoming - b2bToBiz;
    const bizToSuppliers = sum(
        outgoing
            .filter((e) => acceptancePointAddresses.includes(e.data[2]))
            .map((e) => e.data[3])
    );
    const bizToLea = sum(
        outgoing
            .filter((e) =>
                [
                    "FD3mHcDJRGcKhT8gzbfiV7fuGnd7hHGdd1VMnYd6LiVv4np",
                    "5DkVGErvJLPTgec4C73Xk7boEVTKXJYDuCro2kPHkB3XGARh",
                    "EG6vZCnvhQPSJRVxorae4xoP5jZKyMQMahYRQfFDyG21KJC",
                ].includes(e.data[2])
            )
            .map((e) => e.data[3])
    );
    const bizToDemurrage =
        startBalance + sumIncoming + sumIssues - sumOutgoing - endBalance;
    const bizToUnknown = sumOutgoing - bizToSuppliers - bizToLea;

    return {
        ciiToBiz,
        b2bToBiz,
        retailToBiz,
        bizToSuppliers,
        bizToLea,
        bizToDemurrage,
        bizToUnknown,
    };
}
