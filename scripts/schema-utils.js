const BLOCKED_PROVIDER_KEYS = new Set(["$schema", "$defs", "title"]);

function toProviderCompatibleSchema(canonicalSchema) {
  const definitions = canonicalSchema.$defs || {};
  const resolve = (node, stack = []) => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, stack));
    if (!node || typeof node !== "object") return node;
    if (node.$ref) {
      const prefix = "#/$defs/";
      if (!String(node.$ref).startsWith(prefix)) throw new Error(`Unsupported schema reference: ${node.$ref}`);
      const name = String(node.$ref).slice(prefix.length);
      if (!(name in definitions)) throw new Error(`Missing schema definition: ${name}`);
      if (stack.includes(name)) throw new Error(`Recursive schema definition is not supported: ${[...stack, name].join(" -> ")}`);
      return resolve(definitions[name], [...stack, name]);
    }
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => !BLOCKED_PROVIDER_KEYS.has(key))
      .map(([key, value]) => [key, resolve(value, stack)]));
  };
  return resolve(canonicalSchema);
}

function schemaLeafPaths(schema) {
  const paths = [];
  const visit = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      for (const [key, value] of Object.entries(node.properties || {})) visit(value, prefix ? `${prefix}.${key}` : key);
    } else if (node.type === "array") visit(node.items, `${prefix}[]`);
    else paths.push(`${prefix}:${node.type || "unknown"}`);
  };
  visit(schema, "");
  return paths.sort();
}

module.exports = { toProviderCompatibleSchema, schemaLeafPaths };
