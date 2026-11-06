"use strict";
/* Shared job queue + results on disk so Passenger/LiteSpeed multi-process
 * workers all see the same pending tasks and bridge replies.
 *
 * Layout under MUSE_DATA/jobs/:
 *   pending/<id>.json   waiting to be taken by a bridge tab
 *   meta/<id>.json      { taken?, text?, final?, tab?, updated }
 *   busy/<tabId>.json   which task currently owns a tab
 */
const fs = require("fs");
const path = require("path");

function createJobStore(dataDir) {
  const ROOT = path.join(dataDir, "jobs");
  const PENDING = path.join(ROOT, "pending");
  const META = path.join(ROOT, "meta");
  const BUSY = path.join(ROOT, "busy");

  function ensure() {
    fs.mkdirSync(PENDING, { recursive: true });
    fs.mkdirSync(META, { recursive: true });
    fs.mkdirSync(BUSY, { recursive: true });
  }
  ensure();

  function atomicWrite(file, obj) {
    const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    fs.renameSync(tmp, file);
  }

  function safeUnlink(file) {
    try { fs.unlinkSync(file); } catch (_) { /* ok */ }
  }

  function pendingFile(id) { return path.join(PENDING, id + ".json"); }
  function metaFile(id) { return path.join(META, id + ".json"); }
  function busyFile(tabId) {
    const safe = String(tabId).replace(/[^a-zA-Z0-9._:-]/g, "_");
    return path.join(BUSY, safe + ".json");
  }

  function enqueue(task) {
    ensure();
    atomicWrite(pendingFile(task.id), {
      id: task.id,
      text: task.text,
      agent: task.agent || "",
      tab: task.tab || null,
      raw: Boolean(task.raw),
      created: Date.now() / 1000,
    });
  }

  function dropPending(id) {
    safeUnlink(pendingFile(id));
  }

  function listPendingIds() {
    try {
      return fs.readdirSync(PENDING)
        .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
        .map((f) => f.slice(0, -5));
    } catch (_) {
      return [];
    }
  }

  function readPending(id) {
    try {
      return JSON.parse(fs.readFileSync(pendingFile(id), "utf-8"));
    } catch (_) {
      return null;
    }
  }

  /** Atomically claim a pending job. Returns task or null if already taken. */
  function claim(id) {
    const src = pendingFile(id);
    const claimed = path.join(PENDING, id + "." + process.pid + ".claiming");
    try {
      fs.renameSync(src, claimed);
    } catch (_) {
      return null;
    }
    try {
      const task = JSON.parse(fs.readFileSync(claimed, "utf-8"));
      safeUnlink(claimed);
      return task;
    } catch (_) {
      safeUnlink(claimed);
      return null;
    }
  }

  function readMeta(id) {
    try {
      return JSON.parse(fs.readFileSync(metaFile(id), "utf-8"));
    } catch (_) {
      return null;
    }
  }

  function patchMeta(id, patch) {
    ensure();
    const cur = readMeta(id) || { id };
    Object.assign(cur, patch, { updated: Date.now() / 1000 });
    atomicWrite(metaFile(id), cur);
    return cur;
  }

  function setBusy(tabId, taskId) {
    if (!tabId) return;
    ensure();
    atomicWrite(busyFile(tabId), { taskId, at: Date.now() / 1000 });
  }

  function clearBusy(tabId, taskId) {
    if (!tabId) return;
    const f = busyFile(tabId);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (!taskId || cur.taskId === taskId) safeUnlink(f);
    } catch (_) {
      safeUnlink(f);
    }
  }

  function getBusy(tabId, maxAgeSec) {
    if (!tabId) return null;
    try {
      const cur = JSON.parse(fs.readFileSync(busyFile(tabId), "utf-8"));
      if (maxAgeSec && Date.now() / 1000 - (cur.at || 0) > maxAgeSec) {
        safeUnlink(busyFile(tabId));
        return null;
      }
      return cur.taskId || null;
    } catch (_) {
      return null;
    }
  }

  function dropJob(id) {
    dropPending(id);
    safeUnlink(metaFile(id));
  }

  /** Remove job files older than maxAgeSec (default 2h). */
  function cleanup(maxAgeSec) {
    maxAgeSec = maxAgeSec || 7200;
    const cutoff = Date.now() / 1000 - maxAgeSec;
    for (const id of listPendingIds()) {
      const t = readPending(id);
      if (t && (t.created || 0) < cutoff) dropPending(id);
    }
    try {
      for (const f of fs.readdirSync(META)) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(META, f);
        try {
          const m = JSON.parse(fs.readFileSync(p, "utf-8"));
          if ((m.updated || m.taken || 0) < cutoff) safeUnlink(p);
        } catch (_) {
          safeUnlink(p);
        }
      }
    } catch (_) { /* ok */ }
    try {
      for (const f of fs.readdirSync(BUSY)) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(BUSY, f);
        try {
          const m = JSON.parse(fs.readFileSync(p, "utf-8"));
          if ((m.at || 0) < cutoff) safeUnlink(p);
        } catch (_) {
          safeUnlink(p);
        }
      }
    } catch (_) { /* ok */ }
  }

  function wipe() {
    for (const dir of [PENDING, META, BUSY]) {
      try {
        for (const f of fs.readdirSync(dir)) safeUnlink(path.join(dir, f));
      } catch (_) { /* ok */ }
    }
  }

  return {
    enqueue, dropPending, listPendingIds, readPending, claim,
    readMeta, patchMeta, setBusy, clearBusy, getBusy, dropJob, cleanup, wipe,
    ROOT,
  };
}

module.exports = { createJobStore };
