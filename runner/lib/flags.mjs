/**
 * CLI flag parsing for relay-runner: --key value, --key=value, --bool, positionals.
 */
export function parseFlags(rest) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags[a.slice(2)] = rest[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}
