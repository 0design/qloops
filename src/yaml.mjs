/**
 * YAML reader for loop manifests — a documented SUBSET, not a YAML engine.
 *
 * WHY HAND-WRITTEN. The whole point of this package is that `qloops validate` and
 * `qloops run --dry-run` work on a clean machine with nothing installed: unpack the
 * tarball, run it. One dependency turns that into "…after npm install finishes,
 * assuming you have network". A manifest format whose reader needs a package
 * manager is a format with a footnote.
 *
 * WHAT IS SUPPORTED (and SPEC-MANIFEST.md §Syntax says the same, in prose):
 *   • block mappings   key: value, nested by indentation (spaces only)
 *   • block sequences  - item · - key: value
 *   • scalars          plain · 'single' · "double" (\n \t \" \\ \/ escapes)
 *   • block scalars    | and > with the -/+ chomping indicators
 *   • flow collections [a, b] and {a: 1, b: 2}, nested
 *   • scalar types     true/false · null/~ · integers · floats · everything else
 *                      is a string; anything quoted is ALWAYS a string
 *   • comments         # to end of line, outside quotes
 *   • one leading ---
 *
 * WHAT IS REFUSED, LOUDLY (never guessed at):
 *   anchors &a / aliases *a · tags !!str · multiple documents · tab indentation
 *
 * A refusal names the line. Silently mis-reading a manifest is the one failure
 * this file must not have: the loop that results would still run, just not the
 * loop that was written.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line != null ? `line ${line}: ${message}` : message);
    this.name = "YamlError";
    this.line = line ?? null;
  }
}

/* ── lexing helpers ─────────────────────────────────────────────────────── */

/** Strip a trailing `# comment`, honouring quotes. Returns the code part. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

const isBlank = (raw) => stripComment(raw).trim() === "";

function indentOf(raw, lineNo) {
  const m = raw.match(/^[ \t]*/)[0];
  if (m.includes("\t")) {
    throw new YamlError("tab used for indentation — YAML forbids it; use spaces", lineNo);
  }
  return m.length;
}

/* ── scalars ────────────────────────────────────────────────────────────── */

function parseDoubleQuoted(s, lineNo) {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[++i];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "0") out += "\0";
      else if (n === '"' || n === "\\" || n === "/") out += n;
      else throw new YamlError(`unsupported escape \\${n} in a double-quoted string`, lineNo);
      continue;
    }
    if (c === '"') {
      if (i !== s.length - 1) throw new YamlError("trailing text after a double-quoted string", lineNo);
      return out;
    }
    out += c;
  }
  throw new YamlError("unterminated double-quoted string", lineNo);
}

function parseSingleQuoted(s, lineNo) {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      if (i !== s.length - 1) throw new YamlError("trailing text after a single-quoted string", lineNo);
      return out;
    }
    out += s[i];
  }
  throw new YamlError("unterminated single-quoted string", lineNo);
}

/** A plain (unquoted) scalar → its typed value. */
function typedPlain(text, lineNo) {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("&") || t.startsWith("*")) {
    throw new YamlError(
      `anchors and aliases (${t.slice(0, 12)}…) are not supported by this reader — write the value out`,
      lineNo,
    );
  }
  if (t.startsWith("!")) {
    throw new YamlError(`YAML tags (${t.slice(0, 12)}…) are not supported by this reader`, lineNo);
  }
  return t;
}

/** One scalar or flow collection on the right of a `key:` / after a `-`. */
function parseInline(text, lineNo) {
  const t = text.trim();
  if (t === "") return null;
  if (t[0] === '"') return parseDoubleQuoted(t, lineNo);
  if (t[0] === "'") return parseSingleQuoted(t, lineNo);
  if (t[0] === "[" || t[0] === "{") return parseFlow(t, lineNo);
  return typedPlain(t, lineNo);
}

/* ── flow collections: [a, b] / {a: 1} ──────────────────────────────────── */

