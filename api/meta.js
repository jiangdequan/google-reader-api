import { issueToken } from '../auth.js';
import { json, text } from '../util.js';

export async function info(env, request) {
  const out = {
    service: 'Self-hosted Google Reader API (Cloudflare Worker)',
    endpoints: [
      '/accounts/ClientLogin',
      '/reader/api/0/auth-token',
      '/reader/api/0/user-info',
      '/reader/api/0/subscription/list',
      '/reader/api/0/subscription/quickadd',
      '/reader/api/0/subscription/edit',
      '/reader/api/0/tag/list',
      '/reader/api/0/edit-tag',
      '/reader/api/0/mark-all-as-read',
      '/reader/api/0/unread-count',
      '/reader/api/0/stream/contents/{stream}',
      '/reader/api/0/stream/items/ids',
      '/reader/api/0/stream/items/contents',
      '/reader/api/0/stream/items/count',
      '/reader/api/0/rename-tag',
      '/reader/api/0/disable-tag',
      '/reader/api/0/preference/list',
      '/reader/api/0/friend/list',
      '/reader/api/0/search/items/ids',
      '/reader/subscriptions/export',
      '/reader/subscriptions/import',
    ],
    auth: 'HTTP Basic (username:password), GoogleLogin auth=<token>, or ?auth=<token> / ?T=<token>',
  };
  return json(out);
}

export async function authToken(request, env, user) {
  return text(await issueToken(env, user.id));
}

export async function userInfo(request, env, user) {
  return json({
    userId: String(user.id),
    userName: user.username,
    userProfileId: String(user.id),
    userEmail: user.username,
    isBloggerUser: false,
    signupTimeSec: String(user.created_at || 0),
    isMultiLoginEnabled: true,
  });
}