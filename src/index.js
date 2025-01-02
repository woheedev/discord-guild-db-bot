import { Client, Events, GatewayIntentBits } from "discord.js";
import { Client as Appwrite, Databases, ID, Query } from "node-appwrite";
import dotenv from "dotenv";
import { log } from "./utils/logger.js";
import { getGuildFromRoles } from "./constants/guilds.js";
import { getWeaponInfoFromRoles } from "./constants/weapons.js";
import { debounce } from "lodash-es";
import http from "http";
import {
  getIngameName,
  setIngameName,
  createIngameNameModal,
  createIngameNameMessage,
  validateIngameName,
} from "./utils/ingameName.js";
import { threadManager } from "./utils/threadManager.js";
import {
  withRetry,
  documentCache,
  batchManager,
} from "./utils/appwriteHelpers.js";
import { checkConnections } from "./utils/healthCheck.js";

dotenv.config();

// Add environment checks
const requiredEnvVars = [
  "DISCORD_TOKEN",
  "SERVER_ID",
  "APPWRITE_ENDPOINT",
  "APPWRITE_PROJECT_ID",
  "APPWRITE_API_KEY",
  "APPWRITE_DATABASE_ID",
  "APPWRITE_COLLECTION_ID",
  "HEALTH_PORT",
  "INGAME_NAME_CHANNEL_ID",
  "TANK_REVIEW_CHANNEL_ID",
  "HEALER_REVIEW_CHANNEL_ID",
  "RANGED_REVIEW_CHANNEL_ID",
  "MELEE_REVIEW_CHANNEL_ID",
  "BOMBER_REVIEW_CHANNEL_ID",
];

// Add guild environment variables
const numGuilds = 4; // Current number of guilds
for (let i = 1; i <= numGuilds; i++) {
  requiredEnvVars.push(`GUILD${i}_ROLE_ID`, `GUILD${i}_NAME`);
}

// Add weapon environment variables
const numWeapons = 16; // Current number of weapons
for (let i = 1; i <= numWeapons; i++) {
  requiredEnvVars.push(
    `WEAPON${i}_ROLE_ID`,
    `WEAPON${i}_PRIMARY`,
    `WEAPON${i}_SECONDARY`,
    `WEAPON${i}_CLASS`
  );
}

const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingVars.length > 0) {
  log.error(
    `Missing required environment variables: ${missingVars.join(", ")}`
  );
  process.exit(1);
}

// Initialize Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Initialize Appwrite
const appwrite = new Appwrite()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwrite);

// Sync member data to Appwrite
async function syncMember(member) {
  try {
    const guild = getGuildFromRoles(member);
    const weaponInfo = getWeaponInfoFromRoles(member);
    log.info(`Processing member ${member.user.username}`);

    try {
      const existingDoc = await withRetry(
        () =>
          databases.listDocuments(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_COLLECTION_ID,
            [Query.equal("discord_id", member.id)]
          ),
        `Fetch document for ${member.user.username}`
      );

      const hasThread = await threadManager.hasActiveThread(member.id);
      const memberData = {
        discord_id: member.id,
        discord_username: member.user.username,
        discord_nickname: member.nickname || member.user.displayName || null,
        class: weaponInfo.class,
        primary_weapon: weaponInfo.primaryWeapon,
        secondary_weapon: weaponInfo.secondaryWeapon,
        guild: guild,
        has_thread: hasThread,
      };

      if (existingDoc.documents.length > 0) {
        const docId = existingDoc.documents[0].$id;
        memberData.ingame_name = existingDoc.documents[0].ingame_name;
        if (!weaponInfo.class) {
          memberData.class = existingDoc.documents[0].class;
          memberData.primary_weapon = existingDoc.documents[0].primary_weapon;
          memberData.secondary_weapon =
            existingDoc.documents[0].secondary_weapon;
        }

        await withRetry(
          () =>
            databases.updateDocument(
              process.env.APPWRITE_DATABASE_ID,
              process.env.APPWRITE_COLLECTION_ID,
              docId,
              memberData
            ),
          `Update document for ${member.user.username}`
        );
        log.info(`Updated member data for ${member.user.username}`);
      } else {
        memberData.ingame_name = null;
        await withRetry(
          () =>
            databases.createDocument(
              process.env.APPWRITE_DATABASE_ID,
              process.env.APPWRITE_COLLECTION_ID,
              ID.unique(),
              memberData
            ),
          `Create document for ${member.user.username}`
        );
        log.info(`Created new member data for ${member.user.username}`);
      }
    } catch (error) {
      log.error(
        `Error syncing member ${member.user.username}: ${error.message}`
      );
      if (error.code) {
        log.error(`Error code: ${error.code}`);
      }
    }
  } catch (error) {
    log.error(
      `Error processing member ${member.user.username}: ${error.message}`
    );
  }
}

