import express from "express";
import db from "../db.js";

const bloque = express.Router();

const BLOQUE_API = "https://api.bloque.app";

async function bloqueConnect(alias) {
    const apiKey = process.env.BLOQUE_API_KEY;
    if (!apiKey) throw new Error("BLOQUE_API_KEY env variable not set");
    const res = await fetch(`${BLOQUE_API}/api/origins/encointer/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            assertion_result: {
                challengeType: "API_KEY",
                value: { api_key: apiKey, alias },
            },
            extra_context: {},
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw Object.assign(new Error(`Bloque connect failed: ${text}`), {
            status: res.status,
        });
    }
    const data = await res.json();
    return data.result?.access_token ?? data.access_token;
}

// Auth guard: require logged-in session
bloque.use((req, res, next) => {
    if (!req.session.address) {
        res.sendStatus(401);
        return;
    }
    next();
});

bloque.get("/accounts", async (req, res, next) => {
    try {
        const creds = await db.getBloqueCredentials(req.session.address);
        if (!creds) {
            res.sendStatus(404);
            return;
        }
        const token = await bloqueConnect(creds.alias);
        const params = new URLSearchParams({
            holder_urn: `did:bloque:encointer:${creds.alias}`,
        });
        if (req.query.medium) params.set("medium", req.query.medium);
        const apiRes = await fetch(
            `${BLOQUE_API}/api/accounts?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!apiRes.ok) {
            res.status(apiRes.status).send(await apiRes.text());
            return;
        }
        res.json(await apiRes.json());
    } catch (e) {
        next(e);
    }
});

bloque.get("/accounts/:urn/movements", async (req, res, next) => {
    try {
        const creds = await db.getBloqueCredentials(req.session.address);
        if (!creds) {
            res.sendStatus(404);
            return;
        }
        const token = await bloqueConnect(creds.alias);
        const params = new URLSearchParams({ asset: "DUSD/6", limit: "50" });
        for (const key of ["next", "after", "before", "direction"]) {
            if (req.query[key]) params.set(key, req.query[key]);
        }
        const apiRes = await fetch(
            `${BLOQUE_API}/api/accounts/${encodeURIComponent(req.params.urn)}/movements?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!apiRes.ok) {
            res.status(apiRes.status).send(await apiRes.text());
            return;
        }
        res.json(await apiRes.json());
    } catch (e) {
        next(e);
    }
});

bloque.put("/credentials", async (req, res, next) => {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const { address, alias } = req.body;
        if (!address || !alias) {
            res.status(400).send("address and alias are required");
            return;
        }
        await db.upsertBloqueCredentials(address, alias);
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

bloque.delete("/credentials", async (req, res, next) => {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const { address } = req.body;
        if (!address) {
            res.status(400).send("address is required");
            return;
        }
        await db.deleteBloqueCredentials(address);
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

export default bloque;
