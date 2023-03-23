import { Events, Interaction, InteractionEditReplyOptions, InteractionReplyOptions } from "discord.js";
import client from "./client.js";
import db from "./db.js";

process.on("uncaughtException", (error) => console.log(error));

const _audit = await client.channels.fetch(process.env.AUDIT);
if (!_audit?.isTextBased()) throw "Invalid audit channel.";
const audit = (x: string) => _audit.send(`**[-]** ${x}`);

const guild = await client.guilds.fetch(process.env.GUILD);

const locked = new Set<string>();

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
                ephemeral: false,
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
            if (locked.has(interaction.guild.id)) {
                await interaction.editReply({
                    content: "Editing the role for this server is locked as an update is underway.",
                });

                return;
            }

            locked.add(interaction.guild.id);

            const role = interaction.options.getRole("role");

            let old: string;
            let skip: boolean = false;

            if (role) {
                const entry = await db.roles.findOneAndUpdate(
                    { guild: interaction.guild.id },
                    { $set: { role: role.id } },
                    { upsert: true }
                );

                await interaction.editReply({
                    content:
                        entry.value?.role === role.id
                            ? `This server's role was already ${role}.`
                            : `This server's role has been set to ${role}. I will update in the background.`,
                });

                if (entry.value?.role !== role.id)
                    await audit(
                        `${interaction.user} set role for ${interaction.guild.name} to ${role.name} (\`${role.id}\`).`
                    );

                if (entry.value?.role === role.id) skip = true;
                old = entry.value?.role;
            } else {
                const entry = await db.roles.findOneAndDelete({ guild: interaction.guild.id });

                await interaction.editReply({
                    content: entry.value?.role
                        ? `Unset the server's role (formerly <@&${entry.value.role}>). I will update in the background.`
                        : "This server does not have a role set.",
                });

                if (entry.value?.role) await audit(`${interaction.user} unset role for ${interaction.guild.name}.`);

                if (!entry.value?.role) skip = true;
                old = entry.value?.role;
            }

            if (!skip)
                for (const [, member] of await interaction.guild.members.fetch())
                    try {
                        await member.roles.set(
                            [...member.roles.cache.keys(), ...(role ? [role.id] : [])].filter((x) => x !== old)
                        );
                    } catch {}

            locked.delete(interaction.guild.id);
        }
    }
});

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
