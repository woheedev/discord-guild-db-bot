// Helper to validate guild environment variables
function validateGuildEnv(number) {
  const roleId = process.env[`GUILD${number}_ROLE_ID`];
  const name = process.env[`GUILD${number}_NAME`];
  return roleId && name ? { [roleId]: name } : null;
}

// Dynamically build guild roles map from environment variables
export const GUILD_ROLES = Object.assign(
  {},
  validateGuildEnv(1),
  validateGuildEnv(2),
  validateGuildEnv(3),
  validateGuildEnv(4)
);

// Helper function to get guild name from member roles
export function getGuildFromRoles(member) {
  const memberRoles = member.roles.cache;
  const guildRole = memberRoles.find((role) =>
    Object.keys(GUILD_ROLES).includes(role.id)
  );
  return guildRole ? GUILD_ROLES[guildRole.id] : null;
}
