import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Databases, Query } from "node-appwrite";
import { log } from "./logger.js";

export async function getIngameName(databases, userId) {
  try {
    const result = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID,
      [Query.equal("discord_id", userId)]
    );

    if (result.documents.length > 0) {
      return result.documents[0].ingame_name;
    }
    return null;
  } catch (error) {
    log.error(`Failed to get ingame name for user ${userId}: ${error.message}`);
    return null;
  }
}

export async function setIngameName(databases, userId, ingameName) {
  try {
    const result = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID,
      [Query.equal("discord_id", userId)]
    );

    if (result.documents.length > 0) {
      const docId = result.documents[0].$id;
      await databases.updateDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_COLLECTION_ID,
        docId,
        { ingame_name: ingameName }
      );
      return true;
    }
    return false;
  } catch (error) {
    log.error(`Failed to set ingame name for user ${userId}: ${error.message}`);
    return false;
  }
}

export function createIngameNameModal(existingName = "") {
  const modal = new ModalBuilder()
    .setCustomId("ingameNameModal")
    .setTitle("Set In-Game Name");

  const nameInput = new TextInputBuilder()
    .setCustomId("ingameNameInput")
    .setLabel("Your in-game character name")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(16)
    .setPlaceholder("Enter your character name");

  if (
    existingName &&
    typeof existingName === "string" &&
    existingName.trim().length > 0
  ) {
    nameInput.setValue(existingName);
  }

  const row = new ActionRowBuilder().addComponents(nameInput);
  modal.addComponents(row);

  return modal;
}

export async function createIngameNameMessage(channel) {
  const button = new ButtonBuilder()
    .setCustomId("setIngameName")
    .setLabel("Set/Update In-Game Name")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  const content =
    "Please set your in-game name for guild records:\n\n*Please ensure the name matches your in-game character name exactly.*";

  try {
    // Check for existing message with more specific criteria
    const messages = await channel.messages.fetch({ limit: 50 });
    const existingMessage = messages.find(
      (msg) =>
        msg.author.bot &&
        msg.author.id === msg.client.user.id && // Must be from this bot
        msg.components.length === 1 && // Must have exactly one component row
        msg.components[0].components.length === 1 && // Must have exactly one button
        msg.components[0].components[0].customId === "setIngameName" // Must be our specific button
    );

    if (existingMessage) {
      log.info("Ingame name message already exists");
      return existingMessage;
    }

    const message = await channel.send({
      content,
      components: [row],
    });

    log.info("Created new ingame name message");
    return message;
  } catch (error) {
    log.error(`Failed to create ingame name message: ${error.message}`);
    return null;
  }
}

export function validateIngameName(name) {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Invalid input type" };
  }

  const trimmedName = name.trim();

  if (trimmedName.length < 2) {
    return { valid: false, error: "Name must be at least 2 characters long" };
  }

  if (trimmedName.length > 16) {
    return { valid: false, error: "Name cannot be longer than 16 characters" };
  }

  // Check for valid characters
  const validCharRegex = /^[^\p{C}\p{Z}\p{M}\p{P}]*$/u;
  if (!validCharRegex.test(trimmedName)) {
    return {
      valid: false,
      error:
        "Name cannot contain spaces, punctuation marks, or certain special characters.",
    };
  }

  return { valid: true, value: trimmedName };
}
