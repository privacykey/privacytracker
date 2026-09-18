// Opens <PRIVACYTRACKER_DATA_DIR>/privacy.db the way a server boot does, in
// a process of its own so lib/db.ts runs its open-time repairs against the
// file the test prepared, then settles the WAL and closes so the test reads
// what the open left behind.
import db from "../../lib/db";

db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
