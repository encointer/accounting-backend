import { INDEXER_ENDPOINT } from "./consts.js";
import fetch from "node-fetch";

const INCOMING = 2;
const OUTGOING = 1;

async function graphQlQuery(query, variables) {
    let res = await fetch(INDEXER_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            query,
            variables,
        }),
    });
    return (await res.json()).data;
}

async function getClosestBlock(timestamp) {
    const query = `query Query($timestamp: BigFloat!){
        blocks(filter: {timestamp: {lessThanOrEqualTo:$timestamp}}, orderBy: TIMESTAMP_DESC, first:1) {
          nodes {
          blockHeight
          }
        }
      }`;

    return graphQlQuery(query, { timestamp });
}

async function getTransfers(start, end, address, cid, direction) {
    const query = `query Query($address: String!, $start: BigFloat!, $end: BigFloat!, $cid: String!){
        transferreds(filter: {arg${direction}: { equalTo: $address }, timestamp: {greaterThanOrEqualTo:$start, lessThanOrEqualTo:$end}, arg0: {equalTo: $cid} }, orderBy: TIMESTAMP_ASC) {
          nodes {
          id
          blockHeight
          timestamp
          arg0
          arg1
          arg2
          arg3
          }
        }
      }`;

    return graphQlQuery(query, { address, start, end, cid });
}

async function getIssues(start, end, address, cid) {
    const query = `query Query($address: String!, $start: BigFloat!, $end: BigFloat!, $cid: String!){
        issueds(filter: {arg1: { equalTo: $address }, timestamp: {greaterThanOrEqualTo:$start, lessThanOrEqualTo:$end}, arg0: {equalTo: $cid} }, orderBy: TIMESTAMP_ASC) {
          nodes {
          id
          blockHeight
          timestamp
          arg0
          arg1
          arg2
          }
        }
      }`;

    return graphQlQuery(query, { address, start, end, cid });
}

export async function getRewardsIssueds(cid) {
    const query = `query Query($cid: String!){
        rewardsIssueds(filter: {arg0: {equalTo: $cid} }, orderBy: TIMESTAMP_DESC) {
            nodes {
            id
            blockHeight
            timestamp
            arg0
            arg1
            arg2
            }
          }
      }`;

    return (await graphQlQuery(query, { cid })).rewardsIssueds.nodes;
}

export async function gatherTransactionData(start, end, address, cid) {
    let incoming = (await getTransfers(start, end, address, cid, INCOMING))
        .transferreds.nodes;
    const outgoing = (await getTransfers(start, end, address, cid, OUTGOING))
        .transferreds.nodes;

    // hack to exclude cid fuckup transactions
    // incoming = incoming.filter((e) => !excludeEvents.includes(e.id));

    const issues = (await getIssues(start, end, address, cid)).issueds.nodes;

    const sumIssues = issues.reduce((acc, cur) => acc + cur.arg2, 0);

    const sumIncoming = incoming.reduce((acc, cur) => acc + cur.arg3, 0);
    const sumOutgoing = outgoing.reduce((acc, cur) => acc + cur.arg3, 0);

    const numDistinctClients = new Set(incoming.map((e) => e.arg1)).size;
    return [
        incoming,
        outgoing,
        issues,
        sumIncoming,
        sumOutgoing,
        sumIssues,
        numDistinctClients,
    ];
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

export async function getBlockNumberByTimestamp(timestamp) {
    let block = (await getClosestBlock(timestamp)).blocks.nodes[0];
    return block.blockHeight;
}