// Event handler for when bot is ready
client.once(Events.ClientReady, async () => {
  log.info(`Logged in as ${client.user.tag}`);

  const server = await client.guilds.fetch(process.env.SERVER_ID);
  if (!server) {
    log.error("Bot is not in the specified Discord server");
    process.exit(1);
  }

  // Initialize thread cache first
  await threadManager.initializeCache(server);

  // Create ingame name message in the specified channel
  const ingameNameChannel = await server.channels.fetch(
    process.env.INGAME_NAME_CHANNEL_ID
  );
  if (ingameNameChannel) {
    await createIngameNameMessage(ingameNameChannel);
  }

  try {
    const members = await server.members.fetch();
    const nonBotMembers = Array.from(members.values()).filter(
      (member) => !member.user.bot
    );
    log.info(`Syncing ${nonBotMembers.length} members from ${server.name}`);

    // Add pagination for large servers
    const limit = 100; // Appwrite's recommended limit
    let offset = 0;
    let allDocs = [];

    // Fetch all documents with pagination
    while (true) {
      const response = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        [Query.limit(limit), Query.offset(offset)]
      );

      allDocs = allDocs.concat(response.documents);

      if (response.documents.length < limit) break;
      offset += limit;
    }

    // Create map from all documents and populate cache
    const existingDocsMap = new Map(
      allDocs.map((doc) => {
        documentCache.set(doc.discord_id, doc);
        return [doc.discord_id, doc];
      })
    );

    // Process members in batches of 10
    const batchSize = 10;
    for (let i = 0; i < nonBotMembers.length; i += batchSize) {
      const batch = nonBotMembers.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (member) => {
          try {
            const guild = getGuildFromRoles(member);
            const weaponInfo = getWeaponInfoFromRoles(member);
            const hasThread = await threadManager.hasActiveThread(member.id);
            const memberData = {
              discord_id: member.id,
              discord_username: member.user.username,
              discord_nickname:
                member.nickname || member.user.displayName || null,
              class: weaponInfo.class,
              primary_weapon: weaponInfo.primaryWeapon,
              secondary_weapon: weaponInfo.secondaryWeapon,
              guild: guild,
              has_thread: hasThread,
            };

            const existingDoc = existingDocsMap.get(member.id);

            if (existingDoc) {
              memberData.ingame_name = existingDoc.ingame_name;
              if (!weaponInfo.class) {
                memberData.class = existingDoc.class;
                memberData.primary_weapon = existingDoc.primary_weapon;
                memberData.secondary_weapon = existingDoc.secondary_weapon;
              }

              await withRetry(
                () =>
                  databases.updateDocument(
                    process.env.APPWRITE_DATABASE_ID,
                    process.env.APPWRITE_COLLECTION_ID,
                    existingDoc.$id,
                    memberData
                  ),
                `Update document for ${member.user.username}`
              );
              documentCache.set(member.id, { ...existingDoc, ...memberData });
              log.info(`Updated member data for ${member.user.username}`);
            } else {
              memberData.ingame_name = null;
              const doc = await withRetry(
                () =>
                  databases.createDocument(
                    process.env.APPWRITE_DATABASE_ID,
                    process.env.APPWRITE_COLLECTION_ID,
                    ID.unique(),
                    memberData
                  ),
                `Create document for ${member.user.username}`
              );
              documentCache.set(member.id, doc);
              log.info(`Created new member data for ${member.user.username}`);
            }
          } catch (error) {
            log.error(
              `Error processing member ${member.user.username}: ${error.message}`
            );
          }
        })
      );

      // Add a small delay between batches to avoid rate limits
      if (i + batchSize < nonBotMembers.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    log.info(`Finished syncing members from ${server.name}`);
  } catch (error) {
    log.error(`Initial sync failed: ${error.message}`);
    // Attempt to reconnect after delay
    setTimeout(() => {
      log.info("Attempting to restart bot after sync failure...");
      process.exit(1); // PM2 will restart the process
    }, 5000);
  }
});

