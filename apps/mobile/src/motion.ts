/** Shared motion timings (inspired by native settle curves; keep values in one place). */
export const motion = {
  pressIn: { duration: 90 },
  fade: { duration: 150 },
  settle: { duration: 240 },
  glide: { duration: 280 },
} as const;

/** Pressed scale for card/row press feedback; 1 means resting. */
export const press = {
  scale: 0.985,
} as const;
