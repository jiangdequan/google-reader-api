import { parseXML, attr, localName } from './xml.js';
import { escapeAttr, escapeHtml } from './util.js';

export function buildOpml(title, groups) {
  let body = '';
  for (const g of groups) {
    const feeds = (g.feeds || []).map(
      (f) =>
        `    <outline type="rss" text="${escapeAttr(f.title)}" title="${escapeAttr(f.title)}" xmlUrl="${escapeAttr(f.xmlUrl)}"${f.htmlUrl ? ` htmlUrl="${escapeAttr(f.htmlUrl)}"` : ''}/>`,
    );
    if (feeds.length === 0) continue;
    if (g.name) {
      body += `  <outline text="${escapeAttr(g.name)}" title="${escapeAttr(g.name)}">\n${feeds.join('\n')}\n  </outline>\n`;
    } else {
      body += feeds.join('\n') + '\n';
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>${escapeHtml(title)}</title></head>
  <body>
${body.trim()}
  </body>
</opml>
`;
}

export function parseOpml(body) {
  const root = parseXML(body);
  const out = [];
  const walk = (node, group) => {
    if (!node) return;
    for (const c of node.children || []) {
      if (c.t) continue;
      if (localName(c.name) === 'outline') {
        const xmlUrl = attr(c, 'xmlUrl');
        const t = attr(c, 'text') || attr(c, 'title') || '';
        if (xmlUrl) {
          out.push({ title: t, xmlUrl, htmlUrl: attr(c, 'htmlUrl') || '', group });
        } else {
          walk(c, t || group);
        }
      } else {
        walk(c, group);
      }
    }
  };
  walk(root, null);
  return out;
}