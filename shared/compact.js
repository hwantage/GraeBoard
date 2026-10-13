// Long names belong to the editor. Stored/transported styles use this one map.
export const STYLE_KEYS = {
  borderTop: "bt",
  borderRight: "br",
  borderBottom: "bb",
  borderLeft: "bl",
  color: "c",
  backgroundColor: "bg",
  fontFamily: "ff",
  fontSize: "fs",
  textAlign: "ta",
  verticalAlign: "va",
  bold: "b",
  italic: "i",
  underline: "u",
  strike: "s",
  textMode: "tm",
};
const LONG_KEYS = Object.fromEntries(
  Object.entries(STYLE_KEYS).map(([k, v]) => [v, k]),
);
const BORDER_KEYS = new Set([
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
]);

export function compactStyle(style) {
  return Object.fromEntries(
    Object.keys(style)
      .sort()
      .map((key) => {
        const value = style[key];
        return [
          Object.hasOwn(STYLE_KEYS, key) ? STYLE_KEYS[key] : key,
          BORDER_KEYS.has(key) && value ? [value.style, value.color] : value,
        ];
      }),
  );
}

export function expandStyle(style) {
  if (!style || typeof style !== "object" || Array.isArray(style))
    throw new Error("서식 데이터를 확인하세요.");
  return Object.fromEntries(
    Object.entries(style).map(([short, value]) => {
      const key = Object.hasOwn(LONG_KEYS, short) ? LONG_KEYS[short] : short;
      if (BORDER_KEYS.has(key) && Array.isArray(value)) {
        if (value.length !== 2) throw new Error("테두리 데이터를 확인하세요.");
        return [key, { style: value[0], color: value[1] }];
      }
      return [key, value];
    }),
  );
}

// Keep only overrides. null must survive when it cancels an inherited border;
// 'none', false, 0 and empty strings are never mistaken for absent values.
export function normalizeStyle(style = {}, defaults = {}) {
  return Object.fromEntries(
    Object.entries(style).filter(([key, value]) => {
      if (value === undefined) return false;
      const inherited = defaults[key];
      if (value === null) return inherited != null;
      if (BORDER_KEYS.has(key)) {
        // An explicit line also has priority over the computed week boundary.
        // Equal-looking inherited and explicit borders are therefore distinct.
        if (value) return true;
      }
      return value !== inherited;
    }),
  );
}

export function sameStyle(a, b) {
  if (a === b) return true;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      if (!Object.hasOwn(b, key)) return false;
      if (a[key] === b[key]) return true;
      return (
        BORDER_KEYS.has(key) &&
        a[key] &&
        b[key] &&
        a[key].style === b[key].style &&
        a[key].color === b[key].color
      );
    })
  );
}

// Decoding and DB hydration share immutable style objects. A batch normalizes
// each (style, row default) pair once instead of once per selected cell.
export function styleNormalizer() {
  const cache = new WeakMap();
  return (style, defaults) => {
    if (!cache.has(style)) cache.set(style, new WeakMap());
    const byDefault = cache.get(style);
    if (!byDefault.has(defaults))
      byDefault.set(defaults, normalizeStyle(style, defaults));
    return byDefault.get(defaults);
  };
}

// A dictionary is local to one document, request or event. No session state or
// database IDs cross the wire; snapshots and replay responses remain portable.
export function pack(data) {
  const styles = [],
    ids = new Map(),
    objects = new WeakMap();
  const formats = [],
    formatObjects = new WeakMap(),
    formatIds = new Map();
  function reference(style) {
    if (objects.has(style)) return objects.get(style);
    const compact = compactStyle(style),
      key = JSON.stringify(compact);
    if (!ids.has(key)) {
      ids.set(key, styles.length);
      styles.push(compact);
    }
    const id = ids.get(key);
    objects.set(style, id);
    return id;
  }
  function formatReference(formatting) {
    if (formatObjects.has(formatting)) return formatObjects.get(formatting);
    const packed = visit(formatting),
      key = JSON.stringify(packed);
    if (!formatIds.has(key)) {
      formatIds.set(key, formats.length);
      formats.push(packed);
    }
    const id = formatIds.get(key);
    formatObjects.set(formatting, id);
    return id;
  }
  function visit(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(visit);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === "style" || key === "defaultStyle" || key === "rowStyle") &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Object.keys(item).length > 0 &&
        Object.keys(item).every((name) => Object.hasOwn(STYLE_KEYS, name))
          ? { $s: reference(item) }
          : key === "formatting" &&
              item &&
              Number.isInteger(item.revision) &&
              Array.isArray(item.rules)
            ? { $f: formatReference(item) }
            : visit(item),
      ]),
    );
  }
  const packed = visit(data);
  return styles.length || formats.length
    ? {
        $styles: styles,
        ...(formats.length ? { $formats: formats } : {}),
        $data: packed,
      }
    : data;
}

export function unpack(payload, { maxStyles = Infinity } = {}) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Object.hasOwn(payload, "$styles")
  )
    return payload;
  if (
    !Array.isArray(payload.$styles) ||
    payload.$styles.length > maxStyles ||
    !Object.hasOwn(payload, "$data") ||
    Object.keys(payload).some(
      (key) => !["$styles", "$formats", "$data"].includes(key),
    ) ||
    (Object.hasOwn(payload, "$formats") &&
      (!Array.isArray(payload.$formats) || payload.$formats.length > 10000))
  )
    throw new Error("압축 데이터 형식을 확인하세요.");
  const styles = payload.$styles.map(expandStyle);
  let formats;
  function visit(value, depth = 0) {
    if (depth > 100) throw new Error("데이터 중첩이 너무 깊습니다.");
    if (!value || typeof value !== "object") return value;
    // Preserve the wire payload and reuse branches that contain no references.
    // Clone only when a decoded child actually changes, without entry-pair arrays.
    let decoded = value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = visit(value[i], depth + 1);
        if (item === value[i]) continue;
        if (decoded === value) decoded = value.slice();
        decoded[i] = item;
      }
      return decoded;
    }
    for (const key of Object.keys(value)) {
      const item = value[key];
      let next;
      if (
        key === "formatting" &&
        item &&
        typeof item === "object" &&
        Object.hasOwn(item, "$f")
      ) {
        const id = item.$f;
        if (
          !formats ||
          Object.keys(item).length !== 1 ||
          !Number.isInteger(id) ||
          id < 0 ||
          id >= formats.length
        )
          throw new Error("공통 서식 참조를 확인하세요.");
        next = formats[id];
      } else if (
        (key === "style" || key === "defaultStyle" || key === "rowStyle") &&
        item &&
        typeof item === "object" &&
        Object.hasOwn(item, "$s")
      ) {
        const id = item.$s;
        if (
          Object.keys(item).length !== 1 ||
          !Number.isInteger(id) ||
          id < 0 ||
          id >= styles.length
        )
          throw new Error("서식 참조를 확인하세요.");
        next = styles[id];
      } else next = visit(item, depth + 1);
      if (next === item) continue;
      if (decoded === value) decoded = { ...value };
      decoded[key] = next;
    }
    return decoded;
  }
  formats = (payload.$formats || []).map((value) => visit(value));
  return visit(payload.$data);
}

export const stringify = (value) => JSON.stringify(pack(value));
export const parseCompact = (value) => unpack(JSON.parse(value));
