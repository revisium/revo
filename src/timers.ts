export const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export const isTimerTimeout = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MILLISECONDS;
