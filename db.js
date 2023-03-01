import { MongoClient } from "mongodb";

class Database {
    constructor() {
        this.dbClient = new MongoClient(process.env.DB_URL, {
            ssl: true,
            sslValidate: true,
        });
        this.dataCache = this.dbClient.db("data_cache");
        this.accountData = this.dataCache.collection("account_data");
        this.rewardsData = this.dataCache.collection("rewards_data");
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
        return (await (await this.accountData.find({ account, year })).toArray()).map(e => e.data);
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
}

const db = new Database();
export default db;
