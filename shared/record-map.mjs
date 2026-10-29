const maps = new WeakMap();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Internal immutable-state workspaces keep canonical own fields while sharing
// old records. Inputs remain immutable after ownership is handed to this helper.
// Proxies must be JSON-serialized before crossing worker boundaries; reduceMany
// deliberately returns plain maps unless the service explicitly opts in.
export function forkRecordMap(input) {
  const previous = maps.get(input);
  const compact = previous?.layers.length >= 32;
  const base = compact
    ? Object.fromEntries(Object.entries(input))
    : previous?.base || input;
  const inherited = !compact && previous ? previous.layers : [];
  const target = {},
    deleted = new Set();
  const layers = [...inherited, { target, deleted }];
  let materialized = false;
  function record(key) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (own(layer.target, key)) return { value: layer.target[key] };
      if (layer.deleted.has(key)) return null;
    }
    return own(base, key) ? { value: base[key] } : null;
  }
  function keys() {
    if (materialized) return Reflect.ownKeys(target);
    const result = new Set(Reflect.ownKeys(base));
    for (const layer of layers) {
      for (const key of layer.deleted) result.delete(key);
      for (const key of Reflect.ownKeys(layer.target)) result.add(key);
    }
    return [...result];
  }
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (own(object, key) || materialized)
        return Reflect.get(object, key, receiver);
      const entry = record(key);
      return entry ? entry.value : Reflect.get(object, key, receiver);
    },
    has(object, key) {
      return Reflect.has(object, key) || (!materialized && !!record(key));
    },
    ownKeys: keys,
    getOwnPropertyDescriptor(object, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (descriptor || materialized) return descriptor;
      const entry = record(key);
      return entry
        ? {
            value: entry.value,
            writable: true,
            enumerable: true,
            configurable: true,
          }
        : undefined;
    },
    set(object, key, value) {
      if (!Object.isExtensible(object) && !own(object, key)) return false;
      return Reflect.defineProperty(object, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
    deleteProperty(object, key) {
      if (!Reflect.deleteProperty(object, key)) return false;
      deleted.add(key);
      return true;
    },
    preventExtensions(object) {
      // A caller may freeze a cache. Materialize only for that explicit request.
      for (const key of keys())
        if (!own(object, key))
          Reflect.defineProperty(object, key, {
            value: record(key).value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
      materialized = true;
      return Reflect.preventExtensions(object);
    },
  });
  maps.set(proxy, { base, layers });
  return proxy;
}
