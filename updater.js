// Remote "update now" for venues (EventPhotos 1.3.46+).
//
// Venues are outbound-only, so the command rides back on the heartbeat REPLY:
//   { ok: true, update: { id, target? } }
// The venue runs its own Pull Updates (git pull origin/main → build → restart) once
// per command id; repeats of the same id are ignored there, so we keep sending it
// on every heartbeat until the venue reports the new build, which guarantees
// delivery. The venue always pulls main HEAD: PUSH TO GITHUB FIRST, then update.
//
// Done when the venue's reported `version` reaches `target` (if one was given),
// otherwise when its reported `commit` (or version) changes from what it was when
// the update was issued. If nothing changes within UPDATE_GIVE_UP_MIN (default 30)
// we stop sending and mark it "no change" (usually: the venue was already on HEAD).
//
// While an update is pending the venue's heartbeat gap is expected (the update
// restarts it), so the notifier skips the VENUE OFFLINE text (see quiet()).
// State is in memory: a dashboard restart forgets pending updates.

const crypto = require('crypto');

const MIN_VERSION = process.env.REMOTE_UPDATE_MIN_VERSION || '1.3.46';
const GIVE_UP_MS = (Number(process.env.UPDATE_GIVE_UP_MIN) > 0 ? Number(process.env.UPDATE_GIVE_UP_MIN) : 30) * 60e3;

function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const eligible = (v) => !!(v && v.version && cmpVersion(v.version, MIN_VERSION) >= 0);

// venueKey -> { id, target, venue, state: pending|done|gaveup|cancelled, issuedAt,
//               fromVersion, fromCommit, deliveredAt, endedAt, toVersion, toCommit }
const cmds = new Map();

function issue(vKey, v, target) {
  const t = target ? String(target).trim() : '';
  if (t && !VERSION_RE.test(t)) throw new Error('Target must be a version like 1.3.47 (or blank for "whatever is on main").');
  const cmd = {
    id: 'upd-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    target: t || null, venue: v.venue || vKey, state: 'pending', issuedAt: Date.now(),
    fromVersion: v.version || null, fromCommit: v.commit || null,
    deliveredAt: null, endedAt: null, toVersion: null, toCommit: null,
  };
  cmds.set(vKey, cmd);
  return cmd;
}

function cancel(vKey) {
  const c = cmds.get(vKey);
  if (!c || c.state !== 'pending') return false;
  Object.assign(c, { state: 'cancelled', endedAt: Date.now() });
  return true;
}

const reached = (c, p) => c.target
  ? !!p.version && cmpVersion(p.version, c.target) >= 0
  : (!!p.commit && !!c.fromCommit && p.commit !== c.fromCommit) || (!!p.version && p.version !== c.fromVersion);

// Called on every heartbeat. Returns the `update` field for the reply, or null.
function onHeartbeat(vKey, p, now = Date.now()) {
  const c = cmds.get(vKey);
  if (!c || c.state !== 'pending') return null;
  if (reached(c, p)) {
    Object.assign(c, { state: 'done', endedAt: now, toVersion: p.version || null, toCommit: p.commit || null });
    return null;
  }
  if (c.deliveredAt && now - c.deliveredAt > GIVE_UP_MS) {
    Object.assign(c, { state: 'gaveup', endedAt: now });
    return null;
  }
  if (!c.deliveredAt) c.deliveredAt = now;
  return c.target ? { id: c.id, target: c.target } : { id: c.id };
}

// A pending update explains a heartbeat gap: don't text VENUE OFFLINE for it.
// (Bounded: never delivered → 2× give-up from issue; delivered → give-up window.)
function quiet(vKey, now = Date.now()) {
  const c = cmds.get(vKey);
  if (!c || c.state !== 'pending') return false;
  return c.deliveredAt ? now - c.deliveredAt <= GIVE_UP_MS : now - c.issuedAt <= 2 * GIVE_UP_MS;
}

// For the board. Finished commands stay visible for 2 hours.
function statusFor(vKey, now = Date.now()) {
  const c = cmds.get(vKey);
  if (!c) return null;
  if (c.state !== 'pending' && now - c.endedAt > 2 * 3600e3) return null;
  const { id, target, state, issuedAt, deliveredAt, endedAt, fromVersion, fromCommit, toVersion, toCommit } = c;
  return { id, target, state, issuedAt, deliveredAt, endedAt, fromVersion, fromCommit, toVersion, toCommit };
}

module.exports = { issue, cancel, onHeartbeat, quiet, statusFor, eligible, cmpVersion, MIN_VERSION, GIVE_UP_MS };
