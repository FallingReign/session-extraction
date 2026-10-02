/** Streams JSONL files line by line with constant memory, in the order given. */
import fs from 'node:fs';
import readline from 'node:readline';

/** Read only as many bytes as needed to return a file's first line. */
export function readFirstLine(file, chunkSize = 65536, maxChunks = 16) {
  const fd = fs.openSync(file, 'r');
  try {
    let buf = Buffer.alloc(0);
    let pos = 0;
    for (let i = 0; i < maxChunks; i++) {
      const chunk = Buffer.alloc(chunkSize);
      const read = fs.readSync(fd, chunk, 0, chunkSize, pos);
      if (read === 0) break;
      pos += read;
      buf = Buffer.concat([buf, chunk.subarray(0, read)]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) return buf.subarray(0, nl).toString('utf8');
    }
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

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