// Event handler for new members
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id === process.env.SERVER_ID && !member.user.bot) {
    // They won't have roles yet, so just log it
    log.info(`New member joined: ${member.user.username}`);
  }
});

const rateLimitedUpdate = async (operation) => {
  try {
    await operation();
  } catch (error) {
    if (error.code === 429) {
      // Rate limit error
      const retryAfter = error.response?.headers?.["retry-after"] || 5000;
      log.warn(`Rate limited, retrying after ${retryAfter}ms`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
      await operation();
    } else {
      throw error;
    }
  }
};

// Create maps to store per-member debounced functions
const memberGuildSyncs = new Map();
const memberWeaponSyncs = new Map();

// Create debounced sync function for a specific member
function getOrCreateDebouncedGuildSync(memberId) {
  if (!memberGuildSyncs.has(memberId)) {
    memberGuildSyncs.set(
      memberId,
      debounce(
        async (member) => {
          try {
            const guild = getGuildFromRoles(member);
            log.info(
              `Processing guild role change for ${member.user.username}`
            );
            await withRetry(
              () => updateMemberFields(member, { guild }),
              `Update guild for ${member.user.username}`
            );
          } catch (error) {
            log.error(
              `Error handling guild role change for ${member.user.username}: ${error.message}`
            );
          }
        },
        1000,
        { maxWait: 5000 }
      )
    );
  }
  return memberGuildSyncs.get(memberId);
}

function getOrCreateDebouncedWeaponSync(memberId) {
  if (!memberWeaponSyncs.has(memberId)) {
    memberWeaponSyncs.set(
      memberId,
      debounce(
        async (member) => {
          try {
            const weaponInfo = getWeaponInfoFromRoles(member);
            log.info(
              `Processing weapon role change for ${member.user.username}`
            );
            await withRetry(
              () =>
                updateMemberFields(member, {
                  class: weaponInfo.class,
                  primary_weapon: weaponInfo.primaryWeapon,
                  secondary_weapon: weaponInfo.secondaryWeapon,
                }),
              `Update weapons for ${member.user.username}`
            );
          } catch (error) {
            log.error(
              `Error handling weapon role change for ${member.user.username}: ${error.message}`
            );
          }
        },
        1000,
        { maxWait: 5000 }
      )
    );
  }
  return memberWeaponSyncs.get(memberId);
}

// Helper to update specific fields
async function updateMemberFields(member, fields) {
  try {
    // Queue the update instead of doing it immediately
    batchManager.queueUpdate(member.id, fields);
    log.info(
      `Queued update ${Object.keys(fields).join(", ")} for ${
        member.user.username
      }`
    );
  } catch (error) {
    log.error(
      `Error queueing update for ${member.user.username}: ${error.message}`
    );
  }
}

// Modify GuildMemberUpdate to use per-member debounced handlers
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (newMember.guild.id === process.env.SERVER_ID && !newMember.user.bot) {
    try {
      // Check for guild role changes
      const oldGuildRole = getGuildFromRoles(oldMember);
      const newGuildRole = getGuildFromRoles(newMember);
      if (oldGuildRole !== newGuildRole) {
        const debouncedGuildSync = getOrCreateDebouncedGuildSync(newMember.id);
        await debouncedGuildSync(newMember);
      }

      // Check for weapon role changes
      const oldWeaponInfo = getWeaponInfoFromRoles(oldMember);
      const newWeaponInfo = getWeaponInfoFromRoles(newMember);
      if (
        oldWeaponInfo.class !== newWeaponInfo.class ||
        oldWeaponInfo.primaryWeapon !== newWeaponInfo.primaryWeapon ||
        oldWeaponInfo.secondaryWeapon !== newWeaponInfo.secondaryWeapon
      ) {
        const debouncedWeaponSync = getOrCreateDebouncedWeaponSync(
          newMember.id
        );
        await debouncedWeaponSync(newMember);
      }
    } catch (error) {
      log.error(
        `Error handling member update for ${newMember.user.username}: ${error.message}`
      );
    }
  }
});

