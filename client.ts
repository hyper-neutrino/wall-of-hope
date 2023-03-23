import { Client, IntentsBitField } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
    intents: IntentsBitField.Flags.Guilds | IntentsBitField.Flags.GuildMembers,
    allowedMentions: { parse: [] },
});

await client.login(process.env.TOKEN);

export default client;
