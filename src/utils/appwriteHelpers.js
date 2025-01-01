import { log } from "./logger.js";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

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
