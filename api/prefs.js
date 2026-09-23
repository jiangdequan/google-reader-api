import { json } from '../util.js';

export async function preferences(request, env, user) {
  return json({
    prefs: [{ id: 'lhn-prefs', value: '{"subscriptions":{"ssa":"true"}}' }],
  });
}

export async function streamPreferences(request, env, user) {
  return json({ streamprefs: {} });
}

export async function friends(request, env, user) {
  return json({
    friends: [
      {
        p: '',
        contactId: '-1',
        flags: 1,
        stream: 'user/-/state/com.google/broadcast',
        hasSharedItemsOnProfile: false,
        profileIds: [String(user.id)],
        userIds: [String(user.id)],
        givenName: user.username,
        displayName: user.username,
        n: '',
      },
    ],
  });
}