import { parseEncointerBalance } from "@encointer/types";
import { CIDS } from "./consts.js";
import {
    gatherTransactionData,
    generateTxnLog,
    getBlockNumberByTimestamp,
    getRewardsIssueds,
} from "./graphQl.js";

function addToAccountDataCache(account, year, month, data) {
    ACCOUNT_DATA_CACHE[account] = ACCOUNT_DATA_CACHE[account] || {};
    ACCOUNT_DATA_CACHE[account][year] = ACCOUNT_DATA_CACHE[account][year] || {};
    ACCOUNT_DATA_CACHE[account][year][month] = data;
}

const ACCOUNT_DATA_CACHE = {};

const REWARDS_DATA_CACHE = {};

export async function gatherAccountingOverview(api, account, cid, year, month) {
    const cachedData = ACCOUNT_DATA_CACHE[account]?.[year];
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
            addToAccountDataCache(account, year, i, accountingData);
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
    const cidDecoded = CIDS[cid].cidDecoded;
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
    };
}

export async function gatherRewardsData(api, cid) {
    const cidData = CIDS[cid];
    const cidDecoded = cidData.cidDecoded;
    const rewardsIssueds = await getRewardsIssueds(cid);

    // sorting is important for chaching
    rewardsIssueds.sort((a, b) => b.timestamp - a.timestamp);

    const currentCindex = (
        await api.query.encointerScheduler.currentCeremonyIndex()
    ).toNumber();

    const rewardsIssuedsWithCindexAndNominalIncome = [];
    for (const issueEvent of rewardsIssueds) {
        // exclude rescue action event
        if(issueEvent.id === '1063138-1') continue
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
        if (REWARDS_DATA_CACHE[cid] && cindex in REWARDS_DATA_CACHE[cid]) break;
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
    if (REWARDS_DATA_CACHE[cid])
        result = { ...result, ...REWARDS_DATA_CACHE[cid] };

    const dataToBeCached = Object.fromEntries(
        Object.entries(result).filter(
            ([key]) => parseInt(key) < currentCindex - 1
        )
    );
    REWARDS_DATA_CACHE[cid] = dataToBeCached;

    return result;
}
