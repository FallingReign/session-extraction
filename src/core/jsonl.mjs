/** Streams JSONL files line by line with constant memory, in the order given. */
import fs from 'node:fs';
import readline from 'node:readline';

export async function* streamLines(files) {
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (line.trim()) yield { line, file };
      }
    } finally {
      rl.close();
    }
  }
}

/** Parsed records; unparseable lines are reported through onParseFailure. */
export async function* streamRecords(files, { onParseFailure } = {}) {
  for await (const { line, file } of streamLines(files)) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      onParseFailure?.(file);
      continue;
    }
    yield { rec, line, file };
  }
}
