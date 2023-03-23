import { Collection, Document, MongoClient } from "mongodb";

const db_client: MongoClient = new MongoClient(process.env.MONGO_URI);
await db_client.connect();

const db = db_client.db();

export default new Proxy(
    {},
    {
        get(_, property: string, __): Collection<Document> {
            return db.collection(property);
        },
    }
) as Record<string, Collection<Document>>;