// UserUpdate handles global username/displayName changes
client.on(Events.UserUpdate, async (oldUser, newUser) => {
  const hasUsernameChanged = oldUser.username !== newUser.username;
  const hasDisplayNameChanged = oldUser.displayName !== newUser.displayName;

  if (hasUsernameChanged || hasDisplayNameChanged) {
    const server = client.guilds.cache.get(process.env.SERVER_ID);
    if (!server) return;

    const member = await server.members.fetch(newUser.id);
    if (member && !member.user.bot) {
      await debouncedSyncNames(member);
    }
  }
});

// Add handler for members leaving/being kicked
client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id === process.env.SERVER_ID && !member.user.bot) {
    try {
      const existingDoc = documentCache.get(member.id);
      if (existingDoc) {
        await withRetry(
          () =>
            databases.updateDocument(
              process.env.APPWRITE_DATABASE_ID,
              process.env.APPWRITE_COLLECTION_ID,
              existingDoc.$id,
              {
                guild: null,
                class: null,
                primary_weapon: null,
                secondary_weapon: null,
                has_thread: null,
              }
            ),
          `Update removed member ${member.user.username}`
        );
        documentCache.invalidate(member.id);
        log.info(
          `Preserved historical data for ${member.user.username} (left server)`
        );
      }
    } catch (error) {
      log.error(
        `Error preserving historical data for ${member.user.username}: ${error.message}`
      );
    }
  }
});

// Add handlers for bans/unbans
client.on(Events.GuildBanAdd, async (ban) => {
  if (ban.guild.id === process.env.SERVER_ID && !ban.user.bot) {
    try {
      const existingDoc = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        [Query.equal("discord_id", ban.user.id)]
      );

      if (existingDoc.documents.length > 0) {
        const docId = existingDoc.documents[0].$id;
        // Preserve historical data but nullify guild-related fields
        await databases.updateDocument(
          process.env.APPWRITE_DATABASE_ID,
          process.env.APPWRITE_COLLECTION_ID,
          docId,
          {
            guild: null,
            class: null,
            primary_weapon: null,
            secondary_weapon: null,
            has_thread: null,
          }
        );
        log.info(`Preserved historical data for ${ban.user.username} (banned)`);
      }
    } catch (error) {
      log.error(
        `Error preserving historical data for ${ban.user.username}: ${error.message}`
      );
    }
  }
});

