import { Client as Appwrite, Databases, ID, Query } from "node-appwrite";
import dotenv from "dotenv";
import { log } from "./logger.js";
import { createBatchManager, documentCache } from "./appwriteHelpers.js";

dotenv.config();

// Initialize Appwrite
const appwrite = new Appwrite()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwrite);
const TEST_COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID + "_test";

async function createAttribute(
  databaseId,
  collectionId,
  key,
  type,
  size,
  required,
  defaultValue = null
) {
  try {
    log.info(`Creating attribute: ${key} (${type})`);
    if (type === "Boolean") {
      await databases.createBooleanAttribute(
        databaseId,
        collectionId,
        key,
        required,
        defaultValue
      );
    } else {
      await databases[`create${type}Attribute`](
        databaseId,
        collectionId,
        key,
        size,
        required,
        defaultValue
      );
    }
    log.info(`Created attribute: ${key}`);
    // Wait a bit between attribute creations
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    if (error.code !== 409) {
      // Ignore if attribute already exists
      log.error(`Failed to create attribute ${key}:`, error);
      if (error.response) {
        log.error("Response details:", JSON.stringify(error.response, null, 2));
      }
      throw error;
    } else {
      log.info(`Attribute ${key} already exists`);
    }
  }
}

async function setupTestEnvironment() {
  try {
    log.info("Setting up test environment...");
    // Create test collection if it doesn't exist
    try {
      await databases.getCollection(
        process.env.APPWRITE_DATABASE_ID,
        TEST_COLLECTION_ID
      );
      log.info("Test collection already exists");
    } catch (error) {
      if (error.code === 404) {
        log.info("Creating new test collection...");
        await databases.createCollection(
          process.env.APPWRITE_DATABASE_ID,
          TEST_COLLECTION_ID,
          "Test Collection"
        );
        log.info("Created test collection");

        // Wait after collection creation
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Create required attributes one by one
        const attributes = [
          { key: "discord_id", type: "String", size: 255, required: true },
          {
            key: "discord_username",
            type: "String",
            size: 255,
            required: false,
          },
          {
            key: "discord_nickname",
            type: "String",
            size: 255,
            required: false,
          },
          { key: "guild", type: "String", size: 255, required: false },
          { key: "class", type: "String", size: 255, required: false },
          { key: "primary_weapon", type: "String", size: 255, required: false },
          {
            key: "secondary_weapon",
            type: "String",
            size: 255,
            required: false,
          },
          { key: "ingame_name", type: "String", size: 255, required: false },
          {
            key: "has_thread",
            type: "Boolean",
            size: null,
            required: false,
            defaultValue: false,
          },
        ];

        log.info("Creating attributes...");
        for (const attr of attributes) {
          try {
            await createAttribute(
              process.env.APPWRITE_DATABASE_ID,
              TEST_COLLECTION_ID,
              attr.key,
              attr.type,
              attr.size,
              attr.required,
              attr.defaultValue
            );
          } catch (error) {
            log.error(`Failed to create attribute ${attr.key}:`, error);
            if (error.response) {
              log.error(
                "Response details:",
                JSON.stringify(error.response, null, 2)
              );
            }
            throw error;
          }
        }

        // Wait for all attributes to be ready
        log.info("Waiting for attributes to be ready...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        log.info("Created test collection attributes");
      } else {
        log.error("Unexpected error getting collection:", error);
        if (error.response) {
          log.error(
            "Response details:",
            JSON.stringify(error.response, null, 2)
          );
        }
        throw error;
      }
    }
  } catch (error) {
    log.error("Failed to setup test environment:", error);
    if (error.response) {
      log.error("Response details:", JSON.stringify(error.response, null, 2));
    }
    if (error.stack) {
      log.error("Stack trace:", error.stack);
    }
    throw error;
  }
}

async function cleanupTestEnvironment() {
  try {
    // List all documents in test collection
    const documents = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      TEST_COLLECTION_ID
    );

    // Delete all test documents
    for (const doc of documents.documents) {
      await databases.deleteDocument(
        process.env.APPWRITE_DATABASE_ID,
        TEST_COLLECTION_ID,
        doc.$id
      );
    }
    log.info("Cleaned up all test documents");
  } catch (error) {
    log.error("Failed to cleanup test environment:", error);
  }
}

// Override the collection ID for the batch manager
const batchManager = createBatchManager(databases);
const originalQueueUpdate = batchManager.queueUpdate;
batchManager.queueUpdate = function (userId, fields) {
  // Store the original collection ID
  const originalCollectionId = process.env.APPWRITE_COLLECTION_ID;
  // Temporarily override the collection ID
  process.env.APPWRITE_COLLECTION_ID = TEST_COLLECTION_ID;
  // Call the original method
  const result = originalQueueUpdate.call(this, userId, fields);
  // Restore the original collection ID
  process.env.APPWRITE_COLLECTION_ID = originalCollectionId;
  return result;
};

