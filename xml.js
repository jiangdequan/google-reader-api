import { escapeAttr, escapeHtml } from './util.js';

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function localName(name) {
  const i = String(name).indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * Minimal, dependency-free XML parser producing a light DOM:
 * node = { name, attrs, children: [node | {t:true,text}], text }
 * `name` keeps the original qualified name; use localName() when matching.
 */
export function parseXML(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  let i = 0;
  const len = input.length;
  let root = null;
  const stack = [];

  const decodeEntities = (s) =>
    s.replace(
      /&#x([0-9a-fA-F]+);|&#(\d+);|&lt;|&gt;|&quot;|&apos;|&nbsp;|&amp;/g,
      (m, h, d) => {
        if (h) return String.fromCodePoint(parseInt(h, 16));
        if (d) return String.fromCodePoint(parseInt(d, 10));
        switch (m) {
          case '&lt;':
            return '<';
          case '&gt;':
            return '>';
          case '&quot;':
            return '"';
          case '&apos;':
            return "'";
          case '&nbsp;':
            return '\u00a0';
          case '&amp;':
            return '&';
        }
        return m;
      },
    );

  const addText = (raw) => {
    const t = decodeEntities(raw);
    if (!t) return;
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push({ t: true, text: t });
      parent.text = (parent.text || '') + t;
    }
  };

  const parseTag = (src) => {
    const tag = { name: '', attrs: {} };
    let j = 1;
    while (j < src.length && !/[\s/>]/.test(src[j])) j++;
    tag.name = src.slice(1, j);
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/g;
    let m;
    let rest = src.slice(j);
    for (m = attrRe.exec(rest); m !== null; m = attrRe.exec(rest)) {
      if (m[1] && m[1] !== '/') {
        tag.attrs[decodeEntities(m[1])] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
      }
    }
    return tag;
  };

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      addText(input.slice(i));
      break;
    }
    if (lt > i) addText(input.slice(i, lt));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      const raw = end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      addText(raw);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const end = input.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (input[lt + 1] === '/') {
      const gt = input.indexOf('>', lt);
      const name = input.slice(lt + 2, gt).trim();
      i = gt + 1;
      const top = stack[stack.length - 1];
      if (top && localName(top.name) === localName(name)) {
        stack.pop();
        if (stack.length === 0) root = top;
      }
      continue;
    }

    const gt = input.indexOf('>', lt);
    if (gt === -1) {
      addText(input.slice(lt));
      break;
    }
    const src = input.slice(lt, gt + 1);
    i = gt + 1;
    const tag = parseTag(src);
    if (!tag.name) continue;
    const node = { name: tag.name, attrs: tag.attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;

    const selfClosing = src.endsWith('/>') || src.endsWith('/ >');
    if (!selfClosing) stack.push(node);
  }
  return root || (stack.length ? stack[0] : null);
}

export function childrenOf(node, name) {
  if (!node || !node.children) return [];
  const ln = localName(name);
  return node.children.filter((c) => !c.t && localName(c.name) === ln);
}

export function firstOf(node, name) {
  return childrenOf(node, name)[0];
}

export function childText(node, name) {
  const el = firstOf(node, name);
  return el ? ((el.text || '').trim() || '') : '';
}

export function attr(node, name) {
  if (!node || !node.attrs) return undefined;
  if (name in node.attrs) return node.attrs[name];
  const ln = localName(name);
  for (const k of Object.keys(node.attrs)) {
    if (localName(k) === ln) return node.attrs[k];
  }
  return undefined;
}

export function serializeHtml(node) {
  if (!node) return '';
  if (node.t) return escapeHtml(node.text || '');
  let out = '<' + node.name;
  for (const k of Object.keys(node.attrs || {})) {
    out += ' ' + k + '="' + escapeAttr(node.attrs[k]) + '"';
  }
  if (node.children && node.children.length) {
    out += '>';
    for (const c of node.children) out += serializeHtml(c);
    out += '</' + node.name + '>';
  } else if (VOID.has(node.name)) {
    out += '>';
  } else {
    out += '></' + node.name + '>';
  }
  return out;
}