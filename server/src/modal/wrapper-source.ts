/** Python runner source shared by durable Modal launches. */
export function wrapperSource(controlDir: string, commandPath: string, logCap: number): string {
  return `import json, os, selectors, subprocess, time
ROOT = ${JSON.stringify(controlDir)}
CAP = ${logCap}
STATUS = os.path.join(ROOT, "status.json")

def status(value):
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f)
        f.write("\\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATUS)

DROPPED = {"stdout.log": 0, "stderr.log": 0}

def write_meta(name, size):
    # Logical offset of the retained bytes: the reader appends
    # file[remoteCursor - dropped:] and never has to search for an overlap.
    meta = os.path.join(ROOT, name + ".meta")
    tmp = meta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"dropped": DROPPED[name], "size": size}, f)
    os.replace(tmp, meta)

def append_bounded(name, data):
    file = os.path.join(ROOT, name)
    with open(file, "ab") as f:
        f.write(data)
    size = os.path.getsize(file)
    if size > CAP:
        with open(file, "rb") as f:
            f.seek(-CAP, os.SEEK_END)
            kept = f.read()
        tmp = file + ".tmp"
        with open(tmp, "wb") as f:
            f.write(kept)
        os.replace(tmp, file)
        DROPPED[name] += size - len(kept)
        size = len(kept)
    write_meta(name, size)

os.makedirs(ROOT, exist_ok=True)
for name in ("stdout.log", "stderr.log"):
    open(os.path.join(ROOT, name), "ab").close()
    write_meta(name, os.path.getsize(os.path.join(ROOT, name)))
started = time.time()
status({"state": "running", "startedAt": started})
p = subprocess.Popen(["sh", ${JSON.stringify(commandPath)}], cwd="/workspace",
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ, "stdout.log")
sel.register(p.stderr, selectors.EVENT_READ, "stderr.log")
while sel.get_map():
    for key, _ in sel.select(timeout=0.5):
        data = os.read(key.fileobj.fileno(), 65536)
        if data:
            append_bounded(key.data, data)
        else:
            sel.unregister(key.fileobj)
code = p.wait()
finished = time.time()
status({"state": "finished", "startedAt": started, "finishedAt": finished, "exitCode": code})
`;
}