// Add button interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === "setIngameName") {
      try {
        const existingName = await getIngameName(
          databases,
          interaction.user.id
        );
        const modal = createIngameNameModal(existingName);
        await interaction.showModal(modal);
      } catch (error) {
        log.error(`Error showing ingame name modal: ${error.message}`);
        await interaction.reply({
          content: "Sorry, there was an error. Please try again later.",
          ephemeral: true,
        });
      }
    }
  }

  // Handle modal submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "ingameNameModal") {
      try {
        const rawIngameName =
          interaction.fields.getTextInputValue("ingameNameInput");
        const validation = validateIngameName(rawIngameName);

        if (!validation.valid) {
          await interaction.reply({
            content: `Invalid in-game name: ${validation.error}`,
            ephemeral: true,
          });
          return;
        }

        const success = await setIngameName(
          databases,
          interaction.user.id,
          validation.value
        );

        if (success) {
          await interaction.reply({
            content: `Your in-game name has been set to: ${validation.value}`,
            ephemeral: true,
          });

          // Update member data in database
          const member = await interaction.guild.members.fetch(
            interaction.user.id
          );
          await syncMember(member);
        } else {
          await interaction.reply({
            content:
              "Sorry, there was an error setting your in-game name. Please try again later.",
            ephemeral: true,
          });
        }
      } catch (error) {
        log.error(`Error handling ingame name modal: ${error.message}`);
        await interaction.reply({
          content: "Sorry, there was an error. Please try again later.",
          ephemeral: true,
        });
      }
    }
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);

client.on("disconnect", () => {
  log.error("Bot disconnected from Discord!");
});

client.on("reconnecting", () => {
  log.info("Bot attempting to reconnect...");
});

client.on("resume", (replayed) => {
  log.info(`Bot reconnected! Replayed ${replayed} events.`);
});

client.on("error", (error) => {
  log.error(`Discord client error: ${error.message}`);
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    const { healthy, status } = await checkConnections(client, databases);
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy, status }));
  }
});

const port = parseInt(process.env.HEALTH_PORT, 10);
server.listen(port, () => {
  log.info(`Health check server listening on port ${port}`);
});

process.on("SIGTERM", async () => {
  log.info("Received SIGTERM signal, cleaning up...");
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("Received SIGINT signal, cleaning up...");
  client.destroy();
  process.exit(0);
});

// Thread event handlers with rate limiting
const handleThreadMemberSync = debounce(
  async (userId, guild) => {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        log.info(`Syncing member ${member.user.username} after thread update`);
        await syncMember(member);
      }
    } catch (error) {
      log.error(
        `Error syncing member ${userId} after thread update: ${error.message}`
      );
    }
  },
  1000,
  { maxWait: 5000 }
);

client.on(Events.ThreadCreate, async (thread) => {
  try {
    if (!thread?.parentId) return;

    if (threadManager.isReviewChannel(thread.parentId)) {
      threadManager.handleThreadCreate(thread);
      const userId = threadManager.getUserIdFromThreadName(thread.name);
      if (userId) {
        await handleThreadMemberSync(userId, thread.guild);
      }
    }
  } catch (error) {
    log.error(`Error handling thread creation: ${error.message}`);
  }
});

client.on(Events.ThreadDelete, async (thread) => {
  try {
    if (!thread?.parentId) return;

    if (threadManager.isReviewChannel(thread.parentId)) {
      const userId = threadManager.getUserIdFromThreadName(thread.name);
      threadManager.handleThreadDelete(thread);
      if (userId) {
        await handleThreadMemberSync(userId, thread.guild);
      }
    }
  } catch (error) {
    log.error(`Error handling thread deletion: ${error.message}`);
  }
});

client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
  try {
    if (!newThread?.parentId) return;

    if (threadManager.isReviewChannel(newThread.parentId)) {
      threadManager.handleThreadUpdate(newThread);
      const userId = threadManager.getUserIdFromThreadName(newThread.name);
      if (userId) {
        await handleThreadMemberSync(userId, newThread.guild);
      }
    }
  } catch (error) {
    log.error(`Error handling thread update: ${error.message}`);
  }
});

// Add periodic health check
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
  try {
    const { healthy, status } = await checkConnections(client, databases);
    if (!healthy) {
      log.error("Health check failed:", status);
      if (!status.discord || !status.appwrite) {
        log.error("Critical service down, restarting...");
        process.exit(1); // PM2 will restart the process
      }
    }
  } catch (error) {
    log.error(`Health check error: ${error.message}`);
  }
}, HEALTH_CHECK_INTERVAL);
