// Inbox.js: the shape `omapager.inbox` promises, and the events' alphabet.
const assert = require('node:assert/strict'), load = require('./js-loader.cjs');
const I = load('Inbox');
// Objects made in the loader's context have its prototypes: compare as JSON.
const plain = x => JSON.parse(JSON.stringify(x));

// popups: two modes; anything else is "all", the old behaviour.
assert.equal(I.popupsMode('critical'), 'critical');
assert.equal(I.popupsMode(' CRITICAL '), 'critical');
for (const v of ['', 'none', undefined, null, 'off']) assert.equal(I.popupsMode(v), 'all');
assert.equal(I.popsUp('all', 1), true);
assert.equal(I.popsUp('critical', 1), false);
assert.equal(I.popsUp('critical', 0), false);
assert.equal(I.popsUp('critical', 2), true, 'critical always gets its card');

// Events: one line, a closed alphabet, no text.
assert.equal(I.eventLine('ready'), 'omapager>>ready');
assert.equal(I.eventLine('changed'), 'omapager>>changed');
assert.equal(I.eventLine('arrived', 'nk3j9a1'), 'omapager>>arrived,nk3j9a1');
assert.equal(I.eventLine('left', 'nk3j9a1', 'dismissed'), 'omapager>>left,nk3j9a1,dismissed');
assert.equal(I.eventLine('left', 'nk3j9a1', 'whatever'), 'omapager>>left,nk3j9a1,closed');
for (const bad of ['', 'a"b', 'a,b', 'a)b', 'x'.repeat(65), 'a\nb', '../x'])
  assert.equal(I.eventLine('arrived', bad), '', JSON.stringify(bad));
assert.equal(I.eventLine('exploded', 'n1'), '');
assert.equal(I.dispatchFor('omapager>>ready'), 'hl.dsp.event("omapager>>ready")');
assert.equal(I.dispatchFor(''), '');

// One entry: bounded text, actions with ids only, where it is.
const row = { key: 'n1', app: 'Chrome', source: 'web.whatsapp.com', groupKey: 'web.whatsapp.com',
  summary: 'Ana', bodyLine: 'are we still on?', ts: 100, urgency: 1, replyPath: '/org/kde/x', replyTo: 'Ana' };
const e = I.entry(row, [{ id: 'reply', text: 'Reply' }, { id: '', text: 'nothing' }, null], 'kept');
assert.deepEqual(plain(e), { key: 'n1', group: 'web.whatsapp.com', app: 'Chrome', source: 'web.whatsapp.com',
  summary: 'Ana', body: 'are we still on?', at: 100, urgency: 1, place: 'kept', restored: false,
  repliable: true, replyTo: 'Ana', actions: [{ id: 'reply', text: 'Reply' }] });
assert.equal(I.entry({ key: 'n2' }, [], 'anything').place, 'screen');
assert.equal(I.entry({ key: 'n3', bodyLine: 'x'.repeat(5000) }, []).body.length, 1000);
assert.equal(I.entry({ key: 'n4', app: 'notify-send' }, []).group, 'notify-send', 'no group key: the app');

// Groups: by source, newest first inside and across; the newest names it.
const entries = [
  I.entry({ key: 'a', groupKey: 'wa', source: 'WhatsApp', ts: 10 }, []),
  I.entry({ key: 'b', groupKey: 'gh', source: 'GitHub', ts: 30 }, []),
  I.entry({ key: 'c', groupKey: 'wa', source: 'WhatsApp · Ana', ts: 20 }, []),
];
const groups = I.groups(entries, g => (g === 'wa' ? 999 : 0));
assert.deepEqual(plain(groups).map(g => g.key), ['gh', 'wa']);
assert.deepEqual(plain(groups[1].items).map(i => i.key), ['c', 'a']);
assert.equal(groups[1].label, 'WhatsApp · Ana');
assert.equal(groups[1].count, 2);
assert.equal(groups[1].at, 20);
assert.equal(groups[1].snoozedUntil, 999);
assert.equal(groups[0].snoozedUntil, 0);
assert.deepEqual(plain(I.groups([], null)), []);

// The listing.
const l = I.listing({ popups: 'critical', dnd: true, entries, sharingActive: true, sharingOfferPending: true });
assert.equal(l.schema, 1);
assert.equal(l.popups, 'critical');
assert.equal(l.dnd, true);
assert.deepEqual(plain(l.sharing), { active: true, offer: true, minutes: [30, 60, 240] });
assert.equal(l.groups.length, 2);
assert.deepEqual(plain(I.listing(null).groups), []);

