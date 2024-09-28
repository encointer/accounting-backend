import db from "./db.js";

const INCOMING = 2;
const OUTGOING = 1;

export async function getBlock(height) {
    return db.blocks.findOne({ height });
}

export async function getClosestBlock(timestamp) {
    return db.blocks.findOne(
        { timestamp: { $lte: timestamp } },
        { sort: { timestamp: -1 } }
    );
}

export async function getAllTransfers(start, end, cid) {
    const cursor = await db.indexer.collection("events").find(
        {
            section: "encointerBalances",
            method: "Transferred",
            "data.0": cid,
            timestamp: { $gte: start, $lte: end },
        },
        { sort: { timestamp: 1 } }
    );
    return await cursor.toArray();
}

export async function getAllNativeTransfers(start, end) {
    const cursor = await db.indexer.collection("extrinsics").find(
      {
          section: "balances",
          $or: [
              { method: "transferKeepAlive" },
              { method: "transferAllowDeath" },
              { method: "transfer" }
          ],
          timestamp: { $gte: start, $lte: end },
      },
      { sort: { timestamp: 1 } }
    );
    return await cursor.toArray();
}

export async function getTransfers(start, end, address, cid, direction) {
    let query = {
        section: "encointerBalances",
        method: "Transferred",
        "data.0": cid,
        timestamp: { $gte: start, $lte: end },
    };
    query[`data.${direction}`] = address;
    const cursor = await db.indexer
        .collection("events")
        .find(query, { sort: { timestamp: 1 } });
    return await cursor.toArray();
}

export async function getNativeTransfers(start, end, address, cid, direction) {
    let query = {
        section: "balances",
        $or: [
            { method: "transferKeepAlive" },
            { method: "transferAllowDeath" },
            { method: "transfer" }
        ],
        timestamp: { $gte: start, $lte: end },
    };
    if (direction === INCOMING) {
        query["args.dest.Id"] = address;
    } else {
        query["signer.Id"] = address;
    }
    const cursor = await db.indexer
      .collection("extrinsics")
      .find(query, { sort: { timestamp: 1 } });
    return await cursor.toArray();
}

async function getIssues(start, end, address, cid) {
    const cursor = await db.indexer.collection("events").find(
        {
            section: "encointerBalances",
            method: "Issued",
            "data.1": address,
            "data.0": cid,
            timestamp: { $gte: start, $lte: end },
        },
        { sort: { timestamp: 1 } }
    );
    return await cursor.toArray();
}

export async function getAllIssues(cid) {
    const cursor = await db.indexer.collection("events").find(
        {
            section: "encointerBalances",
            method: "Issued",
            "data.0": cid,
        },
        { sort: { timestamp: 1 } }
    );
    return await cursor.toArray();
}

export async function getRewardsIssueds(cid) {
    const cursor = await db.events.find(
        {
            section: "encointerCeremonies",
            method: "RewardsIssued",
            "data.0": cid,
        },
        { sort: { timestamp: -1 } }
    );
    return await cursor.toArray();
}

export async function getBlocksByBlockHeights(heights) {
    const cursor = await db.indexer.collection("blocks").find({
        height: { $in: heights },
    });
    return await cursor.toArray();
}

export async function getReputableRegistrations(cid) {
    const cursor = await db.events.find({
        section: "encointerCeremonies",
        method: "ParticipantRegistered",
        "data.0": cid,
        "data.1": { $in: ["Reputable", "Bootstrapper"] },
    });
    return await cursor.toArray();
}

export async function gatherTransactionData(start, end, address, cid) {
    let incoming = await getTransfers(start, end, address, cid, INCOMING);
    const outgoing = await getTransfers(start, end, address, cid, OUTGOING);

    // hack to exclude cid fuckup transactions
    // const excludeEvents = ["1064499-1161", "820314-1", "819843-1", "1064499-275"];
    //  incoming = incoming.filter((e) => !excludeEvents.includes(e.id));

    const issues = await getIssues(start, end, address, cid);

    const sumIssues = issues.reduce((acc, cur) => acc + cur.data[2], 0);
    const sumIncoming = incoming.reduce((acc, cur) => acc + cur.data[3], 0);
    const sumOutgoing = outgoing.reduce((acc, cur) => acc + cur.data[3], 0);

    const numDistinctClients = new Set(incoming.map((e) => e.data[1])).size;
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

export async function gatherNativeTransactionData(start, end, address) {
    let incoming = await getNativeTransfers(start, end, address, INCOMING);
    const outgoing = await getNativeTransfers(start, end, address, OUTGOING);

    const sumIncoming = incoming.reduce((acc, cur) => acc + cur.args.value, 0);
    const sumOutgoing = outgoing.reduce((acc, cur) => acc + cur.args.value, 0);

    const numDistinctClients = new Set(incoming.map((e) => e.signer.Id)).size;
    return [
        incoming,
        outgoing,
        sumIncoming,
        sumOutgoing,
        numDistinctClients,
    ];
}

export async function getBlockNumberByTimestamp(timestamp) {
    let block = await getClosestBlock(timestamp);
    const blockNumber = block.height;
    return blockNumber;
}

export async function getTransactionVolume(cid, start, end) {
    return (await getAllTransfers(start, end, cid)).reduce(
        (acc, cur) => acc + cur.data[3],
        0
    );
}

const blockCache = {};
export async function getAllBlocksByBlockHeights(heights) {
    const result = [];
    const remainingHeights = [];
    heights.forEach((h) => {
        if (h in blockCache) {
            result.push(blockCache[h]);
        } else {
            remainingHeights.push(h);
        }
    });
    for (let i = 0; i < remainingHeights.length; i += 10) {
        let blocks = await getBlocksByBlockHeights(
            remainingHeights.slice(i, i + 10)
        );
        blocks.forEach((b) => (blockCache[b.blockHeight] = b));
        result.push(...blocks);
    }
    return result;
}
