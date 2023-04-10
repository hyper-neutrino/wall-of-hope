import {
    CommandInteraction,
    Events,
    GuildMember,
    Interaction,
    InteractionEditReplyOptions,
    InteractionReplyOptions,
    Message,
    MessageReplyOptions,
    PermissionFlagsBits,
} from "discord.js";
import client from "./client.js";
import db from "./db.js";

process.on("uncaughtException", (error) => console.log(error));

const _audit = await client.channels.fetch(process.env.AUDIT);
if (!_audit?.isTextBased()) throw "Invalid audit channel.";
const audit = (x: string) => _audit.send(`**[-]** ${x}`);

const guild = await client.guilds.fetch(process.env.GUILD);

const locked = new Set<string>();

client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    await new Promise((r) => setTimeout(r, 5000));

    const entry = await db.roles.findOne({ guild: member.guild.id });
    if (!entry?.role) return;

    if (await db.amounts.findOne({ user: member.id, amount: { $gt: 0 } }))
        try {
            await member.roles.add(entry.role);
        } catch {}
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "help") await interaction.deferReply({ ephemeral: true });

        if (interaction.commandName === "help") {
            await interaction.reply({
                content:
                    "`/donation-amount view <user>` - see how much a user has donated so far\n" +
                    "`/donation-amount add <user> <amount>` - modify the amount a user has donated so far (this can be negative if needed for some reason)\n" +
                    "`/donation-amount set <user> <amount>` - set the amount a user has donated so far (this must be at least 0)\n" +
                    "`/donation-history <user>` - check a user's donation records including who made what changes to the value\n" +
                    "`/set-role [role]` - set or remove this server's donator role, which will be updated in the background immediately including removing the old role\n",
                ephemeral: true,
            });
        } else if (interaction.commandName === "donation-amount") {
            if (!(await is_admin(interaction.user.id))) {
                await interaction.editReply({
                    content: "You do not have permission to use this command.",
                });

                return;
            }

            const user = interaction.options.getUser("user", true);
            const sub = interaction.options.getSubcommand();

            if (sub === "view") {
                const entry = await db.amounts.findOne({ user: user.id });

                await interaction.editReply({
                    content: `${user} has donated $${((entry?.amount ?? 0) as number).toFixed(2)} so far.`,
                });
            } else {
                if (locked.has(user.id)) {
                    await interaction.editReply({
                        content: "Updating this user is temporarily locked as their roles are being updated.",
                    });

                    return;
                }

                locked.add(user.id);

                const add = sub === "add";
                const amount = interaction.options.getNumber("amount", true);

                const entry = await db.amounts.findOneAndUpdate(
                    { user: user.id },
                    { [add ? "$inc" : "$set"]: { amount } },
                    { upsert: true }
                );

                await db.history.findOneAndUpdate(
                    { user: user.id },
                    {
                        $push: { history: { time: new Date(), user: interaction.user.id, action: sub, amount } },
                    } as unknown,
                    { upsert: true }
                );

                const old_amount = entry.value?.amount ?? 0;
                const new_amount = add ? old_amount + amount : amount;

                await audit(
                    `${interaction.user}: ${sub.toUpperCase()} ${user} $${amount.toFixed(2)} (${old_amount.toFixed(
                        2
                    )} => ${new_amount.toFixed(2)})`
                ).catch();

                await interaction.editReply({
                    content: add
                        ? `Added $${amount.toFixed(2)} to ${user}'s donation amount (it is now at $${new_amount.toFixed(
                              2
                          )}).`
                        : `Set ${user}'s donation amount from $${old_amount.toFixed(2)} to $${new_amount.toFixed(2)}.`,
                });

                if (old_amount > 0 !== new_amount > 0)
                    for (const entry of await db.roles.find().toArray())
                        try {
                            const guild = await client.guilds.fetch(entry.guild);
                            const member = await guild.members.fetch(user);

                            if (old_amount <= 0) await member.roles.add(entry.role);
                            else await member.roles.remove(entry.role);
                        } catch {}

                locked.delete(user.id);
            }
        } else if (interaction.commandName === "donation-history") {
            if (!(await is_admin(interaction.user.id))) {
                await interaction.editReply({
                    content: "You do not have permission to use this command.",
                });

                return;
            }

            const user = interaction.options.getUser("user");
            const history = await db.history.findOne({ user: user.id });

            if (!history?.history?.length) {
                await interaction.editReply({ content: `${user} has no recorded history.` });
                return;
            }

            let total = 0;

            for (let x = 0; x < history.history.length; x += 20) {
                const data: InteractionReplyOptions & InteractionEditReplyOptions = {
                    content: history.history
                        .slice(x, x + 20)
                        .map(
                            ({ time, user, action, amount }) =>
                                `<t:${Math.floor(time / 1000)}:F>: <@${user}> - ${action} $${amount.toFixed(
                                    2
                                )} ($${total.toFixed(2)} => $${(total =
                                    action === "set" ? amount : total + amount).toFixed()})`
                        )
                        .join("\n"),
                };

                if (x === 0) await interaction.editReply(data);
                else await interaction.followUp({ ...data, ephemeral: true });
            }
        } else if (interaction.commandName === "set-trusted") {
            if (interaction.user.id !== process.env.OWNER) {
                await interaction.editReply({
                    content: "You do not have permission to use this command.",
                });

                return;
            }

            const user = interaction.options.getUser("user");
            const allow = interaction.options.getBoolean("allow");

            if (allow) {
                const entry = await db.admins.findOneAndUpdate(
                    { user: user.id },
                    { $set: { user: user.id } },
                    { upsert: true }
                );

                await interaction.editReply({
                    content: entry.value ? `${user} was already an admin.` : `Promoted ${user} to an admin.`,
                });

                if (!entry.value) await audit(`Promoted ${user}.`);
            } else {
                const entry = await db.admins.findOneAndDelete({ user: user.id });

                await interaction.editReply({
                    content: entry.value ? `Demoted ${user} from admin.` : `${user} was not an admin.`,
                });

                if (entry.value) await audit(`Demoted ${user}.`);
            }
        } else if (interaction.commandName === "set-role") {
            await trigger_update(interaction, interaction.options.getRole("role")?.id);
        }
    }
});

