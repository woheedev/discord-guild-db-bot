import { log } from "./logger.js";

// Review channels configuration
export const REVIEW_CHANNELS = {
  tank: { channelId: process.env.TANK_REVIEW_CHANNEL_ID },
  healer: { channelId: process.env.HEALER_REVIEW_CHANNEL_ID },
  ranged: { channelId: process.env.RANGED_REVIEW_CHANNEL_ID },
  melee: { channelId: process.env.MELEE_REVIEW_CHANNEL_ID },
  bomber: { channelId: process.env.BOMBER_REVIEW_CHANNEL_ID },
};

class ThreadManager {
  constructor() {
    this.activeThreads = new Map(); // userId -> threadId
    this.initialized = false;
  }

  async fetchAllArchivedThreads(channel) {
    let allThreads = [];
    let hasMore = true;
    let lastThreadId = null;

    while (hasMore) {
      try {
        const threads = await channel.threads.fetchArchived({
          before: lastThreadId,
          limit: 100,
        });

        if (threads.threads.size === 0) {
          hasMore = false;
        } else {
          allThreads = allThreads.concat([...threads.threads.values()]);
          lastThreadId = threads.threads.last().id;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        log.error(`Error fetching archived threads: ${error.message}`);
        hasMore = false;
      }
    }

    return allThreads;
  }

  async initializeCache(guild) {
    try {
      this.activeThreads.clear();
      let totalThreads = 0;
      let errors = 0;

      log.info("Starting thread cache initialization...");

      for (const [className, channelInfo] of Object.entries(REVIEW_CHANNELS)) {
        try {
          const channel = await guild.channels.fetch(channelInfo.channelId);
          if (!channel) {
            log.warn(`Could not find ${className} review channel`);
            continue;
          }

          log.info(`Processing ${className} review channel...`);

          const [activeThreads, archivedThreads] = await Promise.all([
            channel.threads.fetchActive().catch((error) => {
              log.error(
                `Error fetching active threads for ${className}: ${error.message}`
              );
              return { threads: new Map() };
            }),
            this.fetchAllArchivedThreads(channel),
          ]);

          log.info(
            `Found ${activeThreads.threads.size} active threads and ${archivedThreads.length} archived threads in ${className}`
          );

          const allThreads = [
            ...activeThreads.threads.values(),
            ...archivedThreads,
          ];

          for (const thread of allThreads) {
            try {
              if (!thread.archived && !thread.locked) {
                const userId = this.getUserIdFromThreadName(thread.name);
                if (userId) {
                  if (this.activeThreads.has(userId)) {
                    const oldThreadId = this.activeThreads.get(userId);
                    const oldThread =
                      thread.guild.channels.cache.get(oldThreadId);
                    const username =
                      thread.guild.members.cache.get(userId)?.user.username ||
                      userId;
                    log.warn(
                      `User already has an active thread. User: ${username}, Old Thread: #${
                        oldThread?.name || oldThreadId
                      } in ${
                        oldThread?.parent?.name || "unknown"
                      }, New Thread: #${thread.name} in ${
                        thread.parent?.name || "unknown"
                      }`
                    );
                  }
                  this.activeThreads.set(userId, thread.id);
                  log.info(
                    `Cached active thread for user ${userId}: ${thread.name} (${thread.id})`
                  );
                  totalThreads++;
                }
              }
            } catch (error) {
              errors++;
              log.error(
                `Error processing thread #${thread.name}: ${error.message}`
              );
            }
          }
        } catch (error) {
          errors++;
          log.error(
            `Error processing ${className} review channel: ${error.message}`
          );
        }
      }

      this.initialized = true;
      log.info(
        `Thread cache initialization completed: ${totalThreads} active threads found${
          errors > 0 ? `, ${errors} errors encountered` : ""
        }`
      );

      // Log the contents of the cache
      if (totalThreads > 0) {
        log.info("Active threads cache contents:");
        for (const [userId, threadId] of this.activeThreads.entries()) {
          log.info(`User ${userId} -> Thread ${threadId}`);
        }
      }
    } catch (error) {
      log.error(`Error initializing thread cache: ${error.message}`);
      throw error;
    }
  }

  getUserIdFromThreadName(threadName) {
    if (!threadName) return null;
    try {
      const match = threadName.match(/\[(\d+)\]$/);
      return match ? match[1] : null;
    } catch (error) {
      log.error(`Error parsing thread name "${threadName}": ${error.message}`);
      return null;
    }
  }

  hasActiveThread(userId) {
    if (!this.initialized) {
      log.warn("Thread cache accessed before initialization");
    }
    return this.activeThreads.has(userId);
  }

  handleThreadCreate(thread) {
    try {
      if (!thread.archived && !thread.locked) {
        const userId = this.getUserIdFromThreadName(thread.name);
        if (userId) {
          if (this.activeThreads.has(userId)) {
            const username =
              thread.guild.members.cache.get(userId)?.user.username || userId;
            log.warn(
              `User already has an active thread. User: ${username}, ` +
                `Old Thread: #${
                  thread.guild.channels.cache.get(
                    this.activeThreads.get(userId)
                  )?.name || "unknown"
                } in ${
                  thread.guild.channels.cache.get(
                    this.activeThreads.get(userId)
                  )?.parent?.name || "unknown"
                }, ` +
                `New Thread: #${thread.name} in ${
                  thread.parent?.name || "unknown"
                }`
            );
          }
          this.activeThreads.set(userId, thread.id);
        }
      }
    } catch (error) {
      log.error(
        `Error handling thread creation for #${thread.name}: ${error.message}`
      );
    }
  }

  handleThreadDelete(thread) {
    try {
      const userId = this.getUserIdFromThreadName(thread.name);
      if (userId && this.activeThreads.has(userId)) {
        const threadId = this.activeThreads.get(userId);
        if (threadId === thread.id) {
          this.activeThreads.delete(userId);
        } else {
          const username =
            thread.guild.members.cache.get(userId)?.user.username || userId;
          log.warn(
            `Thread ID mismatch. User: ${username}, ` +
              `Cached Thread: #${
                thread.guild.channels.cache.get(threadId)?.name || "unknown"
              }, ` +
              `Deleted Thread: #${thread.name}`
          );
        }
      }
    } catch (error) {
      log.error(
        `Error handling thread deletion for #${thread.name}: ${error.message}`
      );
    }
  }

  handleThreadUpdate(thread) {
    try {
      const userId = this.getUserIdFromThreadName(thread.name);
      if (!userId) return;

      if (thread.archived || thread.locked) {
        if (this.activeThreads.get(userId) === thread.id) {
          this.activeThreads.delete(userId);
        }
      } else {
        this.activeThreads.set(userId, thread.id);
      }
    } catch (error) {
      log.error(
        `Error handling thread update for #${thread.name}: ${error.message}`
      );
    }
  }

  isReviewChannel(channelId) {
    return Object.values(REVIEW_CHANNELS).some(
      (ch) => ch.channelId === channelId
    );
  }

  getActiveThreadId(userId) {
    return this.activeThreads.get(userId) || null;
  }
}

export const threadManager = new ThreadManager();
