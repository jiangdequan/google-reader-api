import { ensureSchema } from './db/schema.js';
import { ensureDefaultUsers } from './db/users.js';
import { authenticateRequest, clientLogin } from './auth.js';
import { json, text } from './util.js';
import { runSync } from './sync.js';
import * as api from './api/index.js';

const GREADER = '/reader/api/0';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env);
          await ensureDefaultUsers(env);
          await runSync(env);
        } catch (e) {
          console.error('cron sync error', e);
        }
      })(),
    );
  },

  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const brief = u.pathname + u.search;
    try {
      await ensureSchema(env);
      await ensureDefaultUsers(env);
      const resp = await route(request, env, ctx);
      const size = resp.headers.get('content-length') || '?';
      console.log(`[REQ] ${request.method} ${brief} -> ${resp.status} ${size}B`);
      return resp;
    } catch (e) {
      console.log(`[REQ] ${request.method} ${brief} -> ERR ${(e && e.message) || e}`);
      console.error('handler error', (e && e.stack) || e);
      return json({ error: ((e && e.message) || String(e)).slice(0, 500) }, 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'GET' && (path === '/' || path === '/status' || path === '/health')) {
    return api.info(env, request);
  }

  if (path === '/accounts/ClientLogin' || path === '/accounts/ClientAuth') {
    return clientLogin(request, env, url);
  }

  if (path === '/favicon' || path === '/reader/favicon') {
    return api.favicon(request, env, url);
  }

  const user = await authenticateRequest(request, env, url);
  if (!user) return text('Error=AuthRequired', 401);

  if (path === GREADER + '/token' || path === GREADER + '/auth-token') {
    return api.authToken(request, env, user);
  }
  if (path === '/reader/subscriptions/export' || path === '/reader/export_opml') {
    return api.exportOpml(request, env, user);
  }
  if (path === '/reader/subscriptions/import' || path === '/reader/import_opml') {
    return api.importOpml(request, env, user);
  }
  if (path === '/reader/api/0/sync') {
    ctx.waitUntil(runSync(env).catch((e) => console.error('manual sync', e)));
    return text('OK');
  }

  if (path.startsWith('/reader/atom/')) {
    return api.streamContents(request, env, user);
  }

  if (!path.startsWith(GREADER + '/')) {
    return json({ error: 'not found', path }, 404);
  }

  const rest = path.slice(GREADER.length + 1);
  const seg = rest.split('/').filter(Boolean);

  if (seg[0] === 'stream' && seg[1] === 'contents') {
    return api.streamContents(request, env, user);
  }
  if (seg[0] === 'stream' && seg[1] === 'items' && seg[2] === 'ids') {
    return api.streamItemsIds(request, env, user);
  }
  if (seg[0] === 'stream' && seg[1] === 'items' && seg[2] === 'contents') {
    return api.streamItemsContents(request, env, user);
  }
  if (seg[0] === 'stream' && seg[1] === 'items' && seg[2] === 'count') {
    return api.streamItemsCount(request, env, user);
  }
  if (seg[0] === 'stream' && seg[1] === 'details') {
    return api.streamDetails(request, env, user);
  }

  const key = seg.join('/');
  const map = {
    'user-info': api.userInfo,
    'unread-count': api.unreadCount,
    'subscription/list': api.subscriptionList,
    'subscription/quickadd': api.subscriptionQuickadd,
    'subscription/edit': api.subscriptionEdit,
    'subscription/delete': api.subscriptionEdit,
    'tag/list': api.tagList,
    'rename-tag': api.renameTag,
    'disable-tag': api.disableTag,
    'edit-tag': api.editTag,
    'mark-all-as-read': api.markAllAsRead,
    'preference/list': api.preferences,
    'preference/stream/list': api.streamPreferences,
    'friend/list': api.friends,
    'search/items/ids': api.searchItemsIds,
  };
  const handler = map[key];
  if (handler) return handler(request, env, user);
  return json({ error: 'unknown endpoint', path: '/reader/api/0/' + key }, 404);
}