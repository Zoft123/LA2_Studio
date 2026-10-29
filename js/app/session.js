// Unsaved edits survive a reload, crash or power cut: every edited LA2 (and edited texture archive) is kept in the
// browser's IndexedDB under the name of the opened folder, and offered back the next time that folder is opened.
// Each LA2 entry carries a fingerprint of the original file, so an edit is never applied to a different file that
// happens to share the folder and file name.
const DB = 'la2studio', STORE = 'edits';

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  return dbp;
}
const done = rq => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
const range = folder => IDBKeyRange.bound(folder + '\n', folder + '\n￿');

/** FNV-1a over the size and up to 64 KB spread across the file: cheap, and different for different files. */
export function fingerprint(bytes) {
  let h = 0x811c9dc5 ^ bytes.length;
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16) + ':' + bytes.length;
}

/** Stored entries of a folder: [{kind: 'la2' | 'tex', id, bytes, fp, time}]. */
export async function load(folder) {
  try {
    const st = (await db()).transaction(STORE).objectStore(STORE);
    return await done(st.getAll(range(folder)));
  } catch (e) { return []; }
}

/** Make the stored entries of `folder` match the current edits (`la2`: id -> {bytes, fp}; `tex`: path -> bytes). */
export async function sync(folder, la2, tex) {
  try {
    const st = (await db()).transaction(STORE, 'readwrite').objectStore(STORE);
    const keep = new Set(), time = Date.now();
    for (const [id, e] of la2) if (e.bytes) {
      const key = `${folder}\nla2\n${id}`; keep.add(key);
      st.put({ kind: 'la2', id, bytes: e.bytes, fp: e.fp, time }, key);
    }
    for (const [id, bytes] of tex) {
      const key = `${folder}\ntex\n${id}`; keep.add(key);
      st.put({ kind: 'tex', id, bytes, time }, key);
    }
    for (const key of await done(st.getAllKeys(range(folder)))) if (!keep.has(key)) st.delete(key);
  } catch (e) { /* storage unavailable: edits only live in memory */ }
}

export async function clear(folder) {
  try { (await db()).transaction(STORE, 'readwrite').objectStore(STORE).delete(range(folder)); } catch (e) { /* unavailable */ }
}
