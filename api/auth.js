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
        req.session.isReadonlyAdmin = user.isReadonlyAdmin;
        req.session.name = user.name;
        res.send(
            JSON.stringify({
                address: user.address,
                isAdmin: user.isAdmin,
                isReadonlyAdmin: user.isReadonlyAdmin,
                name: user.name,
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
                isReadonlyAdmin: req.session.isReadonlyAdmin,
                name: req.session.name,
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
        req.session.name = user.name;
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

auth.post("/change-password", async function (req, res, next) {
    try {
        const address = req.session.address;
        const password = req.body.password;
        const newPassword = req.body.newPassword;
        const user = await db.checkUserCredentials(address, password);
        if (!user) {
            res.sendStatus(403);
            return;
        }
        await db.setPassword(address, newPassword);
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
        if (!req.session.isReadonlyAdmin) {
            res.sendStatus(403);
            return;
        }
        res.send(JSON.stringify(await db.getAllUsers()));
    } catch (e) {
        next(e);
    }
});

auth.patch("/users", async function (req, res, next) {
    try {
        if (!req.session.isAdmin) {
            res.sendStatus(403);
            return;
        }
        const address = req.body.address;
        const name = req.body.name;
        const cids = req.body.cids;
        await db.updateUser(address, name, cids);
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

export default auth;
