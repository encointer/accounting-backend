import { MongoClient } from "mongodb";
import bcrypt from "bcrypt";
import { getRandomPassword } from "./util.js";

class Database {
    constructor() {
        this.dbClient = new MongoClient(process.env.DB_URL, {
            ssl: true,
            sslValidate: true,
        });
        this.dataCache = this.dbClient.db("data_cache");
        this.accountData = this.dataCache.collection("account_data");
        this.rewardsData = this.dataCache.collection("rewards_data");

        this.main = this.dbClient.db("main");
        this.users = this.main.collection("users");
        this.communities = this.main.collection("communities");
    }

    async insertIntoAccountDataCache(account, year, month, data) {
        await this.accountData.replaceOne(
            { account, year, month },
            { account, year, month, data },
            {
                upsert: true,
            }
        );
    }

    async getFromAccountDataCache(account, year) {
        return (
            await (await this.accountData.find({ account, year })).toArray()
        ).map((e) => e.data);
    }

    async insertIntoRewardsDataCache(cid, data) {
        await this.rewardsData.replaceOne(
            { cid },
            { cid, data },
            {
                upsert: true,
            }
        );
    }

    async getFromRewardsDataCache(cid) {
        return this.rewardsData.findOne({ cid });
    }

    async checkUserCredentials(address, password) {
        const user = await this.users.findOne({ address });
        if (!user) return null;
        if (await bcrypt.compare(password, user.passwordHash)) return user;
    }

    async upsertUser(address, password, name, isAdmin = false) {
        await this.users.replaceOne(
            { address },
            {
                address,
                name,
                passwordHash: await bcrypt.hash(password, 10),
                isAdmin,
            },
            {
                upsert: true,
            }
        );
    }

    async createUser(address, name, cids) {
        if (await this.getUser(address)) throw Error("User Exists");
        const password = getRandomPassword();
        this.upsertUser(address, password, name);
        for (const cid of cids) {
            this.communities.updateOne(
                { cid },
                { $push: { accounts: address } }
            );
        }
        return password;
    }

    async deleteUser(address) {
        await this.users.deleteOne({ address });
        await this.communities.updateMany({}, { $pull: { accounts: address } });
    }

    async getUser(address) {
        return this.users.findOne(
            { address },
            { projection: { address: 1, name: 1, isAdmin: 1, _id: 0 } }
        );
    }

    async getAllUsers() {
        return this.users
            .find(
                {},
                { projection: { address: 1, name: 1, isAdmin: 1, _id: 0 } }
            )
            .toArray();
    }

    async getCommunityUsers(cid) {
        const community = await this.getCommunity(cid);
        return this.users
            .find({ address: { $in: community.accounts } })
            .toArray();
    }

    async getCommunity(cid) {
        return this.communities.findOne({ cid });
    }

    async getAllCommunities() {
        return this.communities
            .find({}, { projection: { cid: 1, name: 1, _id: 0 } })
            .toArray();
    }
}

const db = new Database();
export default db;
