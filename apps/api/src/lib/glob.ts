/** Expands `{a,b}` alternatives (nested too) into separate patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const head = pattern.slice(0, open);
      const tail = pattern.slice(i + 1);
      const cuts = [open, ...commas, i];
      const options = cuts.slice(0, -1).map((start, j) => pattern.slice(start + 1, cuts[j + 1]));
      return options.flatMap((option) => expandBraces(head + option + tail));
    } else if (c === "," && depth === 1) commas.push(i);
  }
  return [pattern]; // unbalanced: treat literally
}

function toRegExpSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      // "**/" matches zero or more directories; a trailing "**" matches everything below.
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Matches POSIX relative paths against a glob with `*`, `**`, `?` and `{a,b}` (the subset vercel.json uses). */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  return new RegExp(`^(?:${expandBraces(normalized).map(toRegExpSource).join("|")})$`);
}
