import express from "express";
import db from "../db.js";

const faucet = express.Router();

/**
 * @swagger
 * /v1/faucet/drips:
 *   get:
 *     description: Retrieve faucet drip statistics per community per month
 *     tags:
 *       - faucet
 *     responses:
 *          '200':
 *              description: Success
 *          '403':
 *              description: Permission denied
 *     security:
 *      - cookieAuth: []
 */
faucet.get("/drips", async function (req, res, next) {
    try {
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }

        const communities = await db.getAllCommunities();
        const cidToName = {};
        communities.forEach((c) => (cidToName[c.cid] = c.name));

        const matchStage = {
            $match: {
                section: "encointerFaucet",
                method: "drip",
                success: true,
            },
        };

        const [monthlyResults, uniqueResults] = await Promise.all([
            db.extrinsics
                .aggregate([
                    matchStage,
                    {
                        $group: {
                            _id: {
                                cid: "$args.cid",
                                month: {
                                    $dateToString: {
                                        format: "%Y-%m",
                                        date: { $toDate: "$timestamp" },
                                    },
                                },
                            },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { "_id.month": 1 } },
                ])
                .toArray(),
            db.extrinsics
                .aggregate([
                    matchStage,
                    {
                        $group: {
                            _id: {
                                cid: "$args.cid",
                                signer: "$signer.Id",
                            },
                        },
                    },
                    {
                        $group: {
                            _id: "$_id.cid",
                            count: { $sum: 1 },
                        },
                    },
                ])
                .toArray(),
        ]);

        const monthlyDrips = {};
        for (const r of monthlyResults) {
            const name = cidToName[r._id.cid] || r._id.cid;
            const month = r._id.month;
            if (!monthlyDrips[month]) monthlyDrips[month] = {};
            monthlyDrips[month][name] = r.count;
        }

        const uniqueDrippers = {};
        for (const r of uniqueResults) {
            const name = cidToName[r._id] || r._id;
            uniqueDrippers[name] = r.count;
        }

        const communityNames = [
            ...new Set(
                monthlyResults.map((r) => cidToName[r._id.cid] || r._id.cid)
            ),
        ];

        res.send(
            JSON.stringify({
                monthlyDrips,
                uniqueDrippers,
                communities: communityNames,
            })
        );
    } catch (e) {
        next(e);
    }
});

export default faucet;
