import { propertiesFor, value } from "../domain.js";

// A data export uses the sheet's property names and values, without the
// document, style and identity dictionaries needed by the archive format.
export function taskDataRows(tasks, keys, users, settings) {
  const properties = new Map(propertiesFor(settings).map((p) => [p.id, p])),
    names = new Map(users.map((user) => [user.id, user.name])),
    columns = keys.flatMap((key) => {
      const property = properties.get(key);
      if (!property) return [];
      const options = new Map(
        (property.values || []).map((option) => [option.id, option.label]),
      );
      return [{ property, options }];
    });
  return tasks.map((task) =>
    Object.fromEntries(
      columns.map(({ property, options }) => {
        const stored = value(task, property.id);
        let result = stored === "" || stored == null ? null : stored;
        if (property.kind === "member") {
          const name = (id) => names.get(id) || id;
          result = Array.isArray(stored)
            ? stored.map(name)
            : property.multiple
              ? stored
                ? [name(stored)]
                : []
              : result === null
                ? null
                : name(stored);
        } else if (property.kind === "option") {
          result = options.get(stored) ?? result;
        }
        return [property.name, result];
      }),
    ),
  );
}
