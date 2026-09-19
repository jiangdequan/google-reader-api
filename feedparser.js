import {
  parseXML,
  childrenOf,
  firstOf,
  childText,
  attr,
  localName,
  serializeHtml,
} from './xml.js';
import { parseDate } from './util.js';

export function parseFeed(body, contentType) {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || (contentType || '').includes('json')) {
    return parseJsonFeed(trimmed);
  }
  const root = parseXML(trimmed);
  if (!root) return null;
  const ln = localName(root.name);
  if (ln === 'feed') return parseAtom(root);
  if (ln === 'rss') return parseRss2(root);
  if (ln === 'RDF' || ln === 'rdf') return parseRss1(root);
  return null;
}

function parseAtom(root) {
  const title = childText(root, 'title');
  let htmlUrl = '';
  const links = childrenOf(root, 'link');
  for (const l of links) {
    const rel = attr(l, 'rel') || 'alternate';
    const type = attr(l, 'type') || '';
    if (rel === 'alternate' && (!type || type.startsWith('text/html'))) {
      htmlUrl = attr(l, 'href') || '';
      break;
    }
  }
  if (!htmlUrl && links.length) htmlUrl = attr(links[0], 'href') || '';

  const items = childrenOf(root, 'entry').map((entry) => {
    const id = childText(entry, 'id');
    let url = '';
    for (const l of childrenOf(entry, 'link')) {
      const rel = attr(l, 'rel');
      if (!rel || rel === 'alternate') url = attr(l, 'href') || url;
    }
    const contentNode = firstOf(entry, 'content');
    const summaryNode = firstOf(entry, 'summary');
    let content = '';
    if (contentNode) {
      const type = attr(contentNode, 'type') || 'html';
      if (type === 'xhtml') {
        content = (contentNode.children || []).map(serializeHtml).join('');
      } else {
        content = (contentNode.text || '').trim();
        if (!content && contentNode.children && contentNode.children.length) {
          content = contentNode.children.map(serializeHtml).join('');
        }
      }
    } else if (summaryNode) {
      content =
        (summaryNode.children && summaryNode.children.length
          ? summaryNode.children.map(serializeHtml).join('')
          : (summaryNode.text || '').trim()) || '';
    }

    let enclosure = '';
    for (const l of childrenOf(entry, 'link')) {
      if ((attr(l, 'rel') || '') === 'enclosure') {
        enclosure = attr(l, 'href') || '';
        break;
      }
    }

    const authorName = firstOf(firstOf(entry, 'author'), 'name');
    const published = parseDate(
      childText(entry, 'published') || childText(entry, 'issued') || childText(entry, 'updated'),
    );
    const updated = parseDate(childText(entry, 'updated') || childText(entry, 'modified'));

    return {
      guid: id || url,
      url,
      title: childText(entry, 'title'),
      author: authorName ? (authorName.text || '').trim() : '',
      content,
      enclosure,
      published,
      updated: updated || published,
    };
  }).filter((it) => it.guid || it.url);

  return {
    type: 'atom',
    title,
    htmlUrl,
    description: childText(root, 'subtitle'),
    items,
  };
}

function parseRss2(root) {
  const channel = firstOf(root, 'channel');
  const title = childText(channel, 'title');
  const htmlUrl = childText(channel, 'link');
  const description = childText(channel, 'description');
  const items = childrenOf(channel, 'item').map(itemToRssItem).filter(Boolean);
  return { type: 'rss', title, htmlUrl, description, items };
}

function parseRss1(root) {
  const channel = firstOf(root, 'channel');
  const title = childText(channel, 'title');
  const htmlUrl = childText(channel, 'link');
  const description = childText(channel, 'description');
  const items = childrenOf(root, 'item').map(itemToRssItem).filter(Boolean);
  return { type: 'rss1', title, htmlUrl, description, items };
}

function itemToRssItem(item) {
  const guidEl = firstOf(item, 'guid');
  const guid = guidEl ? (guidEl.text || '').trim() : '';
  const link = childText(item, 'link');
  const encoded = childText(item, 'encoded');
  const desc = childText(item, 'description');
  const content = encoded || desc || '';
  let enclosure = '';
  const enc = firstOf(item, 'enclosure');
  if (enc) enclosure = attr(enc, 'url') || '';
  const published =
    parseDate(childText(item, 'pubDate')) || parseDate(childText(item, 'date'));
  return {
    guid: guid || link,
    url: link,
    title: childText(item, 'title'),
    author: childText(item, 'creator') || childText(item, 'author'),
    content,
    enclosure,
    published,
    updated: published,
  };
}

function parseJsonFeed(body) {
  try {
    const j = JSON.parse(body);
    const items = (j.items || [])
      .map((it) => {
        const att = it.attachments && it.attachments[0] ? it.attachments[0] : null;
        return {
          guid: it.id || it.url,
          url: it.url || '',
          title: it.title || '',
          author: it.author && (it.author.name || it.author.url || '') ? it.author.name || it.author.url || '' : (it.author && typeof it.author === 'string' ? it.author : ''),
          content: it.content_html || it.content_text || it.summary || '',
          enclosure: att ? att.url : '',
          published: parseDate(it.date_published) || parseDate(it.date_modified),
          updated: parseDate(it.date_modified) || parseDate(it.date_published),
        };
      })
      .filter((it) => it.guid || it.url);
    return {
      type: 'json',
      title: j.title || j.feed_url || '',
      htmlUrl: j.home_page_url || '',
      description: j.description || '',
      items,
    };
  } catch (e) {
    return null;
  }
}