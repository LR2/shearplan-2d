// Keep the app's storage API unchanged while isolating preview data on the
// shared github.io origin. An empty namespace preserves production's keys.
export function createBrowserStorage(getStorage, namespace = '') {
  return {
    get: (key) => ({ key, value: getStorage().getItem(namespace + key) }),
    set: (key, value) => {
      getStorage().setItem(namespace + key, String(value));
      return { key, value };
    },
    delete: (key) => {
      getStorage().removeItem(namespace + key);
      return { key, deleted: true };
    },
    list: (prefix = '') => ({
      keys: Object.keys(getStorage())
        .filter((key) => key.startsWith(namespace + prefix))
        .map((key) => key.slice(namespace.length)),
      prefix,
    }),
  };
}
