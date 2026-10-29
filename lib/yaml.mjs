// Part of tug. `tug init` copies this file into .agents/tug/; edit it in the tug repo, not there.
// A small YAML reader for the plain files tug deals with (.agents/config.yml, .mergify.yml): block maps, block
// lists (of scalars or maps), plain/quoted scalars, `[]`/`{}` and simple flow lists of scalars, comments.
// Anything else (anchors, block scalars, multi-document) throws, so a format tug cannot read fails loudly.

/** Cut a trailing comment: `#` at the start or after whitespace, outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (c === '\\' && quote === '"') i++;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,-]/.test(line[i - 1]))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function unquote(v) {
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`yaml: unterminated string ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (!v.endsWith('"') || v.length < 2) throw new Error(`yaml: unterminated string ${v}`);
  return JSON.parse(v);
}

/** One scalar (or flow collection of scalars). */
export function scalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  if (v === '[]') return [];
  if (v === '{}') return {};
  if (v.startsWith('"') || v.startsWith("'")) return unquote(v);
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).map(scalar);
  if (/^[|>][-+]?$/.test(v)) throw new Error('yaml: block scalars (| or >) are not supported here');
  if (/^[&*!]/.test(v)) throw new Error(`yaml: anchors, aliases and tags are not supported: ${v}`);
  if (v.startsWith('{')) throw new Error(`yaml: flow maps are not supported: ${v}`);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function splitFlow(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') throw new Error('yaml: nested flow collections are not supported');
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.filter(x => x.trim() !== '');
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{}&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*)|)$/;
const isItem = text => text === '-' || text.startsWith('- ');

function splitKey(text, lineNo) {
  const m = KEY.exec(text);
  if (!m) throw new Error(`yaml: line ${lineNo}: expected "key: value", got: ${text}`);
  const key = m[1].startsWith('"') || m[1].startsWith("'") ? unquote(m[1]) : m[1];
  return { key, rest: (m[2] ?? '').trim() };
}

export function parseYaml(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, n) => {
    if (/^\s*---\s*$/.test(raw) && lines.length) throw new Error('yaml: multiple documents are not supported');
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) return;
    const s = stripComment(raw);
    if (!s.trim()) return;
    const indentText = /^[ \t]*/.exec(s)[0];
    if (indentText.includes('\t')) throw new Error(`yaml: line ${n + 1}: tabs in indentation`);
    lines.push({ indent: indentText.length, text: s.trim(), n: n + 1 });
  });
  let i = 0;

  function block() {
    const line = lines[i];
    return isItem(line.text) ? list(line.indent) : map(line.indent);
  }

  function value(rest, indent) {
    if (rest !== '') return scalar(rest);
    const next = lines[i];
    if (next && (next.indent > indent || (next.indent === indent && isItem(next.text)))) return block();
    return null;
  }

  function map(indent) {
    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent || (line.indent === indent && isItem(line.text))) break;
      if (line.indent > indent) throw new Error(`yaml: line ${line.n}: unexpected indentation`);
      const { key, rest } = splitKey(line.text, line.n);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`yaml: line ${line.n}: duplicate key ${key}`);
      i++;
      out[key] = value(rest, indent);
    }
    return out;
  }

  function list(indent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent !== indent || !isItem(line.text)) {
        if (line.indent > indent) throw new Error(`yaml: line ${line.n}: unexpected indentation`);
        break;
      }
      const body = line.text === '-' ? '' : line.text.slice(2).trim();
      if (body === '') {
        i++;
        out.push(lines[i] && lines[i].indent > indent ? block() : null);
      } else if (KEY.test(body) && !/^["']/.test(body.trim()) || /^["'][^"']*["']\s*:(\s|$)/.test(body)) {
        // A map item: its first key sits after "- "; the rest of its keys line up with it.
        lines[i] = { indent: indent + (line.text.length - body.length), text: body, n: line.n };
        out.push(map(lines[i].indent));
      } else {
        out.push(scalar(body));
        i++;
      }
    }
    return out;
  }

  if (!lines.length) return {};
  const result = block();
  if (i < lines.length) throw new Error(`yaml: line ${lines[i].n}: could not read past here`);
  return result;
}

/** A scalar as YAML text: plain when that reads back the same, double-quoted otherwise. */
export function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s !== '' && s.trim() === s && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/: |\s#|:$/.test(s) && !/[\r\n\t]/.test(s)) {
    try {
      if (scalar(s) === s) return s;
    } catch { /* fall through to quoting */ }
  }
  return JSON.stringify(s);
}