function parseFlow(src, lineNo) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  function value() {
    ws();
    const c = src[i];
    if (c === "[") return seq();
    if (c === "{") return map();
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\" && q === '"') j += 2;
        else if (src[j] === q && !(q === "'" && src[j + 1] === "'")) break;
        else if (src[j] === q) j += 2;
        else j++;
      }
      if (j >= src.length) throw new YamlError("unterminated quoted string in a flow collection", lineNo);
      const raw = src.slice(i, j + 1);
      i = j + 1;
      return q === '"' ? parseDoubleQuoted(raw, lineNo) : parseSingleQuoted(raw, lineNo);
    }
    const start = i;
    while (i < src.length && !",]}".includes(src[i])) i++;
    return typedPlain(src.slice(start, i), lineNo);
  }

  function seq() {
    const out = [];
    i++; // [
    ws();
    if (src[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(value());
      ws();
      if (src[i] === ",") {
        i++;
        ws();
        if (src[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (src[i] === "]") {
        i++;
        return out;
      }
      throw new YamlError("expected ',' or ']' in a flow sequence", lineNo);
    }
  }

  function map() {
    const out = {};
    i++; // {
    ws();
    if (src[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      const start = i;
      while (i < src.length && src[i] !== ":" && !",}".includes(src[i])) i++;
      if (src[i] !== ":") throw new YamlError("expected ':' in a flow mapping", lineNo);
      const key = src.slice(start, i).trim().replace(/^["']|["']$/g, "");
      i++; // :
      out[key] = value();
      ws();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        return out;
      }
      throw new YamlError("expected ',' or '}' in a flow mapping", lineNo);
    }
  }

  const v = value();
  ws();
  if (i !== src.length) throw new YamlError("trailing text after a flow collection", lineNo);
  return v;
}

/* ── block parser ───────────────────────────────────────────────────────── */

/**
 * @param {string} text
 * @returns {unknown} the document root (a plain object for every real manifest)
 */
export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // One document only. A second --- would mean the file holds two loops and we
  // would have to guess which one was meant.
  let start = 0;
  while (start < lines.length && isBlank(lines[start])) start++;
  if (lines[start]?.trim() === "---") start++;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      throw new YamlError("multiple YAML documents in one file — a manifest holds exactly one loop", i + 1);
    }
  }

  const cursor = { i: start };

  /** Read the body of a `|`/`>` block scalar that started on `headerLine`. */
  function blockScalar(header, parentIndent, headerLine) {
    const fold = header[0] === ">";
    const chomp = /-/.test(header) ? "strip" : /\+/.test(header) ? "keep" : "clip";
    const explicit = header.match(/\d+/);
    const body = [];
    let blockIndent = explicit ? parentIndent + Number(explicit[0]) : null;

    while (cursor.i < lines.length) {
      const raw = lines[cursor.i];
      if (raw.trim() === "") {
        body.push("");
        cursor.i++;
        continue;
      }
      const ind = indentOf(raw, cursor.i + 1);
      if (ind <= parentIndent) break;
      if (blockIndent == null) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(raw.slice(blockIndent));
      cursor.i++;
    }
    if (blockIndent == null) throw new YamlError("block scalar has no body", headerLine);

    while (body.length && body[body.length - 1] === "") body.pop();
    let out;
    if (fold) {
      // Folded: a single newline becomes a space; a blank line stays a break.
      out = body.reduce((acc, l, idx) => {
        if (idx === 0) return l;
        if (l === "" || body[idx - 1] === "") return `${acc}\n${l}`;
        return `${acc} ${l}`;
      }, "");
    } else {
      out = body.join("\n");
    }
    if (chomp === "clip") out += "\n";
    else if (chomp === "keep") out += "\n";
    return out;
  }

  /** Parse a block node (mapping or sequence) at exactly `indent`. */
  function block(indent) {
    // Skip blanks, then decide what kind of node starts here.
    while (cursor.i < lines.length && isBlank(lines[cursor.i])) cursor.i++;
    if (cursor.i >= lines.length) return null;
    const first = stripComment(lines[cursor.i]);
    return first.trimStart().startsWith("- ") || first.trim() === "-" ? sequence(indent) : mapping(indent);
  }

  function sequence(indent) {
    const out = [];
    while (cursor.i < lines.length) {
      const raw = lines[cursor.i];
      if (isBlank(raw)) {
        cursor.i++;
        continue;
      }
      const ind = indentOf(raw, cursor.i + 1);
      if (ind < indent) break;
      const code = stripComment(raw).trimEnd();
      const body = code.slice(ind);
      if (ind > indent) throw new YamlError(`unexpected indentation inside a sequence`, cursor.i + 1);
      if (!body.startsWith("- ") && body !== "-") break;

      const lineNo = cursor.i + 1;
      const rest = body === "-" ? "" : body.slice(2).trim();
      cursor.i++;

      if (rest === "") {
        out.push(block(indent + 2));
        continue;
      }
      // `- key: value` opens a mapping whose columns start at the dash + 2.
      const kv = splitKey(rest, lineNo);
      if (kv) {
        cursor.i--;
        // Re-read this line as the first entry of a nested mapping by pretending
        // the dash is indentation — that is exactly what YAML means by it.
        lines[cursor.i] = " ".repeat(ind + 2) + rest;
        out.push(mapping(ind + 2));
        continue;
      }
      out.push(parseInline(rest, lineNo));
    }
    return out;
  }

  function mapping(indent) {
    const out = {};
    while (cursor.i < lines.length) {
      const raw = lines[cursor.i];
      if (isBlank(raw)) {
        cursor.i++;
        continue;
      }
      const ind = indentOf(raw, cursor.i + 1);
      if (ind < indent) break;
      if (ind > indent) throw new YamlError("unexpected indentation — this key is deeper than its siblings", cursor.i + 1);
      const code = stripComment(raw).trimEnd();
      const body = code.slice(ind);
      if (body.startsWith("- ")) break;

      const lineNo = cursor.i + 1;
      const kv = splitKey(body, lineNo);
      if (!kv) throw new YamlError(`expected "key: value", got: ${body.slice(0, 60)}`, lineNo);
      const { key, rest } = kv;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new YamlError(`duplicate key "${key}" — the later value would silently win`, lineNo);
      }
      cursor.i++;

      if (rest === "") {
        // Value is on the following lines: a nested block, or nothing at all.
        let j = cursor.i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j >= lines.length) {
          out[key] = null;
          continue;
        }
        const childIndent = indentOf(lines[j], j + 1);
        const childIsSeq = stripComment(lines[j]).trimStart().startsWith("- ");
        // A sequence may sit at the parent's own indentation — YAML allows it.
        if (childIndent > indent || (childIsSeq && childIndent === indent)) {
          cursor.i = j;
          out[key] = childIsSeq && childIndent === indent ? sequence(indent) : block(childIndent);
        } else {
          out[key] = null;
        }
        continue;
      }
      if (rest[0] === "|" || rest[0] === ">") {
        out[key] = blockScalar(rest, ind, lineNo);
        continue;
      }
      out[key] = parseInline(rest, lineNo);
    }
    return out;
  }

  /** Split `key: rest`, returning null when the line is not a mapping entry. */
  function splitKey(body, lineNo) {
    let quote = null;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === "[" || c === "{") return null; // a flow collection, not a key
      if (c === ":" && (i + 1 === body.length || /\s/.test(body[i + 1]))) {
        let key = body.slice(0, i).trim();
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
          key = key.slice(1, -1);
        }
        if (key === "") throw new YamlError("empty key", lineNo);
        return { key, rest: body.slice(i + 1).trim() };
      }
    }
    return null;
  }

  const root = block(indentOf(lines[cursor.i] ?? "", cursor.i + 1));
  // Anything left over means we stopped early — a real structural error.
  while (cursor.i < lines.length && isBlank(lines[cursor.i])) cursor.i++;
  if (cursor.i < lines.length) {
    throw new YamlError(`could not read this line as part of the document: ${lines[cursor.i].trim().slice(0, 60)}`, cursor.i + 1);
  }
  return root;
}
