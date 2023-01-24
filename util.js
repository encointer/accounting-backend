import { parseEncointerBalance } from "@encointer/types";
import { ACCOUNTS, CIDS } from "./consts.js";
import { gatherTransactionData, generateTxnLog } from "./graphQl.js";

const LAST_BLOCK_OF_MONTH_CACHE = {};

async function getBlockTimestamp(api, blockNumber) {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    return api.query.timestamp.now.at(blockHash);
}
// perform a binary search over all blocks to find the closest block below the timestamp
async function getBlockNumber(api, timestamp) {
    const currentBlockNumber = (
        await api.rpc.chain.getBlock()
    ).block.header.number.toNumber();

    let low = 0;
    let high = currentBlockNumber;

    while (high - low > 1) {
        let middle = Math.floor((low + high) / 2);
        if (timestamp < (await getBlockTimestamp(api, middle))) high = middle;
        else low = middle;
    }
    return low;
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

async function getDemurragePerBlock(api, cid, at) {
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
    if (
        year in LAST_BLOCK_OF_MONTH_CACHE &&
        monthIndex in LAST_BLOCK_OF_MONTH_CACHE[year]
    )
        return LAST_BLOCK_OF_MONTH_CACHE[year][monthIndex];
    const lastTimestamp = getLastTimeStampOfMonth(year, monthIndex);
    if (new Date() < new Date(lastTimestamp)) {
        // we are not at the end of the month yet, so we return the current blocknumber
        return (await api.rpc.chain.getBlock()).block.header.number;
    }
    const blockNumber = await getBlockNumber(api, lastTimestamp);

    if (!(year in LAST_BLOCK_OF_MONTH_CACHE))
        LAST_BLOCK_OF_MONTH_CACHE[year] = {};
    LAST_BLOCK_OF_MONTH_CACHE[year][monthIndex] = blockNumber;
    return blockNumber;
}

function applyDemurrage(principal, elapsedBlocks, demurragePerBlock) {
    return principal * Math.exp(-demurragePerBlock * elapsedBlocks);
}

async function getDemurrageAdjustedBalance(api, address, cid, blockNumber) {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const cidDecoded = CIDS[cid];
    let balanceEntry = await getBalance(api, cidDecoded, address, blockHash);

    const demurragePerBlock = await getDemurragePerBlock(api, cidDecoded, blockHash);
    const balance = applyDemurrage(
        balanceEntry.principal,
        blockNumber - balanceEntry.lastUpdate,
        demurragePerBlock
    );
    return balance;
}

function getDateString(timestamp) {
    return new Date(parseInt(timestamp)).toUTCString().replace(",", "");
}

export function validateAccountToken(account, token) {
    return ACCOUNTS[account].token === token;
}

export async function getAccountingData(api, account, cid, year, month) {
    const start = getFirstTimeStampOfMonth(year, month);
    const end = getLastTimeStampOfMonth(year, month);
    const lastBlockOfMonth = await getLastBlockOfMonth(api, year, month);
    const lastBlockOfPreviousMonth = await getLastBlockOfMonth(api, year, month - 1);

    const [incoming, outgoing, issues, incomeMinusExpenses, sumIssues, numDistinctClients] =
        await gatherTransactionData(start, end, account, cid);

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
        incomeMinusExpenses,
        sumIssues,
        balance,
        numIncoming: incoming.length,
        numOutgoing: outgoing.length,
        numIssues: issues.length,
        numDistinctClients,
        costDemurrage: previousBalance + incomeMinusExpenses + sumIssues - balance,
        txnLog
    };
}
