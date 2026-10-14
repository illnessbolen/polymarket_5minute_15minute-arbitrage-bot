/**
 * Append-only JSONL journal (one file per record type under LOG_DIR).
 */

import * as fs from "fs";
import * as path from "path";
import { logError } from "../utils/logger";

export type JournalKind = "opportunities" | "trades" | "windows" | "events";

export class Journal {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  write(kind: JournalKind, record: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.promises.appendFile(path.join(this.dir, `${kind}.jsonl`), line).catch((err) => {
      logError(`Failed to write ${kind} journal:`, err);
    });
  }

  static read(dir: string, kind: JournalKind): Array<Record<string, unknown>> {
    const file = path.join(dir, `${kind}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
