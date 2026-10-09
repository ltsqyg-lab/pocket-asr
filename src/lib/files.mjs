// A command run as root (sudo node src/main.mjs new-token) in a data directory that belongs to the gateway's own user
// must leave files that user can still read: give them to the directory's owner.

import fs from 'node:fs'

export function matchOwner(file, dir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const st = fs.statSync(dir)
    if (st.uid !== 0) fs.chownSync(file, st.uid, st.gid)
  } catch { /* best effort */ }
}
