import { log } from "./logger.js";
import { checkDatabaseConnection } from "./appwriteHelpers.js";

export async function checkConnections(client, databases) {
  const status = {
    discord: false,
    appwrite: false,
  };

  // Check Discord connection
  try {
    status.discord = client.ws.status === 0;
    if (!status.discord) {
      log.error(`Discord WebSocket status: ${client.ws.status}`);
    }
  } catch (error) {
    log.error(`Discord health check failed: ${error.message}`);
  }

  // Check Appwrite connection
  try {
    status.appwrite = await checkDatabaseConnection(databases);
  } catch (error) {
    log.error(`Appwrite health check failed: ${error.message}`);
  }

  return {
    healthy: status.discord && status.appwrite,
    status,
  };
}
