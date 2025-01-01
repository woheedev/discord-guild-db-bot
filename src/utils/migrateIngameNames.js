import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { Client as Appwrite, Databases, Query } from "node-appwrite";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import { log } from "./logger.js";
import { GUILD_ROLES } from "../constants/guilds.js";
import fs from "fs";

dotenv.config();

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

async function migrateIngameNames() {
  try {
    const dbPath = "../tracker-bot/guild_data.db";
    log.info(`Attempting to open SQLite database at: ${dbPath}`);

    // Check if file exists
    try {
      await fs.promises.access(dbPath, fs.constants.R_OK);
    } catch (error) {
      throw new Error(
        `Cannot access database file at ${dbPath}. Please check if the file exists and has read permissions.`
      );
    }

    // Connect to SQLite database
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READONLY,
    });

    // Test the connection
    try {
      await db.get("SELECT 1");
      log.info("Successfully connected to SQLite database");
    } catch (error) {
      throw new Error(`Could not query SQLite database: ${error.message}`);
    }

    // Get all ingame names from SQLite
    const ingameNames = await db.all(
      "SELECT user_id, ingame_name FROM ingame_names WHERE ingame_name IS NOT NULL"
    );
    log.info(`Found ${ingameNames.length} ingame names in SQLite database`);

    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);
    log.info("Logged in to Discord");

    // Get the guild
    const guild = await client.guilds.fetch(process.env.SERVER_ID);
    if (!guild) {
      throw new Error("Could not find guild");
    }

    // Get all members
    const members = await guild.members.fetch();
    log.info(`Fetched ${members.size} members from Discord`);

    // Create a map of all members for reference
    const discordMembers = new Map();
    for (const [id, member] of members.entries()) {
      if (!member.user.bot) {
        discordMembers.set(id, member);
      }
    }
    log.info(`Found ${discordMembers.size} non-bot members`);

    // Fetch all existing documents from Appwrite with pagination
    const limit = 100;
    let offset = 0;
    let allDocs = [];

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

    // Create map for faster lookups
    const existingDocsMap = new Map(
      allDocs.map((doc) => [doc.discord_id, doc])
    );

    // Keep track of migration stats
    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    // Process ingame names in batches
    const batchSize = 10;
    for (let i = 0; i < ingameNames.length; i += batchSize) {
      const batch = ingameNames.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async ({ user_id, ingame_name }) => {
          try {
            const existingDoc = existingDocsMap.get(user_id);
            if (existingDoc) {
              await databases.updateDocument(
                process.env.APPWRITE_DATABASE_ID,
                process.env.APPWRITE_COLLECTION_ID,
                existingDoc.$id,
                { ingame_name }
              );
              const member = discordMembers.get(user_id);
              const username = member ? member.user.username : user_id;
              migrated++;
              log.info(`Migrated ingame name for ${username}: ${ingame_name}`);
            } else {
              skipped++;
              log.info(`Skipped ${user_id} - no existing document in Appwrite`);
            }
          } catch (error) {
            errors++;
            log.error(`Error migrating user ${user_id}: ${error.message}`);
          }
        })
      );

      // Add a small delay between batches to avoid rate limits
      if (i + batchSize < ingameNames.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Log final stats
    log.info("Migration completed:");
    log.info(`- Migrated: ${migrated}`);
    log.info(`- Skipped: ${skipped}`);
    log.info(`- Errors: ${errors}`);

    // Cleanup
    await db.close();
    client.destroy();
  } catch (error) {
    log.error(`Migration failed: ${error.message}`);
    process.exit(1);
  }
}

// Run migration
migrateIngameNames()
  .then(() => {
    log.info("Migration script finished");
    process.exit(0);
  })
  .catch((error) => {
    log.error(`Migration script failed: ${error.message}`);
    process.exit(1);
  });
