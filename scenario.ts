// The fixed public scenario, derived from the sealed suite's seed.
//
// The env builds every fixture from one seed, SCENARIO_SEED_HEX "6a09e667f3bcc909"
// (wire.ts). The values below are what that seed produces; they are constants for
// every trial instance, so the forge may rely on them instead of re-deriving them
// at boot. They were verified against the kit's wire.ts on 17 Nov 2026:
//   viewer adaiversen (id 1000), teammate quinnkeller (1001),
//   stranger olgabauer (1002), org faint-meadow-org.

/** The login the trial token names: the viewer, owner of every repo it creates. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id. */
export const VIEWER_ID = 1000;
/** The viewer's display name and contact, as the suite generates them. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The teammate login (a collaborator, never a stranger). */
export const TEAMMATE_LOGIN = 'quinnkeller';
/** The stranger login: a repo under this owner is 404 to the viewer, never 403. */
export const STRANGER_LOGIN = 'olgabauer';
/** The organisation login. */
export const ORG_LOGIN = 'faint-meadow-org';
/** The default branch every fixture repo uses. */
export const DEFAULT_BRANCH = 'main';
/** The epoch the suite's commit metadata starts from (2025-01-01T00:00:00Z). */
export const EPOCH_SECONDS = 1735689600;