// The sharing offer's choices.
assert.equal(I.sharingSeconds('30'), 1800);
assert.equal(I.sharingSeconds('240'), 14400);
assert.equal(I.sharingSeconds('dismiss'), -1);
assert.equal(I.sharingSeconds('45'), 0);
assert.equal(I.sharingSeconds(''), 0);

// Snoozing a source: the user's choices go out in `list`, and come back as
// `snooze <group> <choice>`: minutes, or "tomorrow"; nothing else.
assert.deepEqual(plain(l.snooze), { choices: ['30', '60', '240', 'tomorrow'], wakeHour: 8 }, 'the defaults');
assert.deepEqual(plain(I.listing({ snoozeChoices: ['15', 'tomorrow', '15', 'soon', '-5', 0], wakeHour: 7 }).snooze),
  { choices: ['15', 'tomorrow'], wakeHour: 7 }, 'cleaned, in order, once each');
assert.equal(I.listing({ wakeHour: 0 }).snooze.wakeHour, 0, 'midnight is an hour, not a missing one');
assert.deepEqual(plain(I.listing({ snoozeChoices: ['never'] }).snooze.choices), ['30', '60', '240', 'tomorrow'],
  'none left: the defaults, never an empty menu');
for (const [v, want] of [['tomorrow', 'tomorrow'], [' Tomorrow ', 'tomorrow'], ['30', '30'], [45, '45'],
  ['060', '60'], ['0', ''], ['-30', ''], ['1.5', ''], ['30m', ''], ['', ''], [null, ''], ['99999', '']])
  assert.equal(I.snoozeChoice(v), want, JSON.stringify(v));
for (const [v, want] of [[undefined, 8], [null, 8], ['', 8], [0, 0], ['0', 0], ['soon', 8], [NaN, 8], [23, 23], [24, 8], [-1, 8], ['9', 9], [7.9, 7]])
  assert.equal(I.wakeHour(v), want, JSON.stringify(v));

// The override's lease: written for a mode, found by a start while it runs,
// renewed by a listing once it is half spent.
assert.equal(I.LEASE_SECONDS, 90);
assert.deepEqual(plain(I.lease('critical', 1000.7)), { mode: 'critical', until: 1090 });
assert.deepEqual(plain(I.lease(' ALL ', 1000)), { mode: 'all', until: 1090 });
for (const m of ['default', '', null, undefined, 'none'])
  assert.equal(I.lease(m, 1000), null, 'no lease for ' + JSON.stringify(m));
assert.equal(I.lease('critical', NaN), null);
const found = I.leaseFound('{"mode":"critical","until":1090}', 1000);
assert.deepEqual(plain(found), { mode: 'critical', until: 1090 });
assert.deepEqual(plain(I.leaseFound({ mode: 'all', until: 1001 }, 1000)), { mode: 'all', until: 1001 }, 'an object too');
for (const [v, why] of [
  ['{"mode":"critical","until":1000}', 'ran out at now'],
  ['{"mode":"critical","until":900}', 'ran out'],
  ['{"mode":"critical","until":1091}', 'further away than a lease lasts'],
  ['{"mode":"CRITICAL","until":1050}', 'written by us, so exact'],
  ['{"mode":"none","until":1050}', 'not a mode'],
  ['{"mode":"critical"}', 'no end'],
  ['{"mode":"critical","until":"soon"}', 'no end'],
  ['{}', 'empty'], ['', 'nothing'], ['null', 'null'], ['not json', 'not json'], ['[1]', 'not an object'],
  [null, 'nothing'],
]) assert.equal(I.leaseFound(v, 1000), null, why);
assert.equal(I.leaseFound('{"mode":"critical","until":1090}', NaN), null, 'no clock, no lease');
assert.equal(I.leaseDue(0, 1000), true, 'none written');
assert.equal(I.leaseDue(1090, 1000), false, 'just written');
assert.equal(I.leaseDue(1090, 1030), false, '30 s on: a listing every 30 s writes it every other time');
assert.equal(I.leaseDue(1090, 1045), true, 'half spent');
assert.equal(I.leaseDue(1090, 2000), true, 'ran out');

console.log('inbox: passed');
