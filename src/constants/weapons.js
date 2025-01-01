// Helper to validate weapon environment variables
function validateWeaponEnv(number) {
  const roleId = process.env[`WEAPON${number}_ROLE_ID`];
  const primaryName = process.env[`WEAPON${number}_PRIMARY`];
  const secondaryName = process.env[`WEAPON${number}_SECONDARY`];
  const weaponClass = process.env[`WEAPON${number}_CLASS`];
  return roleId && primaryName && secondaryName && weaponClass
    ? {
        [roleId]: {
          primaryWeapon: primaryName,
          secondaryWeapon: secondaryName,
          class: weaponClass,
        },
      }
    : null;
}

// Dynamically build weapons map from environment variables
export const WEAPON_ROLES = Object.assign(
  {},
  validateWeaponEnv(1),
  validateWeaponEnv(2),
  validateWeaponEnv(3),
  validateWeaponEnv(4),
  validateWeaponEnv(5),
  validateWeaponEnv(6),
  validateWeaponEnv(7),
  validateWeaponEnv(8),
  validateWeaponEnv(9),
  validateWeaponEnv(10),
  validateWeaponEnv(11),
  validateWeaponEnv(12),
  validateWeaponEnv(13),
  validateWeaponEnv(14),
  validateWeaponEnv(15),
  validateWeaponEnv(16)
);

// Helper function to get weapon info from member roles
export function getWeaponInfoFromRoles(member) {
  const memberRoles = member.roles.cache;
  const weaponRole = memberRoles.find((role) =>
    Object.keys(WEAPON_ROLES).includes(role.id)
  );

  if (!weaponRole) {
    return {
      class: null,
      primaryWeapon: null,
      secondaryWeapon: null,
    };
  }

  const weaponInfo = WEAPON_ROLES[weaponRole.id];
  return {
    class: weaponInfo.class,
    primaryWeapon: weaponInfo.primaryWeapon,
    secondaryWeapon: weaponInfo.secondaryWeapon,
  };
}
