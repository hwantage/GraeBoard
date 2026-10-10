/** @param {string} query */
export function normalizeSearchQuery(query) {
  return query.trim().normalize("NFC").toLowerCase();
}

/**
 * Cache display text independently of cell formatting and the current query.
 * Task cells are immutable; only changed rows need new text. Recreate this
 * index when property definitions or member names change.
 * @param {import("../src/types").Property[]} properties
 * @param {import("../src/types").User[]} users
 */
export function createPropertySearch(properties, users) {
  const active = properties.filter((property) => !property.archived);
  const names = new Map(users.map((user) => [user.id, user.name]));
  const columns = active.map((property) => ({
    key: property.id,
    member: property.kind === "member",
    labels: new Map((property.values || []).map((v) => [v.id, v.label])),
  }));
  const cache = new WeakMap();

  /** @param {import("../src/types").Task} task */
  function rowText(task) {
    let texts = cache.get(task.cells);
    if (!texts) {
      texts = columns.map(({ key, member, labels }) => {
        const value = task.cells[key]?.value ?? "";
        const text = member
          ? (Array.isArray(value) ? value : value ? [value] : [])
              .map((id) => names.get(id) || id)
              .join(", ")
          : (labels.get(value) ?? String(value));
        return text.normalize("NFC").toLowerCase();
      });
      cache.set(task.cells, texts);
    }
    return texts;
  }

  return {
    /**
     * Store compact cell offsets; previous/next does no rescanning. Yield during
     * large searches so typing and cancellation remain responsive.
     * @param {import("../src/types").Task[]} tasks
     * @param {string} input
     * @param {AbortSignal} [signal]
     */
    async find(tasks, input, signal) {
      const query = normalizeSearchQuery(input);
      /** @type {number[]} */
      const offsets = [];
      let sliceStart = performance.now();
      if (signal?.aborted) return null;
      if (query && columns.length) {
        for (let row = 0; row < tasks.length; row++) {
          const texts = rowText(tasks[row]);
          for (let col = 0; col < columns.length; col++) {
            if (texts[col].includes(query))
              offsets.push(row * columns.length + col);
          }
          if ((row & 63) === 63 && performance.now() - sliceStart >= 8) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (signal?.aborted) return null;
            sliceStart = performance.now();
          }
        }
      }
      return {
        count: offsets.length,
        /** @param {number} index */
        pointAt(index) {
          const offset = offsets[index];
          if (offset === undefined) return null;
          return {
            taskId: tasks[Math.floor(offset / columns.length)].id,
            key: columns[offset % columns.length].key,
          };
        },
        /** @param {import("../src/types").Point | null} point */
        indexOf(point) {
          if (!point) return -1;
          const row = tasks.findIndex((task) => task.id === point.taskId);
          const col = columns.findIndex((column) => column.key === point.key);
          return row < 0 || col < 0
            ? -1
            : offsets.indexOf(row * columns.length + col);
        },
      };
    },
  };
}
