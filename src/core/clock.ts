// Injectable clock so tests can freeze time.
let override: (() => number) | null = null;
export const now = () => (override ? override() : Date.now());
export const setNow = (fn: (() => number) | null) => { override = fn; };
