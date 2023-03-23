import { ApplicationCommandOptionType, ApplicationCommandType } from "discord.js";
import client from "./client.js";

const user = {
    type: ApplicationCommandOptionType.User,
    name: "user",
    description: "the user",
    required: true,
} as const;

await client.application.commands.set([
    {
        type: ApplicationCommandType.ChatInput,
        name: "donation-amount",
        description: "view or modify a user's stored donation amount",
        options: [
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "view",
                description: "view a user's current stats",
                options: [user],
            },
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "add",
                description: "add to a user's stored donation amount",
                options: [
                    user,
                    {
                        type: ApplicationCommandOptionType.Number,
                        name: "amount",
                        description: "the increment (can be negative)",
                        required: true,
                    },
                ],
            },
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "set",
                description: "set a user's stored donation amount",
                options: [
                    user,
                    {
                        type: ApplicationCommandOptionType.Number,
                        name: "amount",
                        description: "the final amount (non-negative)",
                        required: true,
                        minValue: 0,
                    },
                ],
            },
        ],
    },
    {
        type: ApplicationCommandType.ChatInput,
        name: "donation-history",
        description: "view a user's donation history",
        options: [user],
    },
    {
        type: ApplicationCommandType.ChatInput,
        name: "set-trusted",
        description: "set whether or not a user is trusted to alter/view donation records",
        options: [
            user,
            {
                type: ApplicationCommandOptionType.Boolean,
                name: "allow",
                description: "enable/disable",
                required: true,
            },
        ],
    },
    {
        type: ApplicationCommandType.ChatInput,
        name: "set-role",
        description: "set the donation role for this server (will not remove the previous role)",
        dmPermission: false,
        options: [
            {
                type: ApplicationCommandOptionType.Role,
                name: "role",
                description: "the role (leave blank to remove)",
                required: false,
            },
        ],
    },
]);

client.destroy();
process.exit(0);
