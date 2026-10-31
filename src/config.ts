/** Build-time configuration. Splitsmith is free: no license, no payments, no Mira Forge server. */

/** AI split limits. */
export const MAX_AI_PARTS = 40;
/** Largest chunk of a note sent in one AI request (characters of numbered lines). Long notes are sent in several chunks. */
export const AI_WINDOW_CHARS = 24000;
