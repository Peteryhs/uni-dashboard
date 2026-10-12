/** Minimal setting store that forces a group of operations to read one CAS snapshot. */
export function makeCasBarrierStore({ key, initial = null, barrierReads = 2, alwaysFail = false }) {
  const settings = new Map();
  if (initial != null) settings.set(key, initial);
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    settings,
    async getSetting(name) {
      const value = settings.has(name) ? settings.get(name) : null;
      if (name === key && arrived < barrierReads) {
        arrived++;
        if (arrived === barrierReads) release();
        await gate;
      }
      return value;
    },
    async compareAndSetSetting(name, expected, value) {
      if (alwaysFail) return false;
      const current = settings.has(name) ? settings.get(name) : null;
      if (current !== expected) return false;
      settings.set(name, value);
      return true;
    },
  };
}