async function createTestDocument(userId) {
  try {
    log.info(`Creating test document for user ID: ${userId}`);
    // Wait a bit after collection creation to ensure indexes are ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const documentData = {
      discord_id: userId,
      discord_username: "test_user",
      guild: "test_guild",
      class: null,
      primary_weapon: null,
      secondary_weapon: null,
      ingame_name: null,
      has_thread: false,
      discord_nickname: null,
    };

    log.info(
      "Document data to be created:",
      JSON.stringify(documentData, null, 2)
    );

    const doc = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      TEST_COLLECTION_ID,
      ID.unique(),
      documentData
    );
    log.info(
      "Successfully created test document:",
      JSON.stringify(doc, null, 2)
    );
    return doc;
  } catch (error) {
    log.error("Failed to create test document:", error.message);
    if (error.response) {
      log.error("Response details:", JSON.stringify(error.response, null, 2));
    }
    if (error.stack) {
      log.error("Stack trace:", error.stack);
    }
    throw error;
  }
}

async function waitForBatchUpdate(userId, expectedValue, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      log.info(`Checking batch update (attempt ${i + 1}/${maxAttempts})...`);
      const doc = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        TEST_COLLECTION_ID,
        [Query.equal("discord_id", userId)]
      );

      if (doc.documents.length === 0) {
        log.warn("No documents found for userId:", userId);
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      log.info("Current document state:", doc.documents[0]);

      if (doc.documents[0].guild === expectedValue) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      log.error(`Error checking batch update (attempt ${i + 1}):`, error);
      if (error.response) {
        log.error("Response details:", JSON.stringify(error.response, null, 2));
      }
    }
  }
  return false;
}

async function runTests() {
  log.info("Starting Appwrite integration tests...");
  const originalCollectionId = process.env.APPWRITE_COLLECTION_ID;
  log.info("Using test collection:", TEST_COLLECTION_ID);

  try {
    process.env.APPWRITE_COLLECTION_ID = TEST_COLLECTION_ID;

    await setupTestEnvironment();

    // Test 1: Basic database connection
    log.info("Test 1: Testing database connection...");
    try {
      await databases.listCollections(process.env.APPWRITE_DATABASE_ID);
      log.info("✅ Database connection successful");
    } catch (error) {
      log.error("Database connection test failed:", error);
      if (error.response) {
        log.error("Response details:", JSON.stringify(error.response, null, 2));
      }
      throw error;
    }

    // Test 2: Batch update system
    log.info("\nTest 2: Testing batch update system...");
    const testUserId = `test-user-${Date.now()}`;
    log.info("Using test user ID:", testUserId);

    // Create test document
    try {
      const testDoc = await createTestDocument(testUserId);
      log.info("Test document created successfully");

      // Queue multiple updates
      log.info("Queueing first update (new_guild_1)");
      batchManager.queueUpdate(testUserId, { guild: "new_guild_1" });
      log.info("Queueing second update (new_guild_2)");
      batchManager.queueUpdate(testUserId, { guild: "new_guild_2" });
      log.info("Updates queued successfully");

      // Wait for batch processing with verification
      log.info("Waiting for batch updates to process...");
      const updateSuccess = await waitForBatchUpdate(testUserId, "new_guild_2");
      if (updateSuccess) {
        log.info("✅ Batch update system working correctly");
      } else {
        log.error(
          "❌ Batch update system failed - document did not update to expected value"
        );
      }

      // Test 3: Cache system
      log.info("\nTest 3: Testing cache system...");
      const cachedDoc = documentCache.get(testUserId);
      log.info("Cached document state:", JSON.stringify(cachedDoc, null, 2));
      if (cachedDoc && cachedDoc.guild === "new_guild_2") {
        log.info("✅ Cache system working correctly");
      } else {
        log.error(
          "❌ Cache system failed - cached value does not match expected"
        );
        log.error("Expected: new_guild_2");
        log.error("Got:", cachedDoc ? cachedDoc.guild : "no cached document");
      }
    } catch (error) {
      log.error("Error in batch update test:", error.message);
      if (error.response) {
        log.error("Response details:", JSON.stringify(error.response, null, 2));
      }
      if (error.stack) {
        log.error("Stack trace:", error.stack);
      }
      throw error;
    }

    // Test 4: Error handling
    log.info("\nTest 4: Testing error handling...");
    try {
      await databases.createDocument(
        "invalid-database-id",
        "invalid-collection-id",
        ID.unique(),
        { test: "data" }
      );
      log.error("❌ Error handling test failed - should have thrown an error");
    } catch (error) {
      log.info("✅ Error handling working correctly");
      log.info("Expected error received:", error.message);
    }
  } catch (error) {
    log.error("Test suite failed:", error.message);
    if (error.response) {
      log.error("Response details:", JSON.stringify(error.response, null, 2));
    }
    if (error.stack) {
      log.error("Stack trace:", error.stack);
    }
  } finally {
    log.info("\nCleaning up test environment...");
    await cleanupTestEnvironment();
    log.info("✅ Test cleanup successful");
    process.env.APPWRITE_COLLECTION_ID = originalCollectionId;
  }

  log.info("\nTests completed!");
  process.exit(0);
}

// Run the tests
runTests().catch((error) => {
  log.error("Fatal error:", error);
  if (error.response) {
    log.error("Response details:", JSON.stringify(error.response, null, 2));
  }
  if (error.stack) {
    log.error("Stack trace:", error.stack);
  }
  process.exit(1);
});
