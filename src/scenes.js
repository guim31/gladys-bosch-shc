// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`).
//
// One action: arm the intrusion alarm of the controller, with one of its
// three profiles. It refuses to run unless the user enabled "Allow arming
// from Gladys" in the configuration. Disarming and muting are not offered at
// all: a scene, a voice assistant or a shared dashboard must never be able to
// switch the protection of the house off.
// -----------------------------------------------------------------------------

import { ARM_PROFILES } from './hub.js';

export const SCENE_ACTIONS = {
  async arm_intrusion(hub, { fields }) {
    const profile = Object.hasOwn(ARM_PROFILES, fields?.profile) ? fields.profile : 'full';
    await hub.arm(profile);
    return { armed: true };
  },
};
