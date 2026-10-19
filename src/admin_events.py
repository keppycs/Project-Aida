"""Bounded, in-memory job state with an independent feed for each Studio tab."""
from collections import deque
from copy import deepcopy
import queue
from threading import RLock


class JobEvents:
    def __init__(self):
        self._lock = RLock()
        self._clients = set()
        self._jobs = {channel: self._empty() for channel in ("encode", "maint")}

    @staticmethod
    def _empty():
        return {"start": None, "progress": {}, "logs": deque(maxlen=200), "result": None, "done": None}

    def _snapshot(self):
        events = []
        for job in self._jobs.values():
            events.extend(event for event in [job["start"], *job["progress"].values(), *job["logs"], job["result"], job["done"]] if event)
        return {"type": "job_snapshot", "events": deepcopy(events)}

    def subscribe(self):
        with self._lock:
            client = queue.Queue(maxsize=512)
            client.put_nowait(self._snapshot())
            self._clients.add(client)
            return client

    def unsubscribe(self, client):
        with self._lock:
            self._clients.discard(client)

    def publish(self, event):
        event = deepcopy(event)
        kind = event.get("type", "")
        channel = event.get("channel") or ("encode" if kind.startswith("encode_") else "maint")
        with self._lock:
            if channel in self._jobs:
                if kind.endswith("_start"):
                    self._jobs[channel] = self._empty()
                    self._jobs[channel]["start"] = event
                job = self._jobs[channel]
                if kind == "progress":
                    job["progress"][event.get("stage") or event.get("phase") or "current"] = event
                elif kind == "log":
                    job["logs"].append(event)
                elif kind in ("dedupe_result", "sync_result"):
                    job["result"] = event
                elif kind.endswith("_done"):
                    job["done"] = event
            for client in self._clients:
                try:
                    client.put_nowait(deepcopy(event))
                except queue.Full:
                    # A slow tab catches up to real state rather than replaying
                    # an unbounded backlog or resetting progress to zero.
                    while True:
                        try:
                            client.get_nowait()
                        except queue.Empty:
                            break
                    client.put_nowait(self._snapshot())