client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guild) return;
    if (!message.member?.permissions?.has(PermissionFlagsBits.Administrator)) return;

    const match = message.content.match(/<@!?1088563988670992444>\s+(<@&(\d{17,20})>|(\d{17,20}))$/);
    if (!match) return;

    const id = match[2] ?? match[3];

    try {
        await message.guild.roles.fetch(id);
    } catch {
        await message.reply("Invalid ID.");
        return;
    }

    await trigger_update(message, id);
});

client.on(Events.MessageCreate, async (message: Message) => {
    if (message.channel.id !== "1090465892682432533") return;
    if (message.webhookId !== "1090468417489883156") return;

    try {
        const user = await client.users.fetch(message.embeds[0].description.split(">")[0].slice(2));
        const amount =
            message.embeds[0].footer.text === "No Amount Specified"
                ? 10
                : parseInt(message.embeds[0].footer.text.slice(1));

        const entry = await db.amounts.findOneAndUpdate({ user: user.id }, { $inc: { amount } }, { upsert: true });

        await db.history.findOneAndUpdate(
            { user: user.id },
            { $push: { history: { time: new Date(), user: "1088563988670992444", action: "add", amount } } } as unknown,
            { upsert: true }
        );

        const old_amount = entry.value?.amount ?? 0;
        const new_amount = old_amount + amount;

        await audit(
            `\`AUTO\`: ADD ${user} $${amount.toFixed(2)} (${old_amount.toFixed(2)} => ${new_amount.toFixed(2)})`
        ).catch();

        await message.react("✅");

        if (old_amount > 0 !== new_amount > 0)
            for (const entry of await db.roles.find().toArray())
                try {
                    const guild = await client.guilds.fetch(entry.guild);
                    const member = await guild.members.fetch(user);

                    if (old_amount <= 0) await member.roles.add(entry.role);
                    else await member.roles.remove(entry.role);
                } catch {}
    } catch {
        await message.react("❌");
    }
});

client.on(Events.ClientReady, () => console.log("Ready!"));

async function trigger_update(ctx: CommandInteraction | Message, role: string) {
    const reply = (x: MessageReplyOptions & InteractionEditReplyOptions) =>
        ctx instanceof Message ? ctx.reply(x) : ctx.editReply(x);

    if (locked.has(ctx.guild.id)) {
        await reply({
            content: "Editing the role for this server is locked as an update is underway.",
        });

        return;
    }

    locked.add(ctx.guild.id);

    let old: string;
    let skip: boolean = false;

    if (role) {
        const entry = await db.roles.findOneAndUpdate({ guild: ctx.guild.id }, { $set: { role } }, { upsert: true });

        await reply({
            content:
                entry.value?.role === role
                    ? `This server's role was already <@&${role}>.`
                    : `This server's role has been set to <@&${role}>. I will update in the background.`,
        });

        if (entry.value?.role !== role)
            await audit(
                `${ctx.member} set role for ${ctx.guild.name} to ${ctx.guild.roles.cache.get(role).name} (\`${role}\`).`
            );

        if (entry.value?.role === role) skip = true;
        old = entry.value?.role;
    } else {
        const entry = await db.roles.findOneAndDelete({ guild: ctx.guild.id });

        await reply({
            content: entry.value?.role
                ? `Unset the server's role (formerly <@&${entry.value.role}>). I will update in the background.`
                : "This server does not have a role set.",
        });

        if (entry.value?.role) await audit(`${ctx.member} unset role for ${ctx.guild.name}.`);

        if (!entry.value?.role) skip = true;
        old = entry.value?.role;
    }

    if (!skip)
        for (const [, member] of await ctx.guild.members.fetch())
            if (await db.amounts.findOne({ user: member.id, amount: { $gt: 0 } }))
                try {
                    await member.roles.set(
                        [...member.roles.cache.keys(), ...(role ? [role] : [])].filter((x) => x !== old)
                    );
                } catch {}

    locked.delete(ctx.guild.id);
}

async function is_admin(id: string) {
    if (id === process.env.OWNER) return true;
    if (await db.admins.findOne({ user: id })) return true;

    try {
        const member = await guild.members.fetch(id);
        return member.roles.cache.has(process.env.ROLE);
    } catch {
        return false;
    }
}
