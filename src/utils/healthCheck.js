import { log } from "./logger.js";

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
    await databases.listCollections(process.env.APPWRITE_DATABASE_ID);
    status.appwrite = true;
  } catch (error) {
    log.error(`Appwrite health check failed: ${error.message}`);
  }

  return {
    healthy: status.discord && status.appwrite,
    status,
  };
}
