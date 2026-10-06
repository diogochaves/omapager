// The inbox: what omapager is holding, as something another program can read
// and act on - a console, a status bar, a script. Pure: rows in, plain objects
// out, so the shape the IPC promises can be checked without a daemon.
//
// Two ideas live here.
//
//   popups   "all" draws a card for everything, as omapager always has.
//            "critical" draws only urgency-2 cards; the rest are *kept*:
//            admitted, recorded, actionable, never drawn and never expired,
//            until something dismisses them. It exists for a desktop that
//            shows notifications somewhere else and wants omapager to stay
//            the daemon underneath.
//   events   one-line nudges on Hyprland's event socket when the set changes.
//            They carry a key and a reason, never notification text: the
//            socket is readable by every process in the session, the IPC
//            `list` is where the text is.
.pragma library
.import "Layout.js" as Layout

var SCHEMA = 1

var POPUPS = ["all", "critical"]

function popupsMode(value) {
  var v = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  return POPUPS.indexOf(v) >= 0 ? v : "all"
}

// Whether a row gets a card. Critical always does: it is the one thing that
// is allowed to interrupt, whoever else is showing notifications.
function popsUp(mode, urgency) {
  return popupsMode(mode) === "all" || Number(urgency) === 2
}

// ---- events ----------------------------------------------------------------

var EVENTS = ["ready", "arrived", "left", "changed"]
// Why a notification left: closeToast's reasons, plus the one the sender gives
// by withdrawing it.
var REASONS = ["expired", "dismissed", "activated", "cleared", "snoozed", "closed"]

function safeKey(key) {
  var k = String(key === undefined || key === null ? "" : key)
  return /^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : ""
}

// "omapager>>arrived,n1k2" - or "" for anything that is not one of ours. Every
// part is checked against a closed alphabet, so the line can be pasted into a
// Lua string without escaping.
function eventLine(kind, key, reason) {
  var k = String(kind || "")
  if (EVENTS.indexOf(k) < 0) return ""
  if (k === "ready" || k === "changed") return "omapager>>" + k
  var id = safeKey(key)
  if (!id) return ""
  if (k === "arrived") return "omapager>>arrived," + id
  var why = REASONS.indexOf(String(reason || "")) >= 0 ? String(reason) : "closed"
  return "omapager>>left," + id + "," + why
}

// What `hyprctl dispatch` is handed: Hyprland's Lua dispatcher for a custom
// event, which socket2 delivers as `custom>><line>`.
function dispatchFor(line) {
  return line ? 'hl.dsp.event("' + line + '")' : ""
}

// ---- the listing -----------------------------------------------------------

function text(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max)
}

// One notification as the IPC describes it. `place` is "screen" for a card
// that is drawn, "kept" for one held for someone else to show.
function entry(row, actions, place) {
  var list = []
  for (var i = 0; i < (actions || []).length; i++) {
    var a = actions[i] || {}
    if (a.id) list.push({ id: text(a.id, 256), text: text(a.text, 256) })
  }
  return {
    key: text(row.key, 64),
    group: Layout.groupKeyFor(row),
    app: text(row.app, 256),
    source: text(row.source, 253),
    summary: text(row.summary, 512),
    body: text(row.bodyLine, 1000),
    at: Number(row.ts) || 0,
    urgency: Number(row.urgency) || 0,
    place: place === "kept" ? "kept" : "screen",
    restored: row.restored === true,
    repliable: String(row.replyPath || "") !== "",
    replyTo: text(row.replyTo, 256),
    actions: list
  }
}

// Entries grouped by source, newest first, and the groups newest first.
// `snoozedUntil(groupKey)` says which are asleep (epoch seconds, 0 for awake).
function groups(entries, snoozedUntil) {
  var byKey = Object.create(null), order = []
  for (var i = 0; i < (entries || []).length; i++) {
    var e = entries[i]
    if (!e || !e.key) continue
    var g = byKey[e.group]
    if (!g) {
      g = byKey[e.group] = { key: e.group, label: e.source || e.app || "Notification", app: e.app,
                             count: 0, at: 0, snoozedUntil: 0, items: [] }
      order.push(g)
    }
    g.items.push(e)
    g.count += 1
    if (e.at > g.at) g.at = e.at
  }
  for (var j = 0; j < order.length; j++) {
    order[j].items.sort(function(a, b) { return b.at - a.at })
    // The newest item names the group: a source's label can change between
    // notifications (a renamed chat), and the latest is the one you will see.
    order[j].label = order[j].items[0].source || order[j].items[0].app || "Notification"
    order[j].snoozedUntil = typeof snoozedUntil === "function" ? Number(snoozedUntil(order[j].key)) || 0 : 0
  }
  order.sort(function(a, b) { return b.at - a.at })
  return order
}

// The whole answer to `omapager.inbox list`.
function listing(state) {
  var s = state || {}
  return {
    schema: SCHEMA,
    popups: popupsMode(s.popups),
    dnd: s.dnd === true,
    globalSnoozeUntil: Number(s.globalSnoozeUntil) || 0,
    snoozed: Array.isArray(s.snoozed) ? s.snoozed : [],
    sharing: { active: s.sharingActive === true, offer: s.sharingOfferPending === true,
               minutes: SHARING_MINUTES.slice() },
    snooze: { choices: snoozeChoices(s.snoozeChoices), wakeHour: wakeHour(s.wakeHour) },
    groups: groups(s.entries, s.snoozedUntil)
  }
}

// ---- snoozing a source -----------------------------------------------------
//
// The choices are the widget's `snoozeDurations`: minutes, or the literal
// "tomorrow", which is a time rather than a duration - the wake hour
// (`wakeHour`) of the next day. `list` hands both out, so a program offering
// "snooze" offers the user's own choices, and `snooze <group> <choice>` takes
// any of them back, worked out by the service's snoozeOption against the
// clock at that moment.
var SNOOZE_CHOICES = ["30", "60", "240", "tomorrow"]
var WAKE_HOUR = 8

// One choice as `list` names it - "30", "tomorrow" - or "" for none.
function snoozeChoice(value) {
  var v = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  if (v === "tomorrow") return v
  if (!/^\d{1,5}$/.test(v)) return ""
  var minutes = Number(v)
  return minutes > 0 && minutes <= 10080 ? String(minutes) : ""
}

// The configured choices, cleaned; the defaults when none survive, the way the
// panel never offers an empty menu.
function snoozeChoices(list) {
  var out = []
  for (var i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
    var c = snoozeChoice(list[i])
    if (c && out.indexOf(c) < 0) out.push(c)
  }
  return out.length ? out : SNOOZE_CHOICES.slice()
}

function wakeHour(value) {
  var h = Number(value)
  return isFinite(h) && h >= 0 && h <= 23 && value !== "" && value !== null ? Math.floor(h) : WAKE_HOUR
}

// The screen-sharing offer's choices, as the panel offers them.
var SHARING_MINUTES = [30, 60, 240]

// "30" → 1800; "dismiss" → -1; anything else 0 (refused).
function sharingSeconds(choice) {
  var c = String(choice || "").trim().toLowerCase()
  if (c === "dismiss" || c === "no") return -1
  var minutes = Number(c)
  return SHARING_MINUTES.indexOf(minutes) >= 0 ? minutes * 60 : 0
}
