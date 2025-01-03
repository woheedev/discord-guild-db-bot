import { log } from "./logger.js";
import { Query } from "node-appwrite";

let isDbConnected = false;
let connectionCheckInProgress = false;
let lastConnectionCheck = 0;
const CONNECTION_CHECK_INTERVAL = 5000; // 5 seconds

export async function checkDatabaseConnection(databases) {
  if (connectionCheckInProgress) return isDbConnected;

  // Only check connection if enough time has passed since last check
  if (Date.now() - lastConnectionCheck < CONNECTION_CHECK_INTERVAL) {
    return isDbConnected;
  }

  connectionCheckInProgress = true;
  try {
    await databases.listCollections(process.env.APPWRITE_DATABASE_ID);
    isDbConnected = true;
    lastConnectionCheck = Date.now();
  } catch (error) {
    isDbConnected = false;
    log.error(`Database connection check failed: ${error.message}`);
  } finally {
    connectionCheckInProgress = false;
  }
  return isDbConnected;
}

// Wrapper for database operations with connection check
export async function withDatabaseCheck(databases, operation) {
  if (!(await checkDatabaseConnection(databases))) {
    throw new Error("Database connection is not available");
  }
  return operation();
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const CACHE_LIFETIME = 60000; // 1 minute cache lifetime

// Cache for Appwrite documents
class DocumentCache {
  constructor() {
    this.cache = new Map();
  }

  set(userId, document) {
    this.cache.set(userId, {
      data: document,
      timestamp: Date.now(),
    });
  }

  get(userId) {
    const entry = this.cache.get(userId);
    if (!entry) return null;

    // Check if cache entry is still valid
    if (Date.now() - entry.timestamp > CACHE_LIFETIME) {
      this.cache.delete(userId);
      return null;
    }

    return entry.data;
  }

  invalidate(userId) {
    this.cache.delete(userId);
  }

  clear() {
    this.cache.clear();
  }
}

export const documentCache = new DocumentCache();

// Batch update system
class BatchUpdateManager {
  constructor(databases) {
    this.databases = databases;
    this.pendingUpdates = new Map();
    this.batchTimeout = null;
  }

  queueUpdate(userId, fields) {
    const existing = this.pendingUpdates.get(userId) || {};
    this.pendingUpdates.set(userId, { ...existing, ...fields });

    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => this.processBatch(), 100); // Process batch after 100ms of no new updates
    }
  }

  async processBatch() {
    if (this.pendingUpdates.size === 0) return;

    const updates = new Map(this.pendingUpdates);
    this.pendingUpdates.clear();
    this.batchTimeout = null;

    for (const [userId, fields] of updates) {
      try {
        const cachedDoc = documentCache.get(userId);
        if (cachedDoc) {
          await withRetry(async () => {
            await withDatabaseCheck(this.databases, () =>
              this.databases.updateDocument(
                process.env.APPWRITE_DATABASE_ID,
                process.env.APPWRITE_COLLECTION_ID,
                cachedDoc.$id,
                fields
              )
            );
          }, `Batch update for user ${userId}`);
          // Update cache with new fields
          documentCache.set(userId, { ...cachedDoc, ...fields });
        } else {
          // If not in cache, need to fetch first
          const doc = await withRetry(async () => {
            const result = await withDatabaseCheck(this.databases, () =>
              this.databases.listDocuments(
                process.env.APPWRITE_DATABASE_ID,
                process.env.APPWRITE_COLLECTION_ID,
                [Query.equal("discord_id", userId)]
              )
            );
            return result;
          }, `Fetch document for batch update ${userId}`);

          if (doc.documents.length > 0) {
            await withRetry(async () => {
              await withDatabaseCheck(this.databases, () =>
                this.databases.updateDocument(
                  process.env.APPWRITE_DATABASE_ID,
                  process.env.APPWRITE_COLLECTION_ID,
                  doc.documents[0].$id,
                  fields
                )
              );
            }, `Batch update for user ${userId}`);
            // Cache the updated document
            documentCache.set(userId, { ...doc.documents[0], ...fields });
          }
        }
      } catch (error) {
        if (error.message === "Database connection is not available") {
          // Re-queue the updates that failed due to connection issues
          for (const [remainingUserId, remainingFields] of updates) {
            if (
              remainingUserId === userId ||
              !this.pendingUpdates.has(remainingUserId)
            ) {
              this.pendingUpdates.set(remainingUserId, remainingFields);
            }
          }
          log.warn(
            `Database connection unavailable, re-queued remaining updates`
          );
          // Set a longer timeout before retrying
          this.batchTimeout = setTimeout(() => this.processBatch(), 5000);
          break;
        }
        log.error(
          `Failed to process batch update for ${userId}: ${error.message}`
        );
      }
    }
  }
}

// Export a function to create the batch manager instead of a singleton instance
export function createBatchManager(databases) {
  return new BatchUpdateManager(databases);
}

export async function withRetry(operation, context = "") {
  let lastError;
  let delay = INITIAL_RETRY_DELAY;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if it's a validation error or similar
      if (error.code === 400 || error.code === 404) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        log.warn(
          `${context} - Attempt ${attempt} failed, retrying in ${delay}ms: ${error.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }
  }

  log.error(`${context} - All retry attempts failed`);
  throw lastError;
}
