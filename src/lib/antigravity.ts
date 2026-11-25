// Local Antigravity usage. The CLI and desktop stores share the same layout.
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DB_FILES = ["", "-wal", "-shm"];

function fileVersion(path: string) {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat && `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function readCopy<T>(path: string, read: (db: DatabaseSync) => T): T | undefined {
  const dir = mkdtempSync(join(tmpdir(), "ccburn-agy-"));
  const copy = join(dir, "snapshot.db");
  try {
    const before = DB_FILES.map((suffix) => fileVersion(path + suffix));
    if (!before[0]) return;
    for (const [i, suffix] of DB_FILES.entries()) {
      if (before[i]) copyFileSync(path + suffix, copy + suffix);
    }
    // A checkpoint or append during the copy can leave the DB and WAL out of sync.
    if (DB_FILES.some((suffix, i) => suffix !== "-shm" && fileVersion(path + suffix) !== before[i])) return;

    // Bun on macOS needs a writable directory and connection to initialize
    // shared memory when a WAL-mode database was closed without sidecars.
    const db: DatabaseSync = process.versions.bun
      ? new (require("bun:sqlite").Database)(copy, { readwrite: true })
      : new (require("node:sqlite").DatabaseSync)(copy);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    // The store may be moving, unreadable or from an unsupported agy version.
    return;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type WireValue = number | Uint8Array;

/** Read the scalar and length-delimited fields of a protobuf, skipping fixed fields. */
function* wireFields(bytes: Uint8Array): Generator<[number, WireValue]> {
  let pos = 0;
  const varint = () => {
    let n = 0;
    for (let shift = 0; shift <= 63 && pos < bytes.length; shift += 7) {
      const b = bytes[pos++]!;
      n += (b & 127) * 2 ** shift;
      if (b < 128) return n;
    }
    throw new Error("invalid protobuf varint");
  };
  while (pos < bytes.length) {
    const tag = varint();
    const field = tag >>> 3;
    if (!field || tag > 0xffffffff) throw new Error("invalid protobuf tag");
    switch (tag & 7) {
      case 0:
        yield [field, varint()];
        break;
      case 2: {
        const len = varint();
        if (len > bytes.length - pos) throw new Error("truncated protobuf field");
        yield [field, bytes.subarray(pos, pos + len)];
        pos += len;
        break;
      }
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      default:
        throw new Error("invalid protobuf wire type");
    }
    if (pos > bytes.length) throw new Error("truncated protobuf field");
  }
}

function message(value: WireValue | undefined) {
  return value instanceof Uint8Array ? new Map(wireFields(value)) : undefined;
}

function integer(value: WireValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface AntigravityUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

interface Call {
  t: number;
  model: string;
  usage: AntigravityUsage;
}

interface Conversation {
  id: string;
  caller: string;
  workspace?: string;
  calls: Call[];
}

function readCalls(db: DatabaseSync): Call[] {
  const names = new Map<number, Set<string>>();
  for (const row of db.prepare("SELECT data FROM gen_metadata").iterate()) {
    if (!(row.data instanceof Uint8Array)) continue;
    // Each generation record's field 1 carries the model enum (3) and API name (19).
    for (const [field, value] of wireFields(row.data)) {
      if (field !== 1) continue;
      const generation = message(value);
      const id = integer(generation?.get(3));
      const name = generation?.get(19);
      if (!id || !(name instanceof Uint8Array)) continue;
      const model = Buffer.from(name).toString("utf8");
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) continue;
      const models = names.get(id) ?? new Set<string>();
      models.add(model);
      names.set(id, models);
    }
  }
  const calls: Call[] = [];
  for (const row of db.prepare("SELECT metadata FROM steps ORDER BY idx").iterate()) {
    const step = row.metadata instanceof Uint8Array ? message(row.metadata) : undefined;
    // agy 1.5.16: matched steps.metadata field 9 to the stream-json usage for
    // Neon and GPT-OSS, including a cached turn. The generation log repeats it.
    const counts = message(step?.get(9));
    if (!counts) continue;
    const id = integer(counts.get(1));
    const input = integer(counts.get(2) ?? 0);
    const output = integer(counts.get(3) ?? 0);
    const cached = integer(counts.get(5) ?? 0);
    const thinking = integer(counts.get(9) ?? 0);
    const finished = message(step?.get(7));
    const seconds = integer(finished?.get(1));
    const nanos = integer(finished?.get(2) ?? 0);
    if (!id || !seconds || nanos === undefined || nanos >= 1e9 ||
        input === undefined || output === undefined || cached === undefined ||
        thinking === undefined || thinking > output || !(input + output + cached)) continue;
    const models = names.get(id);
    calls.push({
      t: seconds * 1000 + nanos / 1e6,
      model: models?.size === 1 ? [...models][0]! : `model #${id}`,
      // agy counts thinking inside output and leaves cached input out of total.
      usage: { input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: cached, total_tokens: input + output },
    });
  }
  return calls;
}

function workspaceOf(value: string): string | undefined {
  try {
    const uris: unknown = JSON.parse(value);
    if (!Array.isArray(uris)) return;
    const uri = uris.find((u) => typeof u === "string" && u.startsWith("file:"));
    if (uri) return fileURLToPath(uri);
  } catch {
    // The conversation has no local workspace.
  }
}

export function readAntigravity(home: string, since: number): Conversation[] {
  const sources = [
    { root: join(home, ".gemini", "antigravity-cli"), caller: "agy" },
    { root: join(home, ".gemini", "antigravity"), caller: "Antigravity" },
  ];
  const candidates: { path: string; id: string; caller: string; workspace?: string; updated: number }[] = [];
  for (const { root, caller } of sources) {
    const dir = join(root, "conversations");
    let files: string[];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".db"));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const workspaces = readCopy(join(root, "conversation_summaries.db"), (db) => {
      const rows = db.prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries").all();
      return new Map(rows.map((r) => [String(r.conversation_id), workspaceOf(String(r.workspace_uris))]));
    });
    for (const file of files) {
      const path = join(dir, file);
      const updated = Math.max(...DB_FILES.slice(0, 2).map((suffix) => statSync(path + suffix, { throwIfNoEntry: false })?.mtimeMs ?? 0));
      if (updated < since) continue;
      const id = file.slice(0, -3);
      candidates.push({ path, id, caller, workspace: workspaces?.get(id), updated });
    }
  }
  const conversations = new Map<string, Conversation>();
  for (const { path, id, caller, workspace } of candidates.sort((a, b) => b.updated - a.updated)) {
    if (conversations.has(id)) continue;
    const calls = readCopy(path, readCalls)?.filter((call) => call.t >= since);
    if (calls?.length) conversations.set(id, { id, caller, workspace, calls });
  }
  return [...conversations.values()];
}
