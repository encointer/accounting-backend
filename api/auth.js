import express from "express";
import db from "../db.js";
const auth = express.Router();

auth.post("/authenticate", async function (req, res, next) {
    try {
        const address = req.body.address;
        const password = req.body.password;
        const user = await db.checkUserCredentials(address, password);
        if (!user) {
            res.sendStatus(403);
            return;
        }
        req.session.address = user.address;
        req.session.isAdmin = user.isAdmin;
        res.send(
            JSON.stringify({
                address: user.address,
                isAdmin: user.isAdmin,
            })
        );
    } catch (e) {
        next(e);
    }
});

auth.get("/me", async function (req, res, next) {
    try {
        res.send(
            JSON.stringify({
                address: req.session.address,
                isAdmin: req.session.isAdmin,
            })
        );
    } catch (e) {
        next(e);
    }
});

auth.get("/logout", async function (req, res, next) {
    try {
        req.session = null;
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

auth.get("/login-as", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const user = await db.getUser(req.query.account);
        req.session.address = user.address;
        req.session.isAdmin = user.isAdmin;
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

auth.post("/users", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const address = req.body.address;
        const cids = req.body.cids;
        const name = req.body.name;
        const password = await db.createUser(address, name, cids);

        res.send(
            JSON.stringify({
                address,
                password,
            })
        );
    } catch (e) {
        next(e);
    }
});

auth.delete("/users", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const address = req.body.address;
        await db.deleteUser(address);
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

auth.get("/users", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        res.send(JSON.stringify(await db.getAllUsers()));
    } catch (e) {
        next(e);
    }
});

export default auth;
